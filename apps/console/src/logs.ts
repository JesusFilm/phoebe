// The logs pane's state, with no React in it (#73: the container keeps no logs
// of its own; these are Docker's, followed over the bridge).
//
// One bounded list of lines and one ending. The bound is the same one main
// keeps, so a pane never holds more than main would hand a pane opened late.

import { MAX_LOG_LINES } from "phoebe-agent/contracts";

export type LogsView = {
  lines: string[];
  /** Why the stream stopped, once it has; null while it runs or before it starts. */
  ended: string | null;
};

export const EMPTY_LOGS: LogsView = { lines: [], ended: null };

/** The lines main held when the pane joined: a fresh view, still running. */
export function logsSeeded(lines: readonly string[]): LogsView {
  return { lines: lines.slice(-MAX_LOG_LINES), ended: null };
}

/** One more line, dropping the oldest once the bound is reached. */
export function appendLogLine(view: LogsView, line: string, max = MAX_LOG_LINES): LogsView {
  const lines =
    view.lines.length >= max ? [...view.lines.slice(1 - max), line] : [...view.lines, line];
  return { ...view, lines };
}

/** The stream stopped. The lines stay; the reason goes under them. */
export function logsEnded(view: LogsView, reason: string): LogsView {
  return { ...view, ended: reason };
}
