// The `dependency-security` catalog kind (ADR 0003): the hourly detector. It
// shares the sources, the filing and the marker with `dependency-updates` and
// differs only in policy. Every advisory at or over `minSeverity` is filed,
// one issue per package:
//
//   - with a fix released, a routed issue targeting that fix, labelled
//     `dependencies`, `security` and the routing label, which the
//     `dependencies` kind works;
//   - with none, a tracking issue labelled `dependencies` and `security` alone.
//     A pass refreshes it when an advisory comes or goes, and the pass that
//     finds a fix rewrites it and adds the routing label.
//
// No maturity wait, no open cap, no failure record: an advisory over the
// threshold is filed as soon as a pass sees it. The native source here skips
// deps.dev, so a pass costs the rows, one OSV batch and the audits.
//
// It ships in the engine and registers only when a tenant declares it
// (`path: "phoebe-agent/kinds/dependency-security"`). The kind never adds the
// tenant's ready label: a pipeline running `issues` would take the ticket for
// its own.

import type { PhoebeConfig } from "../../src/config-schema.ts";
import { addLabelCreatingIfMissing, type PhoebeLabel } from "../../src/labels.ts";
import {
  defineWorkKind,
  type WorkKindDefinition,
  type WorkKindRunCtx,
} from "../../src/work-kinds/definition.ts";
import {
  applyFiling,
  decideFiling,
  DEPENDENCIES_LABEL,
  readFiled,
  type FilingAction,
} from "../dependencies/filing.ts";
import { everyMs } from "../dependencies/options.ts";
import { DEPENDENCY_DETECT_PROMPT_FILE } from "../dependencies/sources/agent.ts";
import {
  realSources,
  sharedClients,
  type CreateSources,
} from "../dependencies/sources/assemble.ts";
import { runNativeSecuritySource } from "../dependencies/sources/native.ts";
import { isTrackingBody } from "./body.ts";
import { runSources } from "../dependencies/sources/run.ts";
import {
  FIXED_LABELS,
  resolveDependencySecurityOptions,
  type DependencySecurityOptions,
} from "./options.ts";
import { planSecurity } from "./plan.ts";

export const DEPENDENCY_SECURITY_KIND_NAME = "dependency-security";
export const SCAN_REF = `${DEPENDENCY_SECURITY_KIND_NAME}:scan`;

/** The one unit: a scan, its revision the window it falls in. */
export type ScanUnit = { ref: string; revision: string };

export type DependencySecurityGathered = { due: ScanUnit | null };

/** Test seam: the sources behind the kind. */
export type DependencySecurityDeps = { createSources?: CreateSources };

/**
 * Keep the routing label in step with the issue. A tracking issue gains it on
 * the pass its fix appears: the refresh that rewrote its body from a tracking
 * one to a routed one. Only that pass, so a label a person took off later stays
 * off. A routed issue whose refresh leaves it with no fix loses the label, so
 * the `dependencies` kind cannot claim it. A failure is logged for a person to
 * handle by hand, as applyFiling logs one.
 */
function routeFixedIssues(
  actions: readonly FilingAction[],
  issues: ReadonlyMap<number, { body: string; labels: readonly string[] }>,
  routingLabel: PhoebeLabel,
  ctx: Pick<WorkKindRunCtx, "github" | "log">,
): void {
  for (const a of actions) {
    if (a.action !== "update") continue;
    const before = issues.get(a.issue);
    if (before === undefined) continue;
    const routes = a.planned.labels?.some((l) => l.name === routingLabel.name) === true;
    if (!routes) {
      if (!before.labels.includes(routingLabel.name)) continue;
      try {
        ctx.github.removeIssueLabel(a.issue, routingLabel.name);
        ctx.log(`#${a.issue}: no fix is left; took off "${routingLabel.name}".`);
      } catch (error) {
        ctx.log(
          `#${a.issue}: no fix is left but could not remove label "${routingLabel.name}"; remove it by hand. ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    if (!isTrackingBody(before.body)) continue;
    if (before.labels.includes(routingLabel.name)) continue;
    try {
      addLabelCreatingIfMissing(ctx.github, a.issue, routingLabel, (line) => ctx.log(line));
      ctx.log(`#${a.issue}: a fix is out; routed with "${routingLabel.name}".`);
    } catch (error) {
      ctx.log(
        `#${a.issue}: a fix is out but could not add label "${routingLabel.name}"; add it by hand. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function createDependencySecurityKind(
  config: PhoebeConfig,
  options: DependencySecurityOptions,
  deps: DependencySecurityDeps = {},
): WorkKindDefinition<DependencySecurityGathered, ScanUnit> {
  if (FIXED_LABELS.includes(config.readyLabel)) {
    throw new Error(
      `kinds.${DEPENDENCY_SECURITY_KIND_NAME}: the ready label "${config.readyLabel}" is one every ` +
        "security issue wears; a pipeline running `issues` would take tracking tickets for its own.",
    );
  }
  if (options.label === config.readyLabel) {
    throw new Error(
      `kinds.${DEPENDENCY_SECURITY_KIND_NAME}: \`label\` must not be the ready label ` +
        `"${config.readyLabel}"; a pipeline running \`issues\` would take the ticket for its own.`,
    );
  }
  const createSources = deps.createSources ?? realSources(sharedClients(), runNativeSecuritySource);
  const window = everyMs(options.every);
  const routingLabel: PhoebeLabel = {
    name: options.label,
    description: "A dependency bundle for Phoebe to update",
  };
  let lastScanAt: number | null = null;

  return defineWorkKind<DependencySecurityGathered, ScanUnit>({
    name: DEPENDENCY_SECURITY_KIND_NAME,
    oneShotEligible: true,
    promptFile: DEPENDENCY_DETECT_PROMPT_FILE,
    workspace: "readonly",
    unitKey: "none",
    report: {
      noun: "security scan(s)",
      describe: () => `dependency security scan (every ${options.every})`,
    },

    async fetch(ctx) {
      const now = ctx.clock.now().getTime();
      if (lastScanAt !== null && now - lastScanAt < window) return { due: null };
      return { due: { ref: SCAN_REF, revision: String(Math.floor(now / window)) } };
    },

    select(gathered, ctx) {
      const unit = gathered.due;
      if (unit === null) return { unit: null, skipped: [], total: 0 };
      if (ctx.inFlight.has(unit.ref)) {
        return { unit: null, skipped: [{ reason: "in flight", count: 1 }], total: 1 };
      }
      if (ctx.quarantined.has(unit.ref)) {
        return { unit: null, skipped: [{ reason: "quarantined in memory", count: 1 }], total: 1 };
      }
      return { unit, skipped: [], total: 1 };
    },

    async run(_unit, ctx) {
      // Stamped before the sources start, as in dependency-updates: a failed
      // scan waits for the next window too.
      lastScanAt = ctx.clock.now().getTime();

      const sources = await createSources(ctx, options.sources);
      const { candidates, finished } = await runSources(sources, ctx);
      if (finished.length === 0) {
        throw new Error("every dependency source failed; nothing to file this window.");
      }

      const plan = planSecurity(candidates, {
        minSeverity: options.minSeverity,
        routingLabel,
        bootstrapperPin: options.bootstrapperPin,
      });
      const routed = plan.planned.filter((p) => p.routed).length;
      ctx.log(
        `${candidates.length} candidate(s): ${plan.bootstrapper} bootstrapper pin(s) left to ` +
          `\`phoebe upgrade\`, ${plan.below} with advisories under ` +
          `${options.minSeverity} left to dependency-updates; ${routed} package(s) with a fix, ` +
          `${plan.planned.length - routed} awaiting one.`,
      );

      const filed = readFiled(ctx);
      const actions = decideFiling(plan.planned, filed.issues, filed.prs, {
        routingLabel: options.label,
        cap: null,
      });
      applyFiling(actions, ctx, [DEPENDENCIES_LABEL]);
      routeFixedIssues(
        actions,
        new Map(filed.issues.map((issue) => [issue.number, issue])),
        routingLabel,
        ctx,
      );
    },
  });
}

/**
 * The catalog entry point: the loader hands a factory the resolved config and
 * the block's root options. Validation throws here, at registration, so a bad
 * block fails `phoebe pipelines` and the pipeline's boot rather than a scan.
 */
export default function dependencySecurityKind(
  config: PhoebeConfig,
  options: unknown,
): WorkKindDefinition<DependencySecurityGathered, ScanUnit> {
  return createDependencySecurityKind(
    config,
    resolveDependencySecurityOptions(options, `kinds.${DEPENDENCY_SECURITY_KIND_NAME}`),
  );
}
