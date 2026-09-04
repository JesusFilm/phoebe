// Broker IPC adapter tests (#59): a child's acquire/release messages drive the
// shared broker, grants are sent back, and exit reclaims the child's slots.
//
// The cap tests build the broker with `floorBudget: 0` — a hard ceiling — so
// what they assert is the cap and not the slot floor (#407), which has its own
// test at the bottom.

import { describe, expect, test } from "vite-plus/test";
import { SLOT_ACQUIRE, SLOT_GRANTED, SLOT_RELEASE } from "../src/slot-client.ts";
import { attachBroker, type BrokerChild } from "./broker-ipc.ts";
import { createSlotBroker } from "./slot-broker.ts";

function fakeChild(): BrokerChild & {
  emitMessage: (m: unknown) => void;
  emitExit: () => void;
  sent: unknown[];
} {
  const messageListeners: Array<(m: unknown) => void> = [];
  const exitListeners: Array<() => void> = [];
  const sent: unknown[] = [];
  return {
    on: (event, listener) => {
      if (event === "message") messageListeners.push(listener as (m: unknown) => void);
      else exitListeners.push(listener as () => void);
    },
    send: (message) => sent.push(message),
    emitMessage: (m) => messageListeners.forEach((l) => l(m)),
    emitExit: () => exitListeners.forEach((l) => l()),
    sent,
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("attachBroker", () => {
  test("an acquire request is granted (and a message sent back) when a slot is free", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    const child = fakeChild();
    attachBroker({ owner: "acme/widget", broker, child });

    child.emitMessage({ type: SLOT_ACQUIRE });
    await tick();
    expect(child.sent).toEqual([{ type: SLOT_GRANTED }]);
    expect(broker.inUse).toBe(1);
  });

  test("a release frees the child's slot", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    const child = fakeChild();
    attachBroker({ owner: "acme/widget", broker, child });
    child.emitMessage({ type: SLOT_ACQUIRE });
    await tick();
    child.emitMessage({ type: SLOT_RELEASE });
    expect(broker.inUse).toBe(0);
  });

  test("two children share the cap; the second waits until the first releases", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    const a = fakeChild();
    const b = fakeChild();
    attachBroker({ owner: "a", broker, child: a });
    attachBroker({ owner: "b", broker, child: b });

    a.emitMessage({ type: SLOT_ACQUIRE });
    b.emitMessage({ type: SLOT_ACQUIRE });
    await tick();
    expect(a.sent).toEqual([{ type: SLOT_GRANTED }]);
    expect(b.sent).toEqual([]); // blocked behind the cap

    a.emitMessage({ type: SLOT_RELEASE });
    await tick();
    expect(b.sent).toEqual([{ type: SLOT_GRANTED }]);
  });

  test("a child's exit reclaims its held slot for waiters", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    const a = fakeChild();
    const b = fakeChild();
    attachBroker({ owner: "a", broker, child: a });
    attachBroker({ owner: "b", broker, child: b });
    a.emitMessage({ type: SLOT_ACQUIRE });
    b.emitMessage({ type: SLOT_ACQUIRE });
    await tick();
    expect(b.sent).toEqual([]);

    a.emitExit(); // crash while holding the slot
    await tick();
    expect(b.sent).toEqual([{ type: SLOT_GRANTED }]);
  });

  test("a grant onto a closed channel reclaims the slot instead of leaking it", async () => {
    // The child exited while its grant was in flight: `send` reports the closed
    // channel via its error-first callback (Node's ERR_IPC_CHANNEL_CLOSED),
    // which must free the slot for the next waiter — and never throw.
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    const gone = fakeChild();
    // Override send to simulate a closed IPC channel: invoke the callback with
    // an error (and record nothing sent).
    (gone as { send: BrokerChild["send"] }).send = (_message, callback) =>
      callback?.(new Error("channel closed"));
    const b = fakeChild();
    attachBroker({ owner: "gone", broker, child: gone });
    attachBroker({ owner: "b", broker, child: b });

    gone.emitMessage({ type: SLOT_ACQUIRE }); // acquires slot 1, grant fails closed
    b.emitMessage({ type: SLOT_ACQUIRE }); // queued behind it
    await tick();

    // The failed grant reclaimed the slot, so b was granted rather than starved.
    expect(b.sent).toEqual([{ type: SLOT_GRANTED }]);
  });

  test("a child with three pending acquires gets three untagged grants", async () => {
    // Grants are fungible: the wire carries no correlation id, and the client
    // resolves its own FIFO (src/slot-client.ts).
    const broker = createSlotBroker({ capacity: 3, floorBudget: 0 });
    const child = fakeChild();
    attachBroker({ owner: "a#work", broker, child });

    child.emitMessage({ type: SLOT_ACQUIRE });
    child.emitMessage({ type: SLOT_ACQUIRE });
    child.emitMessage({ type: SLOT_ACQUIRE });
    await tick();
    expect(child.sent).toEqual([
      { type: SLOT_GRANTED },
      { type: SLOT_GRANTED },
      { type: SLOT_GRANTED },
    ]);
    expect(broker.inUse).toBe(3);
  });

  test("a starved child is granted over the cap, and its exit restores the budget", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 1 });
    const a = fakeChild();
    const b = fakeChild();
    const c = fakeChild();
    attachBroker({ owner: "a#work", broker, child: a });
    attachBroker({ owner: "b#intake", broker, child: b });
    attachBroker({ owner: "c#intake", broker, child: c });

    a.emitMessage({ type: SLOT_ACQUIRE }); // takes the only slot, holds it long
    b.emitMessage({ type: SLOT_ACQUIRE }); // starved → the floor grants over cap
    c.emitMessage({ type: SLOT_ACQUIRE }); // starved too, but the budget is spent
    await tick();
    expect(b.sent).toEqual([{ type: SLOT_GRANTED }]);
    expect(c.sent).toEqual([]);
    expect(broker.inUse).toBe(2);

    b.emitExit(); // the over-granted child dies
    await tick();
    expect(c.sent).toEqual([{ type: SLOT_GRANTED }]); // its budget came back
    expect(broker.inUse).toBe(2);
  });
});
