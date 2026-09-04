// The supervisor's half of the stale-state sweep (#411/#426).
//
// The sweep itself lives in the engine (`<entry> sweep-state --config <tenant
// config> --json`), for the same reason enumeration does: what a row owns on
// disk is the engine's business, pinned to the engine ref, and the bootstrapper
// is not upgraded for it. This module is the call and nothing more — the
// bootstrapper still deletes no disk itself, which is what keeps a bad launcher
// release unable to destroy a tenant's data.
//
// Its posture is the point:
//
//   - **Never load-bearing.** A sweep that fails is a log line. The supervisor
//     spawns exactly as if it had never run, so reclaiming stale state can never
//     cost availability.
//   - **No probe.** Enumeration has one because a checkout that cannot enumerate
//     changes what the supervisor *spawns*; a checkout with no `sweep-state`
//     subcommand changes nothing at all. The failure and the absence take the
//     same path — one warning, carry on.

import { diagnosis, engineCommandFor, lastJsonLine, type EngineCommand } from "./pipeline-rows.ts";

/**
 * Which of the two triggers ran this sweep: facility boot before any row
 * spawns, or a row-set change once the rows it took down have drained. There is
 * no third — the sweep is never periodic.
 */
export type StateSweepTrigger = "boot" | "row-change";

/** A worktree the sweep refused to delete, with the hint the engine wrote for it. */
export type ProtectedItem = {
  path: string;
  detail: string;
  reclaim: string;
};

/** What one tenant's sweep did, reduced to what an operator wants read out. */
export type StateSweepOutcome = {
  removed: number;
  failed: number;
  /** The dirty and unpushed trees, which only a human can decide about. */
  kept: ProtectedItem[];
};

/** The sweep failed as a whole — this tenant's disk is untouched. */
export class StateSweepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateSweepError";
  }
}

export type SweepTarget = {
  configPath: string;
  /** Working directory for the engine process — the tenant dir, as its child gets. */
  cwd?: string;
};

export type StateSweeper = {
  sweep: (target: SweepTarget) => StateSweepOutcome;
};

/** Count the entries of an array-shaped member, or 0 when it is not one. */
function countOf(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return Array.isArray(value) ? value.length : 0;
}

/** The protected tier, keeping only entries carrying the three fields it needs. */
function parseKept(payload: Record<string, unknown>): ProtectedItem[] {
  const kept = payload["kept"];
  if (!Array.isArray(kept)) return [];
  const items: ProtectedItem[] = [];
  for (const entry of kept) {
    if (entry === null || typeof entry !== "object") continue;
    const { path, detail, reclaim } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof reclaim !== "string") continue;
    items.push({ path, detail: typeof detail === "string" ? detail : "", reclaim });
  }
  return items;
}

/**
 * The sweeper for one materialized engine checkout. A non-zero exit, a missing
 * subcommand, an unparseable answer — all one {@link StateSweepError}, because
 * the caller does the same thing with each of them.
 */
export function createStateSweeper(opts: { entry: string; run?: EngineCommand }): StateSweeper {
  const run = opts.run ?? engineCommandFor(opts.entry);
  return {
    sweep(target) {
      const result = run(
        ["sweep-state", "--config", target.configPath, "--json"],
        target.cwd !== undefined ? { cwd: target.cwd } : {},
      );
      if (result.status !== 0) {
        throw new StateSweepError(`${diagnosis(result)}`);
      }
      const payload = lastJsonLine(result.stdout);
      if (payload === null || typeof payload !== "object") {
        throw new StateSweepError(
          `the engine printed no sweep result (got ${result.stdout.trim()})`,
        );
      }
      const record = payload as Record<string, unknown>;
      return {
        removed: countOf(record, "removed"),
        failed: countOf(record, "failed"),
        kept: parseKept(record),
      };
    },
  };
}
