// The kind interface itself: `boxKind`'s Data/Unit erasure (fetch -> gather ->
// plan -> execute), and the loop's generic cross-kind helpers
// (`oneShotEligible`, `pickFirstPlan`, `pickFirstIdleReason`) — the successors
// to `selectFirstWorkUnit`/`WORK_KIND_ONE_SHOT_ELIGIBLE`/`oneShotWorkKinds`,
// now exercised against synthetic kinds rather than real GitHub-shaped data.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef } from "../branded.ts";
import type { CycleContext } from "../cycle.ts";
import {
  boxKind,
  oneShotEligible,
  pickFirstIdleReason,
  pickFirstPlan,
  type Gathered,
  type KindHandle,
  type UnitRef,
  type WorkKind,
} from "./kind.ts";

function fakeCtx(): CycleContext {
  return {
    mainHead: "" as never,
    openPrs: [],
    login: async () => "phoebe-bot",
    pools: { ready: [], research: [] },
    issueBodies: new Map(),
    blockerStates: new Map(),
    nativeBlockers: new Map(),
    runtimeId: "runtime-1",
  };
}

/** A synthetic PR-shaped kind: `fetch` always returns the same optional number, `select` picks it. */
function fakeKind(opts: {
  name: UnitRef["kind"];
  oneShot?: boolean;
  prNumber: number | null;
  idleReason?: string | null;
}): KindHandle {
  const kind: WorkKind<number | null, number> = {
    name: opts.name,
    oneShot: opts.oneShot ?? false,
    fetch: async () => opts.prNumber,
    select: (data) => data,
    run: async () => ({ exitCode: null }),
    refFor: (unit) => ({
      kind: opts.name,
      target: { type: "pr", number: unit },
      branch: asBranchRef(`phoebe/pr-${unit}`),
    }),
    describeIdle: () => opts.idleReason ?? null,
  };
  return boxKind(kind);
}

async function gatherAll(kinds: readonly KindHandle[], ctx: CycleContext): Promise<Gathered[]> {
  const out: Gathered[] = [];
  for (const kind of kinds) {
    out.push(await kind.gather(ctx));
  }
  return out;
}

describe("boxKind", () => {
  test("erases Data/Unit: gather -> plan -> execute round-trips through fetch/select/run/refFor", async () => {
    const runCalls: number[] = [];
    const kind: WorkKind<{ candidates: number[] }, number> = {
      name: "checks",
      oneShot: false,
      fetch: async () => ({ candidates: [3, 1, 2] }),
      select: (data) => Math.min(...data.candidates),
      run: async (unit) => {
        runCalls.push(unit);
        return { exitCode: 0 };
      },
      refFor: (unit) => ({ kind: "checks", target: { type: "pr", number: unit } }),
    };
    const handle = boxKind(kind);
    const gathered = await handle.gather(fakeCtx());
    const plan = gathered.plan(fakeCtx());
    expect(plan?.ref).toEqual({ kind: "checks", target: { type: "pr", number: 1 } });
    expect(plan?.describe()).toContain("PR #1");

    const result = await plan!.execute(fakeCtx());
    expect(result).toEqual({ exitCode: 0 });
    expect(runCalls).toEqual([1]);
  });

  test("plan() is null and idle() reports the kind's reason when select finds nothing", async () => {
    const kind: WorkKind<null, never> = {
      name: "reviews",
      oneShot: false,
      fetch: async () => null,
      select: () => null,
      run: async () => ({ exitCode: null }),
      refFor: () => {
        throw new Error("never called");
      },
      describeIdle: () => "3 review-feedback PR(s) but none fixable this cycle.",
    };
    const handle = boxKind(kind);
    const gathered = await handle.gather(fakeCtx());
    expect(gathered.plan(fakeCtx())).toBeNull();
    expect(gathered.idle()).toBe("3 review-feedback PR(s) but none fixable this cycle.");
  });

  test("idle() is null when the kind has no describeIdle", async () => {
    const kind: WorkKind<null, never> = {
      name: "issues",
      oneShot: true,
      fetch: async () => null,
      select: () => null,
      run: async () => ({ exitCode: null }),
      refFor: () => {
        throw new Error("never called");
      },
    };
    const gathered = await boxKind(kind).gather(fakeCtx());
    expect(gathered.idle()).toBeNull();
  });

  test("carries sweep through only when the kind defines one", () => {
    const withSweep: WorkKind<null, never> = {
      name: "conflicts",
      oneShot: false,
      fetch: async () => null,
      select: () => null,
      run: async () => ({ exitCode: null }),
      refFor: () => {
        throw new Error("never called");
      },
      sweep: async () => {},
    };
    const withoutSweep: WorkKind<null, never> = { ...withSweep, sweep: undefined };
    expect(boxKind(withSweep).sweep !== undefined).toBe(true);
    expect(boxKind(withoutSweep).sweep !== undefined).toBe(false);
  });
});

describe("pickFirstPlan", () => {
  test("prefers the first kind in order that has a unit", async () => {
    const kinds = [
      fakeKind({ name: "conflicts", prNumber: 200 }),
      fakeKind({ name: "issues", prNumber: 135 }),
    ];
    const plan = pickFirstPlan(await gatherAll(kinds, fakeCtx()), fakeCtx());
    expect(plan?.ref.kind).toBe("conflicts");
    expect(plan?.ref.target.number).toBe(200);
  });

  test("falls through to the next kind when an earlier one has nothing", async () => {
    const kinds = [
      fakeKind({ name: "conflicts", prNumber: null }),
      fakeKind({ name: "issues", prNumber: 135 }),
    ];
    const plan = pickFirstPlan(await gatherAll(kinds, fakeCtx()), fakeCtx());
    expect(plan?.ref.kind).toBe("issues");
    expect(plan?.ref.target.number).toBe(135);
  });

  test("a kind absent from the gathered list is never picked", async () => {
    const kinds = [fakeKind({ name: "issues", prNumber: 135 })];
    const plan = pickFirstPlan(await gatherAll(kinds, fakeCtx()), fakeCtx());
    expect(plan?.ref.kind).toBe("issues");
  });

  test("returns null when nothing in the list has a unit", async () => {
    const kinds = [
      fakeKind({ name: "conflicts", prNumber: null }),
      fakeKind({ name: "issues", prNumber: null }),
    ];
    expect(pickFirstPlan(await gatherAll(kinds, fakeCtx()), fakeCtx())).toBeNull();
  });
});

describe("pickFirstIdleReason", () => {
  test("returns the first non-null idle reason in order", async () => {
    const kinds = [
      fakeKind({ name: "conflicts", prNumber: null, idleReason: null }),
      fakeKind({
        name: "checks",
        prNumber: null,
        idleReason: "2 failing-CI PR(s) but none fixable this cycle.",
      }),
    ];
    expect(pickFirstIdleReason(await gatherAll(kinds, fakeCtx()))).toBe(
      "2 failing-CI PR(s) but none fixable this cycle.",
    );
  });

  test("returns null when no kind has anything to explain", async () => {
    const kinds = [fakeKind({ name: "conflicts", prNumber: null, idleReason: null })];
    expect(pickFirstIdleReason(await gatherAll(kinds, fakeCtx()))).toBeNull();
  });
});

describe("oneShotEligible", () => {
  test("keeps only kinds marked one-shot — janitors are persistent-mode only", () => {
    const kinds = [
      fakeKind({ name: "conflicts", prNumber: null, oneShot: false }),
      fakeKind({ name: "checks", prNumber: null, oneShot: false }),
      fakeKind({ name: "reviews", prNumber: null, oneShot: false }),
      fakeKind({ name: "issues", prNumber: null, oneShot: true }),
      fakeKind({ name: "research", prNumber: null, oneShot: true }),
    ];
    expect(oneShotEligible(kinds).map((k) => k.name)).toEqual(["issues", "research"]);
  });

  test("preserves input order and drops nothing when everything is eligible", () => {
    const kinds = [
      fakeKind({ name: "issues", prNumber: null, oneShot: true }),
      fakeKind({ name: "research", prNumber: null, oneShot: true }),
    ];
    expect(oneShotEligible(kinds).map((k) => k.name)).toEqual(["issues", "research"]);
  });

  test("returns empty when nothing is eligible", () => {
    const kinds = [fakeKind({ name: "conflicts", prNumber: null, oneShot: false })];
    expect(oneShotEligible(kinds)).toEqual([]);
  });
});
