// Slot broker tests (#59/#407): the counting semaphore that bounds concurrent
// work units across N pipelines, the cap it derives from those pipelines, the bounded
// floor that lets a starved pipeline over that cap, and the priority ordering that
// decides who is served next.

import { describe, expect, test } from "vite-plus/test";
import {
  createSlotBroker,
  describeCap,
  DEFAULT_SLOT_FLOOR_BUDGET,
  resolveEffectiveCap,
  resolveFloorBudget,
  type BrokerPipeline,
  type OverGrantEvent,
} from "./slot-broker.ts";

/** A settled marker so tests can assert which acquisitions have been granted. */
function tracked(promise: Promise<void>): { granted: () => boolean } {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return { granted: () => done };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A pipeline of tenant `<owner>#<pipeline>`, at the given concurrency and priority. */
function pipeline(id: string, concurrency = 1, priority = 0): BrokerPipeline {
  return { id, tenantId: id.split("#")[0]!, priority, concurrency, label: id };
}

describe("resolveEffectiveCap", () => {
  test("derives max(declared concurrency) across the live pipelines", () => {
    const cap = resolveEffectiveCap(
      [pipeline("a#work"), pipeline("b#work"), pipeline("c#work", 4)],
      {},
    );
    expect(cap.capacity).toBe(4);
    expect(cap.source).toBe("derived");
    expect(cap.from).toEqual(["c#work"]);
    expect(cap.clamped).toEqual([]);
  });

  test("today's fleet — every pipeline at 1 — still derives 1", () => {
    expect(resolveEffectiveCap([pipeline("a#work"), pipeline("b#work")], {}).capacity).toBe(1);
    expect(resolveEffectiveCap([], {}).capacity).toBe(1);
  });

  test("the env replaces the derivation absolutely, even when lower", () => {
    const cap = resolveEffectiveCap(
      [pipeline("a#work"), pipeline("b#work"), pipeline("c#work", 4)],
      {
        PHOEBE_MAX_CONCURRENT_AGENTS: "2",
      },
    );
    expect(cap.capacity).toBe(2);
    expect(cap.source).toBe("env");
    expect(cap.declared).toBe(4);
    // The over-cap pipeline is not clamped locally — it queues, and it is named.
    expect(cap.clamped).toEqual([{ label: "c#work", concurrency: 4 }]);
    expect(describeCap(cap, 1)).toContain("PHOEBE_MAX_CONCURRENT_AGENTS=2");
    expect(describeCap(cap, 1)).toContain("c#work(4)");
    expect(describeCap(cap, 1)).toContain("floorBudget=1");
  });

  test("a garbage or < 1 override is no override at all", () => {
    for (const value of ["0", "2.5", "lots", ""]) {
      const cap = resolveEffectiveCap([pipeline("a#work", 3)], {
        PHOEBE_MAX_CONCURRENT_AGENTS: value,
      });
      expect(cap.capacity).toBe(3);
      expect(cap.source).toBe("derived");
    }
  });

  test("the derivation line names the pipelines it took the max from", () => {
    const cap = resolveEffectiveCap([pipeline("a#work", 2), pipeline("b#work", 2)], {});
    expect(describeCap(cap, 1)).toBe(
      "slot cap 2 — max(concurrency)=2 from a#work, b#work; floorBudget=1",
    );
  });
});

describe("resolveFloorBudget", () => {
  test("defaults to 1", () => {
    expect(resolveFloorBudget({})).toBe(DEFAULT_SLOT_FLOOR_BUDGET);
    expect(DEFAULT_SLOT_FLOOR_BUDGET).toBe(1);
  });
  test("0 is a valid answer — a hard ceiling", () => {
    expect(resolveFloorBudget({ PHOEBE_SLOT_FLOOR_BUDGET: "0" })).toBe(0);
    expect(resolveFloorBudget({ PHOEBE_SLOT_FLOOR_BUDGET: "3" })).toBe(3);
  });
  test("negative, non-integer and garbage fall back to the default", () => {
    expect(resolveFloorBudget({ PHOEBE_SLOT_FLOOR_BUDGET: "-1" })).toBe(1);
    expect(resolveFloorBudget({ PHOEBE_SLOT_FLOOR_BUDGET: "1.5" })).toBe(1);
    expect(resolveFloorBudget({ PHOEBE_SLOT_FLOOR_BUDGET: "some" })).toBe(1);
  });
});

describe("createSlotBroker", () => {
  /** A broker with the floor switched off, so what is under test is the cap. */
  const capped = (capacity: number) => createSlotBroker({ capacity, floorBudget: 0 });

  test("grants up to capacity immediately, queues the rest", async () => {
    const broker = capped(1);
    const a = tracked(broker.acquire("A"));
    const b = tracked(broker.acquire("B"));
    await tick();
    expect(a.granted()).toBe(true);
    expect(b.granted()).toBe(false);
    expect(broker.inUse).toBe(1);
    expect(broker.waiting).toBe(1);
  });

  test("releasing hands the slot to the next FIFO waiter", async () => {
    const broker = capped(1);
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

  test("re-request after release goes to the back of the queue", async () => {
    const broker = capped(1);
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
    const broker = capped(2);
    await broker.acquire("A");
    await broker.acquire("B");
    expect(broker.inUse).toBe(2);
    broker.release("A");
    expect(broker.inUse).toBe(1);
    broker.release("B");
    expect(broker.inUse).toBe(0);
  });

  test("a spurious release cannot over-grant", async () => {
    const broker = capped(1);
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
    const broker = capped(2);
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
    const broker = capped(0);
    expect(broker.capacity).toBe(1);
    const a = tracked(broker.acquire("A"));
    await tick();
    expect(a.granted()).toBe(true);
  });

  test("one pipeline may hold several slots at once", async () => {
    const broker = capped(3);
    const first = tracked(broker.acquire("a#work"));
    const second = tracked(broker.acquire("a#work"));
    const third = tracked(broker.acquire("a#work"));
    const fourth = tracked(broker.acquire("a#work"));
    await tick();
    expect([first.granted(), second.granted(), third.granted()]).toEqual([true, true, true]);
    expect(fourth.granted()).toBe(false);
    expect(broker.inUse).toBe(3);
  });
});

describe("the slot floor", () => {
  test("a starved pipeline is granted over the cap, one budget unit at a time", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 1 });
    await broker.acquire("a#work"); // a long unit holds the only slot
    const b = tracked(broker.acquire("b#intake"));
    const c = tracked(broker.acquire("c#intake"));
    await tick();
    // B held zero slots with work waiting — starved, so it goes over the cap.
    expect(b.granted()).toBe(true);
    expect(broker.inUse).toBe(2);
    expect(broker.overGranted).toBe(1);
    // C is starved too, but the budget is spent: it waits for it to free.
    expect(c.granted()).toBe(false);

    broker.release("b#intake"); // the over-grant comes back first
    await tick();
    expect(broker.overGranted).toBe(1); // ... and went straight to C
    expect(c.granted()).toBe(true);
    expect(broker.inUse).toBe(2);
  });

  test("floorBudget 0 is a hard ceiling", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    await broker.acquire("a#work");
    const b = tracked(broker.acquire("b#intake"));
    await tick();
    expect(b.granted()).toBe(false);
    expect(broker.inUse).toBe(1);
  });

  test("a pipeline already holding a slot is not starved, however long it waits", async () => {
    const broker = createSlotBroker({ capacity: 2, floorBudget: 1 });
    await broker.acquire("a#work");
    await broker.acquire("a#work"); // A holds both slots — wants throughput
    const more = tracked(broker.acquire("a#work"));
    await tick();
    expect(more.granted()).toBe(false);
    expect(broker.overGranted).toBe(0);
  });

  test("a release while over cap lowers inUse without waking a waiter", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 1 });
    await broker.acquire("a#work"); // the cap's one slot
    await broker.acquire("b#intake"); // over the cap, on the floor
    const c = tracked(broker.acquire("c#work"));
    await tick();
    expect(broker.inUse).toBe(2);
    expect(c.granted()).toBe(false);

    // A's release is a regular slot: in use falls back to the cap, and the
    // breach is not rolled forward onto C.
    broker.release("a#work");
    await tick();
    expect(broker.inUse).toBe(1);
    expect(c.granted()).toBe(false);

    // B's release returns the over-grant, and now the ceiling has room.
    broker.release("b#intake");
    await tick();
    expect(c.granted()).toBe(true);
    expect(broker.inUse).toBe(1);
    expect(broker.overGranted).toBe(0);
  });

  test("reclaiming a dead pipeline restores the floor budget it held", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 1 });
    await broker.acquire("a#work");
    await broker.acquire("b#intake"); // over the cap
    const c = tracked(broker.acquire("c#intake"));
    await tick();
    expect(c.granted()).toBe(false);

    broker.reclaim("b#intake"); // the over-granted pipeline is killed
    await tick();
    expect(broker.overGranted).toBe(1); // the budget freed, and C took it
    expect(c.granted()).toBe(true);
    expect(broker.inUse).toBe(2);
  });

  test("over-grants are reported at grant and at consumption", async () => {
    const granted: OverGrantEvent[] = [];
    const returned: OverGrantEvent[] = [];
    const broker = createSlotBroker({
      capacity: 1,
      floorBudget: 1,
      onOverGrant: (event) => granted.push(event),
      onOverGrantReturned: (event) => returned.push(event),
    });
    broker.setPipelines([pipeline("a#work"), pipeline("b#intake")]);
    await broker.acquire("a#work");
    await broker.acquire("b#intake");
    expect(granted).toEqual([
      {
        owner: "b#intake",
        label: "b#intake",
        inUse: 2,
        capacity: 1,
        outstanding: 1,
        floorBudget: 1,
      },
    ]);

    broker.release("b#intake");
    expect(returned).toEqual([
      {
        owner: "b#intake",
        label: "b#intake",
        inUse: 1,
        capacity: 1,
        outstanding: 0,
        floorBudget: 1,
      },
    ]);
  });
});

describe("waiter ordering", () => {
  test("priority picks among one tenant's waiting pipelines, higher first", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    broker.setPipelines([
      pipeline("a#work"),
      pipeline("a#quiet", 1, 0),
      pipeline("a#urgent", 1, 5),
    ]);
    await broker.acquire("a#work");
    const quiet = tracked(broker.acquire("a#quiet")); // queued first
    const urgent = tracked(broker.acquire("a#urgent")); // queued second, ranks higher
    await tick();

    broker.release("a#work");
    await tick();
    expect(urgent.granted()).toBe(true);
    expect(quiet.granted()).toBe(false);

    broker.release("a#urgent");
    await tick();
    expect(quiet.granted()).toBe(true);
  });

  test("priority is read at grant time, so an edit needs no queue surgery", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    broker.setPipelines([pipeline("a#work"), pipeline("a#one"), pipeline("a#two")]);
    await broker.acquire("a#work");
    const one = tracked(broker.acquire("a#one")); // queued first
    const two = tracked(broker.acquire("a#two"));
    await tick();

    // The operator raises `a#two`'s priority while both are already waiting.
    broker.setPipelines([pipeline("a#work"), pipeline("a#one"), pipeline("a#two", 1, 3)]);
    broker.release("a#work");
    await tick();
    expect(two.granted()).toBe(true);
    expect(one.granted()).toBe(false);
  });

  test("cross-tenant order is the queue's own, whatever a tenant declares", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    // B declares priority 9 — tenant-local, so it buys nothing against A.
    broker.setPipelines([pipeline("holder#work"), pipeline("a#work"), pipeline("b#work", 1, 9)]);
    await broker.acquire("holder#work");
    const a = tracked(broker.acquire("a#work")); // queued first
    const b = tracked(broker.acquire("b#work"));
    await tick();

    broker.release("holder#work");
    await tick();
    expect(a.granted()).toBe(true);
    expect(b.granted()).toBe(false);
  });

  test("a tenant holding the two oldest waiters is served for both", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    broker.setPipelines([pipeline("holder#work"), pipeline("a#work", 2), pipeline("b#work")]);
    await broker.acquire("holder#work");
    // Rolling top-up: one pipeline queues two units in a single pass, ahead of B.
    const first = tracked(broker.acquire("a#work"));
    const second = tracked(broker.acquire("a#work"));
    const b = tracked(broker.acquire("b#work"));
    await tick();

    broker.release("holder#work");
    await tick();
    expect([first.granted(), second.granted(), b.granted()]).toEqual([true, false, false]);

    // Nothing rotates: A's second waiter asked before B, so it takes the slot.
    broker.release("a#work");
    await tick();
    expect([second.granted(), b.granted()]).toEqual([true, false]);

    broker.release("a#work");
    await tick();
    expect(b.granted()).toBe(true);
  });

  test("the floor, not the order, moves a tenant queued behind another's waiters", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 1 });
    broker.setPipelines([pipeline("a#work", 2), pipeline("b#work")]);
    await broker.acquire("a#work"); // A holds the cap's only slot
    const second = tracked(broker.acquire("a#work")); // and queues a second unit
    const b = tracked(broker.acquire("b#work")); // B asks last, behind that waiter
    await tick();

    // B holds no slot at all, so the floor grants it one over the cap. A's own
    // second waiter is not starved, and waits for the cap to free.
    expect([second.granted(), b.granted()]).toEqual([false, true]);
  });

  test("the floor budget is allocated by the same ordering", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 1 });
    broker.setPipelines([
      pipeline("a#work"),
      pipeline("a#quiet"),
      pipeline("a#urgent", 1, 5),
      pipeline("z#work"),
    ]);
    await broker.acquire("a#work"); // the cap's slot, held long
    await broker.acquire("z#work"); // starved first, so it holds the budget
    const quiet = tracked(broker.acquire("a#quiet")); // starved, queued first
    const urgent = tracked(broker.acquire("a#urgent")); // starved, ranks higher
    await tick();
    expect([quiet.granted(), urgent.granted()]).toEqual([false, false]);

    // The budget frees with both waiting: it goes by the queue's own ordering,
    // not by which of them asked first.
    broker.release("z#work");
    await tick();
    expect(urgent.granted()).toBe(true);
    expect(quiet.granted()).toBe(false);
  });

  test("the floor's entitlement is immediate — the first starved pipeline asking takes it", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 1 });
    broker.setPipelines([pipeline("a#work"), pipeline("a#quiet"), pipeline("a#urgent", 1, 5)]);
    await broker.acquire("a#work");
    const quiet = tracked(broker.acquire("a#quiet"));
    await tick();
    // Nothing else was contending when it asked, so it goes over the cap now
    // rather than waiting for a higher-priority sibling that may never ask.
    expect(quiet.granted()).toBe(true);
    const urgent = tracked(broker.acquire("a#urgent"));
    await tick();
    expect(urgent.granted()).toBe(false);
  });

  test("an undescribed owner is its own tenant at priority 0", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    await broker.acquire("first");
    const second = tracked(broker.acquire("second"));
    const third = tracked(broker.acquire("third"));
    await tick();
    broker.release("first");
    await tick();
    expect(second.granted()).toBe(true);
    expect(third.granted()).toBe(false);
  });
});

describe("setCapacity", () => {
  test("a raised cap hands waiting pipelines their slots", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    await broker.acquire("a#work");
    const b = tracked(broker.acquire("b#work"));
    await tick();
    expect(b.granted()).toBe(false);

    broker.setCapacity(3);
    await tick();
    expect(b.granted()).toBe(true);
    expect(broker.capacity).toBe(3);
  });

  test("a shrunk cap recalls nothing; in use falls back to the ceiling", async () => {
    const broker = createSlotBroker({ capacity: 3, floorBudget: 0 });
    await broker.acquire("a#work");
    await broker.acquire("a#work");
    await broker.acquire("a#work");
    const b = tracked(broker.acquire("b#work"));

    broker.setCapacity(1);
    await tick();
    expect(broker.inUse).toBe(3); // granted slots are never recalled
    expect(b.granted()).toBe(false);

    broker.release("a#work");
    broker.release("a#work");
    await tick();
    expect(b.granted()).toBe(false); // still at the ceiling
    broker.release("a#work");
    await tick();
    expect(b.granted()).toBe(true);
  });
});
