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
} from "../dependencies/filing.ts";
import { createDepsDevClient, type DepsDevClient } from "../dependencies/registry/deps-dev.ts";
import { createOsvClient, type OsvClient } from "../dependencies/registry/osv.ts";
import { nativeRows } from "../dependencies/rows/index.ts";
import { createToolRunner } from "../dependencies/rows/tool.ts";
import {
  AGENT_SOURCE_NAME,
  DEPENDENCY_DETECT_PROMPT_FILE,
  runAgentSource,
} from "../dependencies/sources/agent.ts";
import {
  detectNative,
  NATIVE_SOURCE_NAME,
  runNativeSource,
} from "../dependencies/sources/native.ts";
import {
  RENOVATE_SOURCE_NAME,
  RENOVATE_TIMEOUT_MS,
  runRenovateSource,
} from "../dependencies/sources/renovate.ts";
import { runSources, type SourceRun } from "../dependencies/sources/run.ts";
import {
  everyMs,
  resolveDependencyUpdatesOptions,
  type DependencyUpdatesOptions,
  type SourceName,
} from "./options.ts";
import { MAX_FAILURES, planBundles, readFailures } from "./plan.ts";

export const DEPENDENCY_UPDATES_KIND_NAME = "dependency-updates";
export const SCAN_REF = `${DEPENDENCY_UPDATES_KIND_NAME}:scan`;

/** Each source's deadline. Renovate gets a minute past its own kill so it reports first. */
export const SOURCE_TIMEOUT_MS: Record<SourceName, number> = {
  [NATIVE_SOURCE_NAME]: 15 * 60_000,
  [AGENT_SOURCE_NAME]: 30 * 60_000,
  [RENOVATE_SOURCE_NAME]: RENOVATE_TIMEOUT_MS + 60_000,
};

/** The engine variables a row's tool inherits. Nothing else, so no token rides along. */
const TOOL_ENV = ["PATH", "HOME"] as const;

/** The one unit: a scan, its revision the window it falls in. */
export type ScanUnit = { ref: string; revision: string };

export type DependencyUpdatesGathered = { due: ScanUnit | null };

/** Test seam: the sources behind the kind. */
export type DependencyUpdatesDeps = {
  createSources?: (ctx: WorkKindRunCtx, names: readonly SourceName[]) => Promise<SourceRun[]>;
};

/**
 * The real sources. Native detection runs before any source starts, because
 * the agent is told which manifests the rows claimed; with the native source
 * off, the rows claim nothing and the agent covers every manifest.
 */
function realSources(clients: { depsDev: DepsDevClient; osv: OsvClient }) {
  return async (ctx: WorkKindRunCtx, names: readonly SourceName[]): Promise<SourceRun[]> => {
    const log = (line: string) => ctx.log(line);
    const env: NodeJS.ProcessEnv = {};
    for (const name of TOOL_ENV) if (ctx.env[name] !== undefined) env[name] = ctx.env[name];
    // Detection and listing share the rows, so the native deadline reaches
    // the tools through a controller made before either runs.
    const nativeDeadline = new AbortController();
    const rows = nativeRows({
      run: createToolRunner({ env, signal: AbortSignal.any([ctx.signal, nativeDeadline.signal]) }),
      log,
    });
    const detection = names.includes(NATIVE_SOURCE_NAME)
      ? await detectNative(rows, ctx.workspace.dir, log)
      : { projects: [], claimed: [] };

    return names.map((name): SourceRun => {
      const timeoutMs = SOURCE_TIMEOUT_MS[name];
      switch (name) {
        case NATIVE_SOURCE_NAME:
          return {
            name,
            timeoutMs,
            run: (signal) => {
              signal.addEventListener("abort", () => nativeDeadline.abort(), { once: true });
              return runNativeSource(detection.projects, { ...clients, log });
            },
          };
        case AGENT_SOURCE_NAME:
          return {
            name,
            timeoutMs,
            run: (signal) =>
              runAgentSource(
                {
                  ...ctx,
                  agent: { ...ctx.agent, run: (opts) => ctx.agent.run({ ...opts, signal }) },
                },
                { claimed: detection.claimed },
              ),
          };
        case RENOVATE_SOURCE_NAME:
          return {
            name,
            timeoutMs,
            run: (signal) => runRenovateSource({ ...ctx, signal }),
          };
      }
    });
  };
}

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
  // One pair of clients per process: their caches are what let the security
  // pass and this one share a deps.dev answer within its hour.
  const createSources =
    deps.createSources ?? realSources({ depsDev: createDepsDevClient(), osv: createOsvClient() });
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
