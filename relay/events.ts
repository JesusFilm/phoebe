// The relay's event hub: where a fact learned on a socket meets the browsers
// watching for it (#542, decided in #506 §10).
//
// **One stream, in memory, no replay.** A subscriber gets what happens from the
// moment it subscribes. There is no buffer to catch up from and no sequence
// number to resume at, because there is a `GET` behind every event that answers
// the same question completely: a page that missed something re-reads
// `/api/deployments` and is whole again. Buffering would be a second, worse
// copy of the state the files already hold.
//
// **A listener that throws is a listener that is dropped, not a relay that
// falls over.** The listeners here are HTTP responses, and a response whose
// socket died between the emit and the write throws on the write. That is one
// browser leaving, and it must not reach the deployment whose report is being
// announced.

import type { RelayEvent } from "../src/contracts/relay-events.ts";

/** What the relay's own machinery holds: somewhere to put an event. */
export type RelayEventSink = {
  /** Announce one event to everyone watching. Never throws at the caller. */
  emit: (event: RelayEvent) => void;
};

export type RelayEvents = RelayEventSink & {
  /** Watch the stream. Call what comes back to stop watching. */
  subscribe: (listener: (event: RelayEvent) => void) => () => void;
  /** How many streams are open — what a test asserts on and a log line counts. */
  watching: () => number;
};

export type RelayEventsOptions = {
  /** Where a listener's failure is reported. Defaults to silence. */
  warn?: (message: string) => void;
};

/** Build the hub. One per relay process; nothing about it is per-request. */
export function createRelayEvents(options: RelayEventsOptions = {}): RelayEvents {
  const warn = options.warn ?? (() => {});
  const listeners = new Set<(event: RelayEvent) => void>();

  return {
    emit(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          listeners.delete(listener);
          warn(
            `[phoebe:relay] dropped an event listener: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    watching: () => listeners.size,
  };
}
