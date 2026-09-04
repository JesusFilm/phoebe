// Per-repo observability (#73) — the `UnitEvent` rail and `status.json` snapshot.
//
// With N repos multiplexed into one container, every line must be attributable
// per repo. The chosen shape is per-tenant-tagged stdout, host-collected, so the
// container stays log-stateless (no on-disk logs, no rotation): every Phoebe
// line is `[phoebe:<slug>:<pipeline>]`, even in solo single-tenant mode — one
// grammar for any host parser, and the un-attributable bare `[phoebe]` is
// eliminated.
//
// The pipeline segment arrived with #418, when a tenant became several engine
// processes rather than one. It is on every line including the implicit `work`
// pipeline's, so the grammar has one shape rather than two — a host parser matching
// the tag has to match it as a prefix, not as a fixed string.
//
// Two concerns, one file each (#73 Decision 4): stdout is the append-only event
// *history* (ephemeral in-container); `status.json` is the current-state
// *snapshot* the supervisor's `phoebe list` reads (#63). A single
// `emitUnitEvent()` chokepoint does both — print the tagged line and refresh the
// fixed-size snapshot — and is also the seam #72's timeout and #75's quarantine
// emit through (no new channel). The durable record of a timeout/quarantine is a
// GitHub marker on the unit itself (src/orchestrator.ts), not anything on disk.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Snapshot filename inside a pipeline's own dir under `state/` (#62/#63/#418). */
export const STATUS_FILE = "status.json";

/**
 * Where one pipeline's snapshot lives: `state/<pipeline>/status.json`.
 *
 * Per pipeline rather than per tenant because the snapshot has exactly one
 * writer by design — and a tenant now runs several engine processes. Sharing
 * one file, each would drop the other's units from `currentUnits` on every
 * event. The directory is the ownership boundary: one process writes it,
 * `phoebe list` and an operator read it.
 */
export function statusPathFor(stateDir: string, pipeline: string): string {
  return join(stateDir, pipeline, STATUS_FILE);
}

export type UnitRef = { kind: string; id: string };

/**
 * What happened to a work unit — the event vocabulary on the rail. `skipped`
 * is the one outcome that is nobody's fault: the unit was picked, and then its
 * worktree turned out to be leased by another pipeline (#418), so this cycle
 * leaves it alone. `waiting-for-slot` is the one event about a unit that has
 * not started: the pass selected it and is parked on the broker's grant (#422).
 */
export type UnitEventName =
  | "started"
  | "waiting-for-slot"
  | "completed"
  | "failed"
  | "timed-out"
  | "quarantined"
  | "skipped";

/** One structured unit event (#73 Decision 5). */
export type UnitEvent = {
  ts: string;
  tenant: string;
  pipeline: string;
  unit: UnitRef;
  event: UnitEventName;
  detail?: string;
  /**
   * The unit's whole-run wall-clock budget, carried on `started` so the
   * snapshot can say how long a running unit has before its deadline (#422).
   * The loop always names it; anything else leaves it unset and the snapshot
   * records `null` rather than inventing a number.
   */
  runBudgetMs?: number;
};

/**
 * The stdout tag every engine line carries. Solo mode uses its config's
 * `repoSlug` and the implicit `work` pipeline, never bare and never half-tagged.
 */
export function unitTag(tenant: string, pipeline: string): string {
  return `[phoebe:${tenant}:${pipeline}]`;
}

/**
 * The engine's three tagged output channels. Every line one engine process
 * writes goes through one of these, so the tag is a property of the process
 * rather than of the 60-odd call sites that would otherwise each have to
 * remember it — which is what "every line" in #418 actually costs.
 */
export type EngineLog = {
  /** The tag itself, for the handful of lines that build their own prefix. */
  tag: string;
  say(line: string): void;
  warn(line: string): void;
  fail(line: string): void;
};

export function createEngineLog(tenant: string, pipeline: string): EngineLog {
  const tag = unitTag(tenant, pipeline);
  return {
    tag,
    say: (line) => console.log(`${tag} ${line}`),
    warn: (line) => console.warn(`${tag} ${line}`),
    fail: (line) => console.error(`${tag} ${line}`),
  };
}

/** A tagged, human-readable stdout line for one event. `id` is the unit's
 *  kind-owned ref (`pr:123`, `issue:88`) and prints as-is (#348). */
export function formatUnitEventLine(event: UnitEvent): string {
  const head =
    `${unitTag(event.tenant, event.pipeline)} ${event.event} ` +
    `${event.unit.kind} ${event.unit.id}`;
  return event.detail ? `${head} — ${event.detail}` : head;
}

/** One unit this pipeline is running right now. */
export type CurrentUnit = {
  unit: UnitRef;
  /** When the loop admitted it — the `started` event's timestamp. */
  startedAt: string;
  /** Its whole-run budget, resolved per kind at boot; `null` if unstated. */
  runBudgetMs: number | null;
};

/**
 * The fixed-size current-state snapshot `phoebe list` reads. Deliberately a
 * bounded set of last-event fields — never a rolling log (#73 Decision 4), which
 * would reintroduce the on-disk growth Decision 1 avoids. `currentUnits` is
 * bounded by the pipeline's `concurrency` (#422), so it stays fixed-size in the sense
 * that matters: an operator's screen, not an ever-growing file.
 */
export type StatusSnapshot = {
  tenant: string;
  /** Which pipeline wrote this file. Its directory already says so; the field is what
   *  makes a snapshot read on its own — `cat`'d, or shipped somewhere else. */
  pipeline: string;
  /** What this pipeline is running, oldest admission first (#422). */
  currentUnits: CurrentUnit[];
  /** A pass selected a unit and is parked on the broker's slot grant (#422). */
  waitingForSlot: boolean;
  lastError: string | null;
  lastTimeoutAt: string | null;
  updatedAt: string;
};

export function emptyStatus(tenant: string, pipeline: string): StatusSnapshot {
  return {
    tenant,
    pipeline,
    currentUnits: [],
    waitingForSlot: false,
    lastError: null,
    lastTimeoutAt: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function sameUnit(a: UnitRef, b: UnitRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Fold a unit event into the snapshot (pure). `started` adds the unit to
 * `currentUnits`; every settling event (`completed`, `failed`, `timed-out`,
 * `quarantined`, `skipped`) removes that one unit and leaves its siblings
 * alone, which is the whole difference concurrency makes here. `failed` and
 * `quarantined` also record the reason as `lastError` so `phoebe list` can tell
 * a repo that keeps failing from one that succeeds; `timed-out` stamps
 * `lastTimeoutAt`; `skipped` records nothing, because a unit deferred to its
 * lease holder is not this pipeline's error.
 *
 * `waitingForSlot` is set by `waiting-for-slot` and cleared only by `started`.
 * Not by the settling events: a sibling finishing while a pass is parked on the
 * broker says nothing about whether that pass got its slot.
 *
 * Every event refreshes `updatedAt` so a wedged supervisor is visible as a
 * stale timestamp (#63).
 */
export function applyUnitEvent(prev: StatusSnapshot, event: UnitEvent): StatusSnapshot {
  const next: StatusSnapshot = { ...prev, updatedAt: event.ts };
  const without = (): CurrentUnit[] =>
    prev.currentUnits.filter((current) => !sameUnit(current.unit, event.unit));
  switch (event.event) {
    case "started":
      next.currentUnits = [
        ...without(),
        { unit: event.unit, startedAt: event.ts, runBudgetMs: event.runBudgetMs ?? null },
      ];
      next.waitingForSlot = false;
      break;
    case "waiting-for-slot":
      next.waitingForSlot = true;
      break;
    case "completed":
    case "skipped":
      next.currentUnits = without();
      break;
    case "failed":
      next.currentUnits = without();
      next.lastError = event.detail ?? "failed";
      break;
    case "timed-out":
      next.currentUnits = without();
      next.lastTimeoutAt = event.ts;
      break;
    case "quarantined":
      next.currentUnits = without();
      next.lastError = event.detail ?? "quarantined";
      break;
  }
  return next;
}

/**
 * Read one snapshot, normalized onto the current shape. The file outlives the
 * engine that wrote it — `phoebe boot` relaunches the engine at a new ref
 * against the same state dir — so a snapshot written before `currentUnit`
 * became `currentUnits` (#422) is a live case, not a hypothetical. Filling the
 * missing fields here keeps that an upgrade rather than a migration, and keeps
 * every reader from having to know both shapes.
 */
export function readStatus(path: string): StatusSnapshot | null {
  let parsed: Partial<StatusSnapshot> & { currentUnit?: UnitRef | null };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as typeof parsed;
  } catch {
    return null;
  }
  const empty = emptyStatus(parsed.tenant ?? "", parsed.pipeline ?? "");
  const legacy: CurrentUnit[] = parsed.currentUnit
    ? [
        {
          unit: parsed.currentUnit,
          startedAt: parsed.updatedAt ?? empty.updatedAt,
          runBudgetMs: null,
        },
      ]
    : [];
  return {
    tenant: parsed.tenant ?? empty.tenant,
    pipeline: parsed.pipeline ?? empty.pipeline,
    currentUnits: parsed.currentUnits ?? legacy,
    waitingForSlot: parsed.waitingForSlot ?? empty.waitingForSlot,
    lastError: parsed.lastError ?? empty.lastError,
    lastTimeoutAt: parsed.lastTimeoutAt ?? empty.lastTimeoutAt,
    updatedAt: parsed.updatedAt ?? empty.updatedAt,
  };
}

/**
 * Persist the snapshot atomically: write a sibling temp file, then `rename` it
 * over `path`. `rename` is atomic within a filesystem, so a concurrent reader
 * (`phoebe list`, or the next emit's `readStatus`) only ever sees the complete
 * old file or the complete new one — never a half-written one, which would parse
 * as invalid JSON and silently fold the event onto `emptyStatus`, discarding
 * `lastError`/`lastTimeoutAt`. The temp name carries the pid so two processes
 * writing the same dir cannot clobber each other's partial file.
 */
export function writeStatus(path: string, snapshot: StatusSnapshot): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.status.json.tmp`);
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(tmp, path);
}

export type EmitUnitEvent = (event: Omit<UnitEvent, "tenant" | "pipeline" | "ts">) => void;

/**
 * Build the `emitUnitEvent` chokepoint for one tenant: it prints the tagged
 * stdout line and refreshes the `status.json` snapshot on disk. Impurities
 * (clock, logger, fs) are injected so it is unit-tested without a real
 * filesystem. A snapshot write failure is swallowed after logging — observability
 * must never take a work unit down.
 */
export function createEmitUnitEvent(deps: {
  tenant: string;
  pipeline: string;
  statusPath: string;
  now?: () => string;
  log?: (line: string) => void;
  read?: (path: string) => StatusSnapshot | null;
  write?: (path: string, snapshot: StatusSnapshot) => void;
}): EmitUnitEvent {
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? ((line) => console.log(line));
  const read = deps.read ?? readStatus;
  const write = deps.write ?? writeStatus;

  return (partial) => {
    const event: UnitEvent = {
      ...partial,
      tenant: deps.tenant,
      pipeline: deps.pipeline,
      ts: now(),
    };
    log(formatUnitEventLine(event));
    try {
      const prev = read(deps.statusPath) ?? emptyStatus(deps.tenant, deps.pipeline);
      write(deps.statusPath, applyUnitEvent(prev, event));
    } catch (error) {
      log(
        `${unitTag(deps.tenant, deps.pipeline)} could not refresh status.json — ${String(error)}`,
      );
    }
  };
}
