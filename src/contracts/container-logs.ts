// A running local install's container output, followed into a side pane.
//
// The container is log-stateless by decision (#73): it writes nothing to disk,
// and what it prints goes to Docker, which keeps it. `docker compose logs` is
// the one place that output can be read back, and the companion drives Docker
// already, so the pane is `logs --follow` on the phoebe service, streamed line
// by line over the bridge. Nothing here reaches a relay; a remote deployment's
// live output is still unspecified on the map (#497).

/** How many lines main keeps per followed install, and the pane shows. */
export const MAX_LOG_LINES = 2000;

/** How far back a follow starts: the last lines Docker holds, then live. */
export const LOG_TAIL_LINES = 200;

/** One line the container printed, for the install it belongs to. */
export type LogLine = {
  /** The install's directory — its identity (#527 §12). */
  install: string;
  line: string;
};

/**
 * The stream stopped on its own: the container exited, Docker went away, or
 * Compose refused. The pane shows the reason under the lines it has and stops
 * expecting more; the next follow starts a new stream.
 */
export type LogsEnded = {
  install: string;
  reason: string;
};
