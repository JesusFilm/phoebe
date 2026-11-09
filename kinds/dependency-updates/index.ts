// The `dependency-updates` catalog kind (ADR 0003): the daily detector. It
// finds what is outdated across every source it is given, applies the
// maturity and grouping policy, and files one issue per bundle under the
// routing label, which the `dependencies` kind works.
//
// It ships in the engine and registers only when a tenant declares it
// (`path: "phoebe-agent/kinds/dependency-updates"`), so it may value-import
// engine helpers where a tenant module could not.
//
// Shape:
//   - `fetch` reads no network. Inside the `every` window since the last scan
//     it yields nothing; past it, one synthetic unit, `dependency-updates:scan`.
//     The window lives in memory, so a boot scans again, and the watermark in
//     GitHub keeps that scan from filing anything twice;
//   - `run` starts the sources at once, each under its own deadline, and files
//     from whatever finished;
//   - filing reads the marker back from GitHub (kinds/dependencies/filing.ts).
//     The kind never adds the tenant's ready label: a pipeline running
//     `issues` would take the ticket for its own.

import type { PhoebeConfig } from "../../src/config-schema.ts";
import type { PhoebeLabel } from "../../src/labels.ts";
import { defineWorkKind, type WorkKindDefinition } from "../../src/work-kinds/definition.ts";
import {
  applyFiling,
  decideFiling,
  DEPENDENCIES_LABEL,
  readFiled,
} from "../dependencies/filing.ts";
import { DEPENDENCY_DETECT_PROMPT_FILE } from "../dependencies/sources/agent.ts";
import {
  realSources,
  sharedClients,
  type CreateSources,
} from "../dependencies/sources/assemble.ts";
import { runNativeSource } from "../dependencies/sources/native.ts";
import { runSources } from "../dependencies/sources/run.ts";
import {
  everyMs,
  resolveDependencyUpdatesOptions,
  type DependencyUpdatesOptions,
} from "./options.ts";
import { MAX_FAILURES, planBundles, readFailures } from "./plan.ts";

export const DEPENDENCY_UPDATES_KIND_NAME = "dependency-updates";
export const SCAN_REF = `${DEPENDENCY_UPDATES_KIND_NAME}:scan`;

/** The one unit: a scan, its revision the window it falls in. */
export type ScanUnit = { ref: string; revision: string };

export type DependencyUpdatesGathered = { due: ScanUnit | null };

/** Test seam: the sources behind the kind. */
export type DependencyUpdatesDeps = { createSources?: CreateSources };

export function createDependencyUpdatesKind(
  config: PhoebeConfig,
  options: DependencyUpdatesOptions,
  deps: DependencyUpdatesDeps = {},
): WorkKindDefinition<DependencyUpdatesGathered, ScanUnit> {
  if (options.label === config.readyLabel) {
    throw new Error(
      `kinds.${DEPENDENCY_UPDATES_KIND_NAME}: \`label\` must not be the ready label ` +
        `"${config.readyLabel}"; a pipeline running \`issues\` would take the ticket for its own.`,
    );
  }
  const createSources = deps.createSources ?? realSources(sharedClients(), runNativeSource);
  const window = everyMs(options.every);
  const routingLabel: PhoebeLabel = {
    name: options.label,
    description: "A dependency bundle for Phoebe to update",
  };
  let lastScanAt: number | null = null;

  return defineWorkKind<DependencyUpdatesGathered, ScanUnit>({
    name: DEPENDENCY_UPDATES_KIND_NAME,
    oneShotEligible: true,
    promptFile: DEPENDENCY_DETECT_PROMPT_FILE,
    workspace: "readonly",
    unitKey: "none",
    report: {
      noun: "dependency scan(s)",
      describe: () => `dependency update scan (every ${options.every})`,
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
      // Stamped before the sources start: a scan that fails waits for the next
      // window like one that succeeded, so a broken source costs one attempt
      // a window rather than one a poll.
      const now = ctx.clock.now();
      lastScanAt = now.getTime();

      const sources = await createSources(ctx, options.sources);
      const { candidates, finished } = await runSources(sources, ctx);
      if (finished.length === 0) {
        throw new Error("every dependency source failed; nothing to file this window.");
      }

      const filed = readFiled(ctx);
      const plan = planBundles(candidates, options, now, readFailures(filed.prs));
      const { ignored, immature, failedTwice } = plan.dropped;
      ctx.log(
        `${candidates.length} candidate(s): ${ignored} ignored, ${immature} not yet mature, ` +
          `${failedTwice} failed ${MAX_FAILURES} times; ${plan.planned.length} bundle(s).`,
      );

      const actions = decideFiling(plan.planned, filed.issues, filed.prs, {
        routingLabel: options.label,
        cap: options.prConcurrentLimit === 0 ? null : options.prConcurrentLimit,
      });
      applyFiling(actions, ctx, [DEPENDENCIES_LABEL, routingLabel]);
    },
  });
}

/**
 * The catalog entry point: the loader hands a factory the resolved config and
 * the block's root options. Validation throws here, at registration, so a bad
 * block fails `phoebe pipelines` and the pipeline's boot rather than a scan.
 */
export default function dependencyUpdatesKind(
  config: PhoebeConfig,
  options: unknown,
): WorkKindDefinition<DependencyUpdatesGathered, ScanUnit> {
  return createDependencyUpdatesKind(
    config,
    resolveDependencyUpdatesOptions(options, `kinds.${DEPENDENCY_UPDATES_KIND_NAME}`),
  );
}
