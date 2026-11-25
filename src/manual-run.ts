// Manual runs (#937, spec #924): the bootstrapper asks one engine child to run
// a kind now, rather than when its own schedule says.
//
// The ask arrives as one parent-to-child IPC message, the first message on the
// channel that flows that way unprompted. Every other one answers something
// the child sent (a slot grant, a credential). The child keeps the newest ask
// per kind in an inbox. The kind takes it in its next `fetch` through
// `ctx.takeManualRun`, and the engine's idle wait ends on arrival so that
// fetch is the next thing that happens. Only the observer kind takes one.
//
// Nothing here queues. A kind takes the ask once, and a kind that cannot run it
// then (it is already in flight) drops it. The bootstrapper refuses in that
// case before it ever sends, so a dropped ask is the narrow race between the
// report it read and the pass the child is on.

import type { ParentChannel } from "./slot-client.ts";

/** The message type on the supervisor-to-child channel. */
export const MANUAL_RUN = "phoebe:manual-run";

/** One ask to run a kind now. */
export type ManualRun = {
  /** The kind to run. */
  kind: string;
  /** Who asked: `shell` for `phoebe observe`, the session's name over the API. */
  by: string;
  /** When the bootstrapper sent it. */
  at: string;
  /** The observer's lookback for this run only; null keeps the configured one. */
  lookback: string | null;
};

/** A period like `14d` or `36h`, the shape `every` and `lookback` both take. */
const PERIOD_RE = /^(\d+)([smhdw])$/;

/** Whether `value` is a period the observer would take as its `lookback`. */
export function isPeriod(value: string): boolean {
  const match = PERIOD_RE.exec(value);
  return match !== null && Number(match[1]) > 0;
}

/** The message's run, or null for anything else on the channel. */
export function parseManualRunMessage(message: unknown): ManualRun | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record["type"] !== MANUAL_RUN) return null;
  const run = record["run"];
  if (typeof run !== "object" || run === null) return null;
  const { kind, by, at, lookback } = run as Record<string, unknown>;
  if (typeof kind !== "string" || kind.length === 0) return null;
  if (typeof by !== "string" || typeof at !== "string") return null;
  if (lookback !== null && (typeof lookback !== "string" || !isPeriod(lookback))) return null;
  return { kind, by, at, lookback };
}

export type ManualRunInbox = {
  /** The ask waiting for `kind`, removed as it is read. */
  take: (kind: string) => ManualRun | null;
  /** Called on every ask the inbox keeps. Returns the unsubscribe. */
  onArrival: (listener: () => void) => () => void;
};

/**
 * The inbox on this process's IPC channel, or null with no channel: an engine
 * nobody supervises has nobody to ask it for a run. An ask for a kind this
 * pipeline does not schedule is logged and dropped, since no fetch would ever
 * take it.
 */
export function createManualRunInbox(
  parent: ParentChannel,
  opts: { schedules: (kind: string) => boolean; log: (line: string) => void },
): ManualRunInbox | null {
  if (typeof parent.on !== "function") return null;
  const waiting = new Map<string, ManualRun>();
  const listeners = new Set<() => void>();
  parent.on("message", (message) => {
    const run = parseManualRunMessage(message);
    if (run === null) return;
    if (!opts.schedules(run.kind)) {
      opts.log(
        `Manual ${run.kind} run asked for by ${run.by} dropped: this pipeline does not run ${run.kind}.`,
      );
      return;
    }
    waiting.set(run.kind, run);
    opts.log(`Manual ${run.kind} run asked for by ${run.by}.`);
    for (const listener of listeners) listener();
  });
  return {
    take(kind) {
      const run = waiting.get(kind) ?? null;
      waiting.delete(kind);
      return run;
    },
    onArrival(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
