// The supervisor side of the concurrency broker's IPC (#59) — the adapter that
// maps an engine child's slot messages onto the in-memory `SlotBroker`.
//
// Each workspace-mode engine child is spawned with an IPC channel (spawn-engine.mjs
// `spawnEngineChild`) and runs `createSlotClient(process)` (src/slot-client.ts).
// This binds one child's channel to the shared broker: an acquire request blocks
// until the broker grants a slot, then the grant is sent back; a release frees
// it; and — crucially — the child's *exit* reclaims every slot it held plus any
// queued request, so a crash / OOM / drain can never permanently shrink the cap
// (#59/#72). The broker is the single fairness authority across all children.

import { SLOT_ACQUIRE, SLOT_GRANTED, SLOT_RELEASE } from "../src/slot-client.ts";
import type { SlotBroker } from "./slot-broker.ts";

/** The subset of a child process this adapter needs — injectable for tests. */
export type BrokerChild = {
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (...args: unknown[]) => void): unknown;
  /**
   * Node's real `ChildProcess.send` accepts an optional error-first callback.
   * We always pass one (see `grant`): a child can exit while its slot grant is
   * still in flight, and on Node ≥ 24 a callback-less `send` over a closed
   * channel emits an unhandled `'error'` (`ERR_IPC_CHANNEL_CLOSED`) that would
   * crash the *shared* supervisor and take every co-tenant down with it.
   */
  send?(message: unknown, callback?: (error: Error | null) => void): void;
};

function messageType(message: unknown): unknown {
  return typeof message === "object" && message !== null
    ? (message as { type?: unknown }).type
    : undefined;
}

/**
 * Wire one child's slot requests to the broker under the tenant's `owner` id.
 * Idempotent per child (call once at spawn). The grant is sent only after the
 * broker actually hands out a slot, so a child blocked behind the cap simply
 * waits — no busy-poll.
 */
export function attachBroker(opts: {
  owner: string;
  broker: SlotBroker;
  child: BrokerChild;
}): void {
  const { owner, broker, child } = opts;

  // Send the grant with an error-first callback so a child that exited while the
  // grant was queued fails here as a handled no-op instead of an unhandled
  // channel-closed `'error'` that would crash the supervisor. The child's `exit`
  // handler (below) has already — or will shortly — `reclaim` its slot, so a
  // dropped grant leaks nothing.
  const grant = (): void =>
    child.send?.({ type: SLOT_GRANTED }, (error) => {
      if (error) broker.reclaim(owner);
    });

  child.on("message", (message) => {
    switch (messageType(message)) {
      case SLOT_ACQUIRE:
        void broker.acquire(owner).then(grant);
        break;
      case SLOT_RELEASE:
        broker.release(owner);
        break;
    }
  });
  child.on("exit", () => broker.reclaim(owner));
}
