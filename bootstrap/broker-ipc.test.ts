// Broker IPC adapter tests (#59): a child's acquire/release messages drive the
// shared broker, grants are sent back, and exit reclaims the child's slots.

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
    const broker = createSlotBroker(1);
    const child = fakeChild();
    attachBroker({ owner: "acme/widget", broker, child });

    child.emitMessage({ type: SLOT_ACQUIRE });
    await tick();
    expect(child.sent).toEqual([{ type: SLOT_GRANTED }]);
    expect(broker.inUse).toBe(1);
  });

  test("a release frees the child's slot", async () => {
    const broker = createSlotBroker(1);
    const child = fakeChild();
    attachBroker({ owner: "acme/widget", broker, child });
    child.emitMessage({ type: SLOT_ACQUIRE });
    await tick();
    child.emitMessage({ type: SLOT_RELEASE });
    expect(broker.inUse).toBe(0);
  });

  test("two children share the cap; the second waits until the first releases", async () => {
    const broker = createSlotBroker(1);
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
    const broker = createSlotBroker(1);
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
});
