// Unit history (#926, decisions in #917): one unit record per settled work unit,
// appended to `state/<pipeline>/units.jsonl` beside the pipeline's
// `status.json`, and one per abandoned unit the next process finds at boot (#928).
//
// #73 made the container log-stateless, and this does not undo it: a record is a
// bounded row of facts, not a log line, and no transcript or raw payload is ever
// written. The file is bounded by size rather than by count. Past 1 MiB it is
// renamed over `units.1.jsonl` and a fresh one started, so a pipeline holds two
// generations — about 2 MiB, some two thousand units — and nothing more. There
// is no knob.
//
// The pipeline process is the file's only writer, as it is the snapshot's, so
// nothing is locked. And like the snapshot, a write that fails is one log line:
// bookkeeping never takes a unit down.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  UNIT_RECORD_DETAIL_MAX,
  UNIT_RECORD_VERSION,
  type AgentRunRecord,
  type CostBasis,
  type UnitRecord,
} from "./contracts/unit-record.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import type { UsageMeter } from "./providers/types.ts";
import { unitTag, type CurrentUnit } from "./unit-event.ts";

/** History filename inside a pipeline's own dir under `state/`. */
export const UNITS_FILE = "units.jsonl";

/** The previous generation, which the next rotation overwrites. */
export const UNITS_ROTATED_FILE = "units.1.jsonl";

/** The size past which the history rotates. */
export const UNITS_ROTATE_BYTES = 1024 * 1024;

/** Where one pipeline's unit history lives: `state/<pipeline>/units.jsonl`. */
export function unitsPathFor(stateDir: string, pipeline: string): string {
  return join(stateDir, pipeline, UNITS_FILE);
}

/**
 * Append one line to the history at `path`, rotating first when the file is
 * already past `maxBytes`. The check is before the write, so the line that
 * crosses the cap still lands in the current file and the next one starts the
 * new generation.
 */
export function appendUnitLine(
  path: string,
  line: string,
  maxBytes: number = UNITS_ROTATE_BYTES,
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  if (existsSync(path) && statSync(path).size >= maxBytes) {
    renameSync(path, join(dir, UNITS_ROTATED_FILE));
  }
  appendFileSync(path, line);
}

/** Cut `detail` to the record's limit. */
export function capDetail(detail: string | null): string | null {
  if (detail === null) return null;
  return detail.length > UNIT_RECORD_DETAIL_MAX ? detail.slice(0, UNIT_RECORD_DETAIL_MAX) : detail;
}

/** SHA-256 of a prompt template, taken before any placeholder is filled. */
export function promptShaOf(template: string): string {
  return createHash("sha256").update(template).digest("hex");
}

/**
 * The commit of the engine checkout this module was loaded from, or `null`
 * when it is not one. `phoebe boot` runs a github-sourced engine from a clone,
 * which answers; the copy bundled in the npm package has no `.git` of its own,
 * and asking git there would answer with whatever repo the package sits in.
 */
export function readEngineCommit(srcDir: string, git: GitRunner = defaultGit): string | null {
  const root = dirname(srcDir);
  if (!existsSync(join(root, ".git"))) return null;
  try {
    const sha = git(["-C", root, "rev-parse", "HEAD"], { stdio: "pipe" }).trim();
    return sha === "" ? null : sha;
  } catch {
    return null;
  }
}

/**
 * One agent run while it is happening: what was known when it spawned, the
 * meter its stream feeds, and how it ended once it has. Held on the unit so a
 * record written before the child exits — a timeout's — can still read it.
 */
export type AgentRunTrack = {
  startedAt: Date;
  promptSha: string;
  /** What a cost figure from this run would be, from its credential. */
  costBasis: CostBasis | null;
  meter: UsageMeter;
  /** Set when the child exits; `null` while it runs. */
  endedAt: Date | null;
  exitCode: number | null;
};

/**
 * The record of one agent run as of `now`. A run still going when the unit
 * settled — killed by the budget, its exit not yet seen — is incomplete
 * whatever its meter says, and its duration runs to `now`.
 */
export function agentRunRecord(track: AgentRunTrack, now: Date): AgentRunRecord {
  const usage = track.meter.read();
  const end = track.endedAt ?? now;
  return {
    startedAt: track.startedAt.toISOString(),
    durationMs: Math.max(0, end.getTime() - track.startedAt.getTime()),
    exitCode: track.endedAt === null ? null : track.exitCode,
    promptSha: track.promptSha,
    ...usage,
    usageComplete: track.endedAt !== null && usage.usageComplete,
    costBasis: usage.costUsd === null ? null : track.costBasis,
  };
}

/** What a caller hands the writer: the record, less what the writer knows itself. */
export type UnitRecordInput = Omit<UnitRecord, "v" | "tenant" | "pipeline" | "engineCommit">;

export type RecordUnit = (record: UnitRecordInput) => void;

/**
 * The record of an abandoned unit (#928): one a previous process started and
 * never settled, found in the snapshot at boot. All that survives is what the
 * snapshot held, so it has no settle time, no duration and no agent runs.
 */
export function abandonedRecord(current: CurrentUnit): UnitRecordInput {
  return {
    unit: current.unit,
    outcome: "abandoned",
    quarantined: false,
    detail: null,
    startedAt: current.startedAt,
    settledAt: null,
    durationMs: null,
    runBudgetMs: current.runBudgetMs,
    provider: current.provider,
    model: current.model,
    effort: current.effort,
    branch: null,
    headSha: null,
    prNumber: null,
    agentRuns: [],
  };
}

/** What one pipeline's history writer is built from. */
export type UnitHistoryDeps = {
  /** The deployment's name, which opens the line a failed write logs (#686). */
  deployment: string;
  tenant: string;
  pipeline: string;
  unitsPath: string;
  engineCommit: string | null;
  log?: (line: string) => void;
  append?: (path: string, line: string) => void;
  /**
   * A record landed. The engine tells its supervisor here (#929), so the
   * deployment report's history summary moves with the unit rather than on the
   * next hourly recompute. Not called when the append failed: there is nothing
   * new to read.
   */
  onAppended?: () => void;
};

/**
 * Build `recordUnit` for one pipeline: stamp the record with what the writer
 * knows, cut `detail`, and append it as one line. A write that fails is logged
 * once, as one line, and swallowed.
 */
export function createRecordUnit(deps: UnitHistoryDeps): RecordUnit {
  const log = deps.log ?? ((line) => console.log(line));
  const append = deps.append ?? appendUnitLine;
  return (input) => {
    const record: UnitRecord = {
      v: UNIT_RECORD_VERSION,
      tenant: deps.tenant,
      pipeline: deps.pipeline,
      ...input,
      detail: capDetail(input.detail),
      engineCommit: deps.engineCommit,
    };
    try {
      append(deps.unitsPath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      log(
        `${unitTag(deps.deployment, deps.tenant, deps.pipeline)} could not append to ` +
          `${UNITS_FILE} for ${input.unit.kind} ${input.unit.id} — ${String(error)}`,
      );
      return;
    }
    deps.onAppended?.();
  };
}
