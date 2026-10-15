// The logs pane's state, with no React in it (#73: the container keeps no logs
// of its own; these are Docker's, followed over the bridge).
//
// One bounded list of lines, the channels they came in on, where a clear left
// off, and one ending. The bound is the same one main keeps, so a pane never
// holds more than main would hand a pane opened late.

import { MAX_LOG_LINES } from "phoebe-agent/contracts";
import type { RunLine, VerbRun } from "phoebe-agent/contracts";
import { ALL_CHANNEL, channelOf, inChannel } from "./logs-channels.ts";

/**
 * Where a clear left off, per scope: an index into the lines, below which
 * nothing is drawn on any tab the scope names. `all` is the stream's own mark
 * and covers every line; a pipeline's channel covers that channel's; a
 * tenant's `<slug>:*` covers everything under the slug. No line is dropped — a
 * mark only stops one being drawn, which is also what keeps a cleared line from
 * being parsed again.
 */
export type ClearMarks = ReadonlyMap<string, number>;

export type LogsView = {
  lines: string[];
  /** Why the stream stopped, once it has; null while it runs or before it starts. */
  ended: string | null;
  /**
   * Every channel a held line arrived on, in the order each first spoke: the
   * tabs, kept beside the lines rather than read back off them. A tab a clear
   * hid still belongs here, and so does one whose lines have fallen off the
   * bound — the channel spoke on this stream, and stays a tab for the session.
   */
  channels: ReadonlySet<string>;
  /** What the operator has read and cleared, by scope. */
  marks: ClearMarks;
};

export const EMPTY_LOGS: LogsView = {
  lines: [],
  ended: null,
  channels: new Set(),
  marks: new Map(),
};

/** The lines main held when the pane joined: a fresh view, still running. */
export function logsSeeded(lines: readonly string[]): LogsView {
  const held = lines.slice(-MAX_LOG_LINES);
  return { lines: held, ended: null, channels: new Set(held.map(channelOf)), marks: new Map() };
}

/** One more line, dropping the oldest once the bound is reached. */
export function appendLogLine(view: LogsView, line: string, max = MAX_LOG_LINES): LogsView {
  const dropped = Math.max(0, view.lines.length + 1 - max);
  const lines = dropped === 0 ? [...view.lines, line] : [...view.lines.slice(dropped), line];
  return {
    ...view,
    lines,
    channels: new Set(view.channels).add(channelOf(line)),
    marks: dropped === 0 ? view.marks : shifted(view.marks, dropped),
  };
}

/** The stream stopped. The lines stay; the reason goes under them. */
export function logsEnded(view: LogsView, reason: string): LogsView {
  return { ...view, ended: reason };
}

/**
 * Read this far on this tab: a mark at the end of the lines held, for the scope
 * the open tab is. Nothing is thrown away, so the tabs stay and so does the
 * ending under them; and a mark the new one covers goes with it, having nothing
 * left to hide.
 */
export function logsCleared(view: LogsView, channel: string): LogsView {
  const marks = new Map<string, number>();
  for (const [scope, mark] of view.marks) if (!inChannel(scope, channel)) marks.set(scope, mark);
  marks.set(channel, view.lines.length);
  return { ...view, marks };
}

/**
 * The lines a tab draws: the ones on it, above the stream's mark and above
 * every channel mark that names them. So a line cleared from its own pipeline's
 * tab is gone from `all` as well — which is why `all` reads the channel off
 * each line, and only has to while a channel mark stands.
 */
export function drawnLines(view: LogsView, channel: string): string[] {
  const from = view.marks.get(ALL_CHANNEL) ?? 0;
  const scoped = [...view.marks].filter(([scope]) => scope !== ALL_CHANNEL);
  if (channel === ALL_CHANNEL && scoped.length === 0) return view.lines.slice(from);
  const drawn: string[] = [];
  for (let index = from; index < view.lines.length; index += 1) {
    const line = view.lines[index] as string;
    const on = channelOf(line);
    if (!inChannel(on, channel)) continue;
    if (scoped.some(([scope, mark]) => index < mark && inChannel(on, scope))) continue;
    drawn.push(line);
  }
  return drawn;
}

/** Every mark `dropped` lines down, floored at zero: the oldest lines are gone. */
function shifted(marks: ClearMarks, dropped: number): ClearMarks {
  const moved = new Map<string, number>();
  for (const [scope, mark] of marks) moved.set(scope, Math.max(0, mark - dropped));
  return moved;
}

/**
 * What a clear on the `cli` tab read: the run it was on, and the last line of
 * that run it covered — the line itself, not a count of them. That store is
 * bounded too (`MAX_RUN_LINES`), and a `migrate` or a build prints enough to
 * reach it, at which point a count would start naming a line that arrived
 * after the clear. `null` is a clear on a run that had printed nothing yet.
 */
export type RunMark = { runId: string; after: RunLine | null };

/**
 * The run as the `cli` tab draws it: the lines after the mark when the mark is
 * this run's, and the whole run when it is not, or when the line the mark named
 * has gone off the front — everything still held then came in after the clear.
 */
export function runDrawn(run: VerbRun, mark: RunMark | null): VerbRun {
  if (mark === null || mark.runId !== run.runId || mark.after === null) return run;
  const at = run.lines.indexOf(mark.after);
  return at === -1 ? run : { ...run, lines: run.lines.slice(at + 1) };
}
