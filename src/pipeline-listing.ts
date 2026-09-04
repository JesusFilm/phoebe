// The pipeline lines under a tenant in `phoebe list` (#427).
//
// A tenant used to be one engine process with one `status.json`, so its pipeline
// carried one state column. It is now a (tenant × pipeline) matrix, and the
// question an operator asks — which pipeline is busy, which is stuck, which is gone
// — is per pipeline. So the tenant pipeline keeps what is true of the whole tenant
// (config, env, data, arm, held, disabled) and every pipeline gets its own
// line beneath it.
//
// Three things can put a line there, and the line says which:
//
//   - enumerated  the pipeline the supervisor would spawn, from the same
//                 enumeration it spawns from — `enumeratePipelines`, called
//                 in-process rather than through `phoebe pipelines`, so `list`
//                 and the supervisor cannot disagree about what a tenant runs.
//   - stale       a `state/<name>/` directory no enumerated pipeline produces: a
//                 renamed or deleted pipeline whose snapshot outlived it. The
//                 pipeline analogue of an `undeclared` tenant — reported, not
//                 acted on.
//   - disk        the fallback when the pipeline set is unknowable. A held tenant
//                 cannot be enumerated (its config is exactly what discovery
//                 could not read), so `list` shows what is on disk and says so
//                 rather than showing nothing.
//
// The state each line reports is read from that pipeline's own snapshot and nothing
// else. Two snapshots are never compared: a pipeline that polls every 15 minutes is
// not sick because the pipeline beside it wrote a second ago, and an idle pipeline is not
// sick for being idle a week. The only staleness claim made here is `wedged?`,
// and it is anchored to the one deadline the snapshot carries — the in-flight
// unit's own run budget.

import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  CUSTOM_WORK_KIND_NAME_RE,
  PIPELINE_DEFAULTS,
  resolveConfig,
  type PhoebeConfig,
} from "./config-schema.ts";
import { applyEnvOverlay, loadUserConfig } from "./load-config.ts";
import { enumeratePipelines } from "./pipeline-enumerate.ts";
import { declaredPipeline, resolvePollIntervalMs } from "./pipeline.ts";
import { readStatus, statusPathFor, type CurrentUnit, type StatusSnapshot } from "./unit-event.ts";

/** Where a pipeline line came from — see the header. */
export type PipelineSource = "enumerated" | "stale" | "disk";

/**
 * What a pipeline is doing, from its own snapshot. Tested in this order, so a
 * pipeline that is both working and parked on a second slot reads as working: the
 * unit already in flight is the more useful fact.
 */
export type PipelineState = "no status" | "working" | "waiting for slot" | "idle";

/** One pipeline line under a tenant. */
export type PipelineListing = {
  name: string;
  /** The pipeline's hot off-switch. Always false for a line that was not enumerated. */
  disabled: boolean;
  source: PipelineSource;
  state: PipelineState;
  /** In-flight units, oldest admission first (empty unless `state` is working). */
  units: CurrentUnit[];
  /** When the snapshot last moved; null when there is no snapshot. */
  updatedAt: string | null;
  /**
   * The oldest in-flight unit has been running longer than its own run budget
   * plus one poll interval — long enough that the loop should have reaped it.
   * A question, not a verdict: nothing here can see whether the process is
   * alive, so `list` reports the smell and leaves the call to the operator.
   */
  wedged: boolean;
  /** The declared `concurrency` — the N in `working k/N`; null when unknown. */
  concurrency: number | null;
};

/** What `list` needs to know about a pipeline it did not read a snapshot for. */
export type PipelineFacts = {
  name: string;
  disabled: boolean;
  concurrency: number;
  /** This pipeline's idle cadence — the grace added to a unit's budget below. */
  pollIntervalMs: number;
};

/**
 * How the pipeline set is obtained. Injectable so the fleet-wide tests can declare
 * pipelines without a loadable tenant config on disk, the way every other reader in
 * `phoebe list` is injectable.
 */
export type LoadPipelines = (
  configPath: string,
) => readonly PipelineFacts[] | Promise<readonly PipelineFacts[]>;

/**
 * Enumerate a tenant's pipelines in-process, through the same function the
 * `phoebe pipelines` subcommand runs for the supervisor. Loading the tenant's
 * work-kind modules is part of that: a pipeline whose custom kind will not load is a
 * pipeline the supervisor cannot spawn either, and the throw here is what drops the
 * tenant to its on-disk lines rather than inventing a pipeline set.
 *
 * The resolved config it installs globally (`setResolvedConfig`, inside the
 * enumerator) is inert in this process — `phoebe list` runs no work — but it is
 * the reason this is never called from a process that does.
 */
export async function enumeratePipelineFacts(opts: {
  configPath: string;
  dataBase: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PipelineFacts[]> {
  const env = opts.env ?? process.env;
  const user = await loadUserConfig(opts.configPath);
  const config: PhoebeConfig = resolveConfig(applyEnvOverlay(user, env), {
    dataBase: opts.dataBase,
  });
  const pipelines = await enumeratePipelines(config, dirname(opts.configPath));
  return pipelines.map((pipeline) => ({
    name: pipeline.name,
    disabled: pipeline.disabled,
    concurrency: pipeline.concurrency,
    pollIntervalMs: resolvePollIntervalMs(declaredPipeline(config, pipeline.name), env),
  }));
}

/** The state one snapshot reports, in the documented test order. */
export function pipelineState(snapshot: StatusSnapshot | null): PipelineState {
  if (snapshot === null) return "no status";
  if (snapshot.currentUnits.length > 0) return "working";
  if (snapshot.waitingForSlot) return "waiting for slot";
  return "idle";
}

/**
 * How long the oldest in-flight unit has been running, in ms — or null when
 * nothing is in flight. The one clock reading `list` makes about a pipeline.
 */
export function oldestUnitAgeMs(units: readonly CurrentUnit[], now: number): number | null {
  const oldest = units[0];
  if (oldest === undefined) return null;
  const startedAt = Date.parse(oldest.startedAt);
  return Number.isFinite(startedAt) ? now - startedAt : null;
}

/**
 * Whether any in-flight unit is past its own deadline: its own `runBudgetMs`
 * plus one poll interval of slack, since a loop reaps a timed-out unit on its
 * next pass rather than the instant the budget expires.
 *
 * Each unit is judged against its own budget, not the oldest unit's — a newer
 * unit with a shorter budget can be wedged while the oldest one isn't.
 *
 * A unit that names no budget (an older engine's, or a unit admitted without
 * one) yields no verdict at all for that unit. Guessing a budget would turn
 * "this engine did not say" into "this unit is stuck".
 */
export function isWedged(
  snapshot: StatusSnapshot | null,
  pollIntervalMs: number,
  now: number,
): boolean {
  const units = snapshot?.currentUnits ?? [];
  return units.some((unit) => {
    if (unit.runBudgetMs === null) return false;
    const startedAt = Date.parse(unit.startedAt);
    if (!Number.isFinite(startedAt)) return false;
    const age = now - startedAt;
    return age > unit.runBudgetMs + pollIntervalMs;
  });
}

/** A coarse age for one line of operator output: `45s`, `12m`, `3h`, `2d`. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Build one line from a pipeline's facts and whatever snapshot it has. */
function listingFor(opts: {
  name: string;
  disabled: boolean;
  source: PipelineSource;
  concurrency: number | null;
  pollIntervalMs: number;
  snapshot: StatusSnapshot | null;
  now: number;
}): PipelineListing {
  const { snapshot } = opts;
  return {
    name: opts.name,
    disabled: opts.disabled,
    source: opts.source,
    state: pipelineState(snapshot),
    units: snapshot?.currentUnits ?? [],
    updatedAt: snapshot?.updatedAt ?? null,
    wedged: isWedged(snapshot, opts.pollIntervalMs, opts.now),
    concurrency: opts.concurrency,
  };
}

/**
 * The `state/<name>/` directories on disk, sorted. Only names a pipeline could
 * legally have count, which is what keeps the tenant's other state — the
 * `clone.lock` directory, anything a later ticket puts there — from reading as
 * an abandoned pipeline.
 */
function stateDirNames(stateDir: string | null): string[] {
  if (stateDir === null) return [];
  let entries;
  try {
    entries = readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && CUSTOM_WORK_KIND_NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function snapshotFor(stateDir: string | null, name: string): StatusSnapshot | null {
  return stateDir === null ? null : readStatus(statusPathFor(stateDir, name));
}

/**
 * The pipeline lines for one tenant.
 *
 * `configPath` null means the pipeline set is not knowable — a held tenant — and
 * every line comes off disk. So does a tenant whose config enumerates with an
 * error: `list` is an operator surface, and a tenant it cannot enumerate is
 * exactly when the snapshots on disk are worth showing.
 */
export async function listPipelines(opts: {
  /** The tenant's `phoebe.config.ts`, or null when it cannot be enumerated. */
  configPath: string | null;
  /** The tenant's `state/` dir, or null when its slug is unknown. */
  stateDir: string | null;
  dataBase: string;
  loadRows?: LoadPipelines;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<PipelineListing[]> {
  const now = opts.now ?? Date.now();
  const loadRows: LoadPipelines =
    opts.loadRows ??
    ((configPath) =>
      enumeratePipelineFacts({
        configPath,
        dataBase: opts.dataBase,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      }));

  let pipelines: readonly PipelineFacts[] | null = null;
  if (opts.configPath !== null) {
    try {
      pipelines = await loadRows(opts.configPath);
    } catch {
      pipelines = null;
    }
  }

  if (pipelines === null) {
    // From disk: one line per snapshot, and only per snapshot — an empty
    // directory says nothing about a pipeline this tenant may or may not declare.
    return stateDirNames(opts.stateDir).flatMap((name) => {
      const snapshot = snapshotFor(opts.stateDir, name);
      if (snapshot === null) return [];
      return [
        listingFor({
          name,
          disabled: false,
          source: "disk",
          concurrency: null,
          pollIntervalMs: PIPELINE_DEFAULTS.pollIntervalMs,
          snapshot,
          now,
        }),
      ];
    });
  }

  const enumerated = pipelines.map((pipeline) =>
    listingFor({
      name: pipeline.name,
      disabled: pipeline.disabled,
      source: "enumerated",
      concurrency: pipeline.concurrency,
      pollIntervalMs: pipeline.pollIntervalMs,
      snapshot: snapshotFor(opts.stateDir, pipeline.name),
      now,
    }),
  );
  const declared = new Set(pipelines.map((pipeline) => pipeline.name));
  const stale = stateDirNames(opts.stateDir)
    .filter((name) => !declared.has(name))
    .map((name) =>
      listingFor({
        name,
        disabled: false,
        source: "stale",
        concurrency: null,
        pollIntervalMs: PIPELINE_DEFAULTS.pollIntervalMs,
        snapshot: snapshotFor(opts.stateDir, name),
        now,
      }),
    );
  return [...enumerated, ...stale];
}
