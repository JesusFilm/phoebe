// Daily cost cap (#165): sums `resources.costUsd` off the durable events-v1
// journal for the current UTC day, rather than keeping a second counter file
// in sync with it (the way `push-rate-limit.ts` does for its hourly budget) —
// the journal is already the fleet's system of record for what a work unit
// cost, so a day's total is a query over it, not new state. The stateless
// poll loop has nowhere else to remember a cross-cycle total; this is the
// natural home docs/competitive-landscape.md §4.1 points at.

import { replayEventJournal } from "./event-journal.ts";

/** UTC calendar day, e.g. `2026-08-12` — a run's `endedAt` in this day counts toward today's budget. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Sum of `resources.costUsd` across every journaled work outcome that ended in `now`'s UTC day. */
export function dailyCostSpent(stateDir: string, now: Date): number {
  const day = utcDay(now);
  const { events } = replayEventJournal(stateDir);
  let total = 0;
  for (const event of events) {
    if (event.endedAt.slice(0, 10) !== day) continue;
    total += event.resources.costUsd ?? 0;
  }
  return total;
}

/** Whether `dailyCostCapUsd` has already been reached for `now`'s UTC day. `cap <= 0` means the cap is disabled. */
export function dailyCostBudgetExhausted(stateDir: string, cap: number, now: Date): boolean {
  return cap > 0 && dailyCostSpent(stateDir, now) >= cap;
}
