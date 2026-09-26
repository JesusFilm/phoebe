// Which installs have a verb run in flight, as the rail needs to know it.
//
// A run's lines and exit name the run, not the install (verb-run.ts), and the
// rail draws installs. This is the map between them: a run id to the install it
// is on, learned when the rail starts one itself or when a line arrives for a
// run it has not seen, and forgotten at the exit. An install with any run on
// the map is busy — its shortcuts give way to a spinner until the exit.
//
// `pending` covers the moment between asking main to start a run and being
// told its id: the click has happened, and a rail that waited for the id
// before spinning would flicker once on every fast refusal.

export type RunActivity = {
  /** Run id → the install it runs on. */
  runs: ReadonlyMap<string, string>;
  /** Installs whose start has been asked for and not yet answered. */
  pending: ReadonlySet<string>;
};

export const NO_ACTIVITY: RunActivity = { runs: new Map(), pending: new Set() };

/** The rail asked main for a run on `dir`; the id is on its way. */
export function runAsked(activity: RunActivity, dir: string): RunActivity {
  return { ...activity, pending: new Set([...activity.pending, dir]) };
}

/** Main answered with a run id — or refused, in which case `runId` is null. */
export function runAnswered(activity: RunActivity, dir: string, runId: string | null): RunActivity {
  const pending = new Set(activity.pending);
  pending.delete(dir);
  const runs = new Map(activity.runs);
  if (runId !== null) runs.set(runId, dir);
  return { runs, pending };
}

/** A run learned from its lines: one the install page started, most likely. */
export function runSeen(activity: RunActivity, runId: string, dir: string): RunActivity {
  if (activity.runs.get(runId) === dir) return activity;
  return { ...activity, runs: new Map([...activity.runs, [runId, dir]]) };
}

/** The run ended, whoever started it. */
export function runEnded(activity: RunActivity, runId: string): RunActivity {
  if (!activity.runs.has(runId)) return activity;
  const runs = new Map(activity.runs);
  runs.delete(runId);
  return { ...activity, runs };
}

/** The installs with something in flight: the rail's spinner set. */
export function busyInstalls(activity: RunActivity): ReadonlySet<string> {
  return new Set([...activity.pending, ...activity.runs.values()]);
}
