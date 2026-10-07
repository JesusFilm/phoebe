// The `status.json` snapshot one engine child writes for its pipeline (#73),
// as a type. The writer and its atomic-rename plumbing stay in
// src/unit-event.ts; the shape lives here because the deployment report ships
// the raw snapshot to every reader — `phoebe status`, the relay, the companion
// — and none of them may load an engine that reaches a filesystem (#528/#532).

export type UnitRef = { kind: string; id: string };

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
