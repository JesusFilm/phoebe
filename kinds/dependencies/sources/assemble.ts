// The real sources behind both detectors (ADR 0003): the native rows, the agent
// fallback and Renovate, each wrapped with its deadline for runSources. The
// two detectors differ only in which native pass they run: the daily one asks
// deps.dev what is newer, the hourly security one does not.

import type { WorkKindRunCtx } from "../../../src/work-kinds/definition.ts";
import { createDepsDevClient, type DepsDevClient } from "../registry/deps-dev.ts";
import { createOsvClient, type OsvClient } from "../registry/osv.ts";
import { nativeRows } from "../rows/index.ts";
import { createToolRunner } from "../rows/tool.ts";
import { AGENT_SOURCE_NAME, runAgentSource } from "./agent.ts";
import { detectNative, NATIVE_SOURCE_NAME, type NativeProject } from "./native.ts";
import { RENOVATE_SOURCE_NAME, RENOVATE_TIMEOUT_MS, runRenovateSource } from "./renovate.ts";
import type { SourceRun } from "./run.ts";
import type { SourceResult } from "./source.ts";

export const SOURCE_NAMES = [NATIVE_SOURCE_NAME, AGENT_SOURCE_NAME, RENOVATE_SOURCE_NAME] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

/** Each source's deadline. Renovate gets a minute past its own kill so it reports first. */
export const SOURCE_TIMEOUT_MS: Record<SourceName, number> = {
  [NATIVE_SOURCE_NAME]: 15 * 60_000,
  [AGENT_SOURCE_NAME]: 30 * 60_000,
  [RENOVATE_SOURCE_NAME]: RENOVATE_TIMEOUT_MS + 60_000,
};

/** The engine variables a row's tool inherits. Nothing else, so no token rides along. */
const TOOL_ENV = ["PATH", "HOME"] as const;

export type RegistryClients = { depsDev: DepsDevClient; osv: OsvClient };

/** A detector's sources for one run, by the names its options list. */
export type CreateSources = (
  ctx: WorkKindRunCtx,
  names: readonly SourceName[],
) => Promise<SourceRun[]>;

/** The native pass a detector runs over the projects the rows claimed. */
export type NativePass = (
  projects: readonly NativeProject[],
  deps: RegistryClients & { log: (line: string) => void },
) => Promise<SourceResult>;

let shared: RegistryClients | null = null;

/**
 * One pair of clients per process, made on first use. Their caches are what
 * let the hourly security pass and the daily updates pass share an OSV
 * advisory detail, and a deps.dev answer within its hour.
 */
export function sharedClients(): RegistryClients {
  shared ??= { depsDev: createDepsDevClient(), osv: createOsvClient() };
  return shared;
}

/**
 * The real sources. Native detection runs before any source starts, because
 * the agent is told which manifests the rows claimed; with the native source
 * off, the rows claim nothing and the agent covers every manifest.
 */
export function realSources(clients: RegistryClients, native: NativePass): CreateSources {
  return async (ctx, names) => {
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
              return native(detection.projects, { ...clients, log });
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
