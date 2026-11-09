// Running a detector's sources (ADR 0003): every configured source at once,
// each under its own deadline, unioned in the order the detector lists them.
// A source that fails or runs out of time is a log line, and the others'
// results stand.

import { unionCandidates, type Candidate } from "../candidate.ts";
import type { SourceResult } from "./source.ts";

/** One source, ready to start. */
export type SourceRun = {
  name: string;
  timeoutMs: number;
  /** Start the source. `signal` fires at its deadline and at the run's own. */
  run(signal: AbortSignal): Promise<SourceResult>;
};

export type SourcesOutcome = {
  /** The union of every source that finished, earlier sources winning conflicts. */
  candidates: Candidate[];
  /** The names of the sources that finished. */
  finished: string[];
};

function minutes(ms: number): string {
  const m = ms / 60_000;
  return Number.isInteger(m) ? `${m}m` : `${ms}ms`;
}

/** One source under its deadline. Never throws: a throw is a failed source. */
async function runOne(source: SourceRun, outer: AbortSignal): Promise<SourceResult> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([outer, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SourceResult>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      resolve({ ok: false, problem: `did not finish within ${minutes(source.timeoutMs)}` });
    }, source.timeoutMs);
  });
  const ran = source.run(signal).catch((error: unknown): SourceResult => ({
    ok: false,
    problem: error instanceof Error ? error.message : String(error),
  }));
  try {
    return await Promise.race([ran, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start every source, wait for each to finish or reach its deadline, and log
 * one line naming what each produced.
 */
export async function runSources(
  sources: readonly SourceRun[],
  ctx: { signal: AbortSignal; log: (line: string) => void },
): Promise<SourcesOutcome> {
  const results = await Promise.all(sources.map((source) => runOne(source, ctx.signal)));
  const lists: Candidate[][] = [];
  const finished: string[] = [];
  const parts: string[] = [];
  sources.forEach((source, i) => {
    const result = results[i]!;
    if (result.ok) {
      lists.push(result.candidates);
      finished.push(source.name);
      parts.push(`${source.name} ${result.candidates.length} candidate(s)`);
    } else {
      parts.push(`${source.name} failed (${result.problem})`);
    }
  });
  if (parts.length > 0) ctx.log(`sources: ${parts.join(", ")}.`);
  return { candidates: unionCandidates(lists), finished };
}
