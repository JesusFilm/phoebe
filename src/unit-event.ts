// Per-repo observability (#73) — the `UnitEvent` rail and `status.json` snapshot.
//
// With N repos multiplexed into one container, every line must be attributable
// per repo. The chosen shape is per-tenant-tagged stdout, host-collected, so the
// container stays log-stateless (no on-disk logs, no rotation): every Phoebe
// line is `[phoebe:<slug>]`, even in flat single-tenant mode — one grammar for
// any host parser, and the un-attributable bare `[phoebe]` is eliminated.
//
// Two concerns, one file each (#73 Decision 4): stdout is the append-only event
// *history* (ephemeral in-container); `status.json` is the current-state
// *snapshot* the supervisor's `phoebe list` reads (#63). A single
// `emitUnitEvent()` chokepoint does both — print the tagged line and refresh the
// fixed-size snapshot — and is also the seam #72's timeout and #75's quarantine
// emit through (no new channel). The durable record of a timeout/quarantine is a
// GitHub marker on the unit itself (src/orchestrator.ts), not anything on disk.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Snapshot filename inside a tenant's reserved `state/` dir (#62/#63). */
export const STATUS_FILE = "status.json";

export type UnitRef = { kind: string; id: string };

/** What happened to a work unit — the event vocabulary on the rail. */
export type UnitEventName = "started" | "completed" | "timed-out" | "quarantined";

/** One structured unit event (#73 Decision 5). */
export type UnitEvent = {
  ts: string;
  tenant: string;
  unit: UnitRef;
  event: UnitEventName;
  detail?: string;
};

/** The per-tenant stdout tag. Flat mode uses its config's `repoSlug`, never bare. */
export function unitTag(tenant: string): string {
  return `[phoebe:${tenant}]`;
}

/** A tagged, human-readable stdout line for one event. */
export function formatUnitEventLine(event: UnitEvent): string {
  const head = `${unitTag(event.tenant)} ${event.event} ${event.unit.kind} #${event.unit.id}`;
  return event.detail ? `${head} — ${event.detail}` : head;
}

/**
 * The fixed-size current-state snapshot `phoebe list` reads. Deliberately a
 * bounded set of last-event fields — never a rolling log (#73 Decision 4), which
 * would reintroduce the on-disk growth Decision 1 avoids.
 */
export type StatusSnapshot = {
  tenant: string;
  lastPollAt: string | null;
  currentUnit: UnitRef | null;
  lastError: string | null;
  lastTimeoutAt: string | null;
  updatedAt: string;
};

export function emptyStatus(tenant: string): StatusSnapshot {
  return {
    tenant,
    lastPollAt: null,
    currentUnit: null,
    lastError: null,
    lastTimeoutAt: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

/**
 * Fold a unit event into the snapshot (pure). `started` sets the current unit;
 * `completed` clears it; `timed-out` clears it and stamps `lastTimeoutAt`;
 * `quarantined` records the reason as `lastError`. Every event refreshes
 * `updatedAt` so a wedged supervisor is visible as a stale timestamp (#63).
 */
export function applyUnitEvent(prev: StatusSnapshot, event: UnitEvent): StatusSnapshot {
  const next: StatusSnapshot = { ...prev, updatedAt: event.ts };
  switch (event.event) {
    case "started":
      next.currentUnit = event.unit;
      break;
    case "completed":
      next.currentUnit = null;
      break;
    case "timed-out":
      next.currentUnit = null;
      next.lastTimeoutAt = event.ts;
      break;
    case "quarantined":
      next.currentUnit = null;
      next.lastError = event.detail ?? "quarantined";
      break;
  }
  return next;
}

export function readStatus(path: string): StatusSnapshot | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StatusSnapshot;
  } catch {
    return null;
  }
}

export function writeStatus(path: string, snapshot: StatusSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export type EmitUnitEvent = (event: Omit<UnitEvent, "tenant" | "ts">) => void;

/**
 * Build the `emitUnitEvent` chokepoint for one tenant: it prints the tagged
 * stdout line and refreshes the `status.json` snapshot on disk. Impurities
 * (clock, logger, fs) are injected so it is unit-tested without a real
 * filesystem. A snapshot write failure is swallowed after logging — observability
 * must never take a work unit down.
 */
export function createEmitUnitEvent(deps: {
  tenant: string;
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
    const event: UnitEvent = { ...partial, tenant: deps.tenant, ts: now() };
    log(formatUnitEventLine(event));
    try {
      const prev = read(deps.statusPath) ?? emptyStatus(deps.tenant);
      write(deps.statusPath, applyUnitEvent(prev, event));
    } catch (error) {
      log(`${unitTag(deps.tenant)} could not refresh status.json — ${String(error)}`);
    }
  };
}
