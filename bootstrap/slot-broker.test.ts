// Slot broker tests (#59): the FIFO counting semaphore that bounds concurrent
// work units across N engine children, and reclaims a dead child's slots.

import { describe, expect, test } from "vite-plus/test";
import { createSlotBroker, DEFAULT_MAX_CONCURRENT, resolveMaxConcurrent } from "./slot-broker.ts";

/** A settled marker so tests can assert which acquisitions have been granted. */
function tracked(promise: Promise<void>): { granted: () => boolean } {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return { granted: () => done };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("resolveMaxConcurrent", () => {
  test("defaults to 1", () => {
    expect(resolveMaxConcurrent({})).toBe(DEFAULT_MAX_CONCURRENT);
    expect(DEFAULT_MAX_CONCURRENT).toBe(1);
  });
  test("reads a valid override", () => {
    expect(resolveMaxConcurrent({ PHOEBE_MAX_CONCURRENT_AGENTS: "3" })).toBe(3);
  });
  test("rejects < 1, non-integer, and garbage", () => {
    expect(resolveMaxConcurrent({ PHOEBE_MAX_CONCURRENT_AGENTS: "0" })).toBe(1);
    expect(resolveMaxConcurrent({ PHOEBE_MAX_CONCURRENT_AGENTS: "2.5" })).toBe(1);
    expect(resolveMaxConcurrent({ PHOEBE_MAX_CONCURRENT_AGENTS: "lots" })).toBe(1);
  });
});

describe("createSlotBroker", () => {
  test("grants up to capacity immediately, queues the rest", async () => {
    const broker = createSlotBroker(1);
    const a = tracked(broker.acquire("A"));
    const b = tracked(broker.acquire("B"));
    await tick();
    expect(a.granted()).toBe(true);
    expect(b.granted()).toBe(false);
    expect(broker.inUse).toBe(1);
    expect(broker.waiting).toBe(1);
  });

  test("releasing hands the slot to the next FIFO waiter", async () => {
    const broker = createSlotBroker(1);
    void broker.acquire("A");
    const b = tracked(broker.acquire("B"));
    const c = tracked(broker.acquire("C"));
    await tick();
    expect(b.granted()).toBe(false);

    broker.release("A");
    await tick();
    expect(b.granted()).toBe(true); // B was ahead of C
    expect(c.granted()).toBe(false);
    expect(broker.inUse).toBe(1);
  });

  test("re-request after release goes to the back of the queue (round-robin)", async () => {
    const broker = createSlotBroker(1);
    await broker.acquire("A"); // A holds the only slot
    const b = tracked(broker.acquire("B"));
    broker.release("A");
    const aAgain = tracked(broker.acquire("A")); // A re-requests immediately
    await tick();
    // The freed slot went to B (ahead), not back to A.
    expect(b.granted()).toBe(true);
    expect(aAgain.granted()).toBe(false);
  });

  test("inUse falls when a slot is released with no waiters", async () => {
    const broker = createSlotBroker(2);
    await broker.acquire("A");
    await broker.acquire("B");
    expect(broker.inUse).toBe(2);
    broker.release("A");
    expect(broker.inUse).toBe(1);
    broker.release("B");
    expect(broker.inUse).toBe(0);
  });

  test("a spurious release cannot over-grant", async () => {
    const broker = createSlotBroker(1);
    await broker.acquire("A");
    broker.release("A");
    broker.release("A"); // double release — must be a no-op
    const b = tracked(broker.acquire("B"));
    const c = tracked(broker.acquire("C"));
    await tick();
    expect(b.granted()).toBe(true);
    expect(c.granted()).toBe(false); // capacity still 1
    expect(broker.inUse).toBe(1);
  });

  test("reclaim releases all of a dead child's slots and drops its queued waits", async () => {
    const broker = createSlotBroker(2);
    await broker.acquire("A");
    await broker.acquire("A"); // A holds both slots
    const b = tracked(broker.acquire("B"));
    const aQueued = tracked(broker.acquire("A")); // A also has a queued request
    await tick();
    expect(b.granted()).toBe(false);

    broker.reclaim("A");
    await tick();
    expect(b.granted()).toBe(true); // one reclaimed slot went to B
    expect(aQueued.granted()).toBe(false); // A's queued request was dropped
    expect(broker.inUse).toBe(1); // B holds one; the other is free
  });

  test("capacity is clamped to at least 1", async () => {
    const broker = createSlotBroker(0);
    expect(broker.capacity).toBe(1);
    const a = tracked(broker.acquire("A"));
    await tick();
    expect(a.granted()).toBe(true);
  });
});
