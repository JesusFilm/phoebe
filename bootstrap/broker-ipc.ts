// The supervisor side of the concurrency broker's IPC (#59) — the adapter that
// maps an engine child's slot messages onto the in-memory `SlotBroker`.
//
// Each nested-mode engine child is spawned with an IPC channel (spawn-engine.mjs
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
  send?(message: unknown): void;
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
export function attachBroker(opts: { owner: string; broker: SlotBroker; child: BrokerChild }): void {
  const { owner, broker, child } = opts;
  child.on("message", (message) => {
    switch (messageType(message)) {
      case SLOT_ACQUIRE:
        void broker.acquire(owner).then(() => child.send?.({ type: SLOT_GRANTED }));
        break;
      case SLOT_RELEASE:
        broker.release(owner);
        break;
    }
  });
  child.on("exit", () => broker.reclaim(owner));
}
