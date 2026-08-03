// The engine's side of the concurrency broker (#59) — the client half of the
// supervisor's slot semaphore (bootstrap/slot-broker.ts).
//
// In a multi-tenant deployment the supervisor spawns each engine child with an
// IPC channel and brokers a global cap on concurrently-executing work units.
// After an engine has selected a workable unit it requests a slot, blocks until
// the supervisor grants one, executes the whole unit (worktree + install +
// agent + test + push) holding the slot, and releases it when the unit finishes
// — release bracketed by the same `try/finally` that owns worktree cleanup, so
// timeout, error, and normal completion share one leak-free release path (#72).
//
// A standalone engine — dev / local-mount / `--run-once`, spawned without an IPC
// channel — has no supervisor to ask and is already serialized to one unit, so
// it runs *unbrokered*: `createSlotClient` returns null and the loop proceeds
// exactly as it does today. The channel's presence is the only thing that
// distinguishes the two, so the same engine binary works in both worlds.

/** Message types on the supervisor↔child IPC channel. */
export const SLOT_ACQUIRE = "phoebe:slot:acquire";
export const SLOT_GRANTED = "phoebe:slot:granted";
export const SLOT_RELEASE = "phoebe:slot:release";

/** The subset of `process` the client needs — injectable so it is unit-tested. */
export type ParentChannel = {
  send?: (message: unknown) => void;
  on?: (event: "message" | "disconnect", listener: (message: unknown) => void) => void;
  off?: (event: "message" | "disconnect", listener: (message: unknown) => void) => void;
  connected?: boolean;
};

export type SlotClient = {
  /**
   * Request a slot; resolves when the supervisor grants one, and **rejects**
   * with `BrokerDisconnectedError` if the IPC channel closes first.
   */
  acquire(): Promise<void>;
  /** Release the held slot back to the supervisor. */
  release(): void;
};

/**
 * The supervisor's IPC channel closed while an `acquire` was outstanding. The
 * engine must not proceed to run the unit — with the broker gone it would run
 * *unbrokered* and, in a fleet, every child would do the same at once and blow
 * past `PHOEBE_MAX_CONCURRENT_AGENTS`. The engine loop treats this as a clean
 * stop (the supervisor either died — the container is going down — or will
 * respawn the child, which re-establishes the channel).
 */
export class BrokerDisconnectedError extends Error {
  constructor() {
    super("supervisor IPC channel disconnected before a slot was granted");
    this.name = "BrokerDisconnectedError";
  }
}

function isGrant(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === SLOT_GRANTED
  );
}

/**
 * Build a slot client bound to the parent IPC channel, or null when there is no
 * channel (a standalone engine — run unbrokered). The engine works one unit at
 * a time, so at most one acquire is ever outstanding per child: a single grant
 * message settles it, and the listener is removed as soon as it fires.
 *
 * `acquire` also settles on channel `disconnect` — by **rejecting** with
 * `BrokerDisconnectedError`. Without settling at all, a supervisor that dies (or
 * is torn down) between the request and the grant would leave the promise
 * pending forever, and the loop `await`s it *before* the run deadline is armed
 * (src/main.ts) — a silent stall. Rejecting (rather than resolving) means the
 * engine stops instead of running the unit unbrokered: with the broker gone, a
 * fleet of children would otherwise all proceed at once and bypass the global
 * concurrency cap. The caller catches it and exits cleanly.
 */
export function createSlotClient(proc: ParentChannel): SlotClient | null {
  if (typeof proc.send !== "function" || proc.connected === false) return null;
  const send = proc.send.bind(proc);
  return {
    acquire(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const onMessage = (message: unknown): void => {
          if (!isGrant(message)) return;
          cleanup();
          resolve();
        };
        const onDisconnect = (): void => {
          cleanup();
          reject(new BrokerDisconnectedError());
        };
        const cleanup = (): void => {
          proc.off?.("message", onMessage);
          proc.off?.("disconnect", onDisconnect);
        };
        proc.on?.("message", onMessage);
        proc.on?.("disconnect", onDisconnect);
        send({ type: SLOT_ACQUIRE });
      });
    },
    release(): void {
      send({ type: SLOT_RELEASE });
    },
  };
}
