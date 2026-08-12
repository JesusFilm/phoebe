// Fleet supervision tests (#58/#59, merged into the shared loop by #65): one
// child per tenant, hot add/remove/change, shared-engine relaunch-all, stop-
// drains-all, and per-tenant respawn of a child that died on its own — all
// driven through injected fakes (scripted children, a gated clock, a stop
// latch), no processes or real timers. This file drives `supervise` (the same
// loop `supervise.test.ts` drives as flat's fleet-of-one) as a real,
// multi-tenant fleet.

import { describe, expect, test } from "vite-plus/test";
import { REF_CHANGE_DRAIN_SIGNAL } from "../src/drain.ts";
import { createCrashGuard } from "./crash-loop.ts";
import type { EngineExit, LaunchedEngine } from "./supervise.ts";
import type { DiscoveredTenant, TenantSample } from "./tenants.ts";
import { DuplicateOriginSlugError } from "./tenants.ts";
import { supervise, type DrainTimer, type SupervisedChild } from "./supervise.ts";

/** The store shape `createCrashGuard` accepts — not exported, so derived structurally. */
type CrashLoopStore = NonNullable<Parameters<typeof createCrashGuard>[0]["store"]>;

/** A fake store good enough for a whole test — no filesystem involved. */
function fakeStore(): CrashLoopStore {
  let state: ReturnType<CrashLoopStore["read"]> = {
    lastGoodSha: null,
    failingSha: null,
    failureCount: 0,
    crashedTenants: [],
  };
  return {
    read: () => state,
    write: (next) => {
      state = next;
    },
  };
}

const DEFAULT_ENGINE_SOURCE = {
  source: "github" as const,
  ref: "main",
  repo: "JesusFilm/phoebe",
};

function tenant(slug: string): DiscoveredTenant {
  return {
    id: `/etc/phoebe/repos/${slug}`,
    slug,
    dir: `/etc/phoebe/repos/${slug}`,
    configPath: `/etc/phoebe/repos/${slug}/phoebe.config.ts`,
    envPath: `/etc/phoebe/repos/${slug}/.env`,
  };
}

function sample(slug: string, fingerprint: string | null): TenantSample {
  return { tenant: tenant(slug), fingerprint };
}

function fakeChild(): { child: SupervisedChild; kills: string[]; exit: (e?: EngineExit) => void } {
  const kills: string[] = [];
  let settle!: (e: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  return {
    kills,
    // A drained child exits promptly on SIGTERM (its graceful drain), so
    // `kill` settles `exited` too — otherwise `drainAll` would await forever.
    child: {
      kill: (signal) => {
        kills.push(signal);
        settle({ code: 0, signal: null });
      },
      exited,
    },
    exit: (e = { code: 0, signal: null }) => settle(e),
  };
}

// A child that ignores SIGTERM — its work unit never finishes — so `exited`
// only settles once it is SIGKILLed. Exercises the drain escalation (#79).
function stubbornChild(): { child: SupervisedChild; kills: string[] } {
  const kills: string[] = [];
  let settle!: (e: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  return {
    kills,
    child: {
      kill: (signal) => {
        kills.push(signal);
        if (signal === "SIGKILL") settle({ code: null, signal: "SIGKILL" });
      },
      exited,
    },
  };
}

// A gated cancelable timer standing in for the drain grace: nothing fires until
// `fireAll`, and a canceled timer stays quiet — so a test drives the escalation.
function gatedTimers(): { make: DrainTimer; fireAll: () => void; canceledCount: () => number } {
  const pending: Array<{ resolve: () => void; canceled: boolean }> = [];
  return {
    make: (_ms: number) => {
      const entry = { resolve: () => {}, canceled: false };
      const expired = new Promise<void>((resolve) => {
        entry.resolve = resolve;
      });
      pending.push(entry);
      return {
        expired,
        cancel: () => {
          entry.canceled = true;
        },
      };
    },
    fireAll: () => {
      for (const entry of pending) if (!entry.canceled) entry.resolve();
    },
    canceledCount: () => pending.filter((e) => e.canceled).length,
  };
}

function gatedClock(): { wait: () => Promise<void>; tick: () => void } {
  const pending: Array<() => void> = [];
  return {
    wait: () => new Promise<void>((resolve) => pending.push(resolve)),
    tick: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function harness(initial: TenantSample[]) {
  const clock = gatedClock();
  const engineState = {
    config: "1:1",
    remoteSha: "a".repeat(40),
    source: { ...DEFAULT_ENGINE_SOURCE },
  };
  let tenants = [...initial];
  const spawned: Array<{ slug: string | null; fake: ReturnType<typeof fakeChild> }> = [];
  let stopRequested = false;
  let launches = 0;
  let throwOnDiscover = false;
  let engineChanges = 0;
  const discoverErrors: unknown[] = [];

  // A (re)materialized engine is checked out at the *current* tracked ref, so
  // its sha matches the ref at launch time — exactly what real materialization
  // does. (A hard-coded sha would make detectChange fire forever after a ref
  // move: sample.remoteSha would never equal the launched sha.)
  const engine = (): LaunchedEngine => ({
    entry: "/data/engine/src/cli.ts",
    sha: engineState.remoteSha,
    config: engineState.config,
    source: { ...engineState.source },
    quarantinedSha: null,
    guarded: true,
    sample: () => ({ config: engineState.config, remoteSha: engineState.remoteSha }),
  });

  const result = supervise<DiscoveredTenant>({
    intervalMs: 1000,
    childRespawnBackoffMs: 500,
    launch: () => {
      launches += 1;
      return engine();
    },
    children: {
      discover: () => {
        if (throwOnDiscover) throw new Error("EACCES: repos/ momentarily unreadable");
        return tenants;
      },
      spawn: (t) => {
        const fake = fakeChild();
        spawned.push({ slug: t.slug, fake });
        return fake.child;
      },
    },
    // A fleet child that dies on its own is always respawned, with backoff —
    // the shared engine and every sibling are left untouched (#60 §6).
    onChildGone: () => "respawn",
    onDiscoverError: (e) => discoverErrors.push(e),
    onEngineChange: () => {
      engineChanges += 1;
    },
    stop: {
      get requested() {
        return stopRequested;
      },
      wait: clock.wait,
    },
  });

  return {
    result,
    spawned,
    get launches() {
      return launches;
    },
    get engineChanges() {
      return engineChanges;
    },
    setTenants: (next: TenantSample[]) => {
      tenants = next;
    },
    moveEngineConfig: (config: string) => {
      engineState.config = config;
    },
    moveEngineSource: (ref: string) => {
      engineState.source = { ...DEFAULT_ENGINE_SOURCE, ref };
    },
    setThrowOnDiscover: (v: boolean) => {
      throwOnDiscover = v;
    },
    get discoverErrors() {
      return discoverErrors;
    },
    moveEngineRef: (sha: string) => {
      engineState.remoteSha = sha;
    },
    tick: clock.tick,
    requestStop: () => {
      stopRequested = true;
      clock.tick();
    },
  };
}

describe("superviseFleet", () => {
  test("spawns one child per discovered tenant at start", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const slugs = h.spawned.map((s) => s.slug).sort((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(slugs).toEqual(["acme/gadget", "acme/widget"]);
  });

  test("hot-adds a tenant that appears", async () => {
    const h = harness([sample("acme/widget", "fp1")]);
    await settle();
    expect(h.spawned).toHaveLength(1);

    h.setTenants([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    h.tick();
    await settle();
    expect(h.spawned.map((s) => s.slug)).toContain("acme/gadget");
    expect(h.spawned).toHaveLength(2);
  });

  test("hot-removes a tenant that vanishes, draining its child", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const gadget = h.spawned.find((s) => s.slug === "acme/gadget")!;

    h.setTenants([sample("acme/widget", "fp1")]);
    h.tick();
    await settle();
    expect(gadget.fake.kills).toContain("SIGTERM");
  });

  test("relaunches only the changed tenant on a config-fingerprint move", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const widget = h.spawned.find((s) => s.slug === "acme/widget")!;

    h.setTenants([sample("acme/widget", "fp2"), sample("acme/gadget", "fp1")]);
    h.tick();
    await settle();
    expect(widget.fake.kills).toContain("SIGTERM"); // old child drained
    // A fresh widget child was spawned (2 initial + 1 relaunch = 3).
    expect(h.spawned.filter((s) => s.slug === "acme/widget")).toHaveLength(2);
    expect(h.spawned.filter((s) => s.slug === "acme/gadget")).toHaveLength(1); // untouched
  });

  test("a shared-engine ref move drains and respawns the whole fleet", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const initial = [...h.spawned];

    h.moveEngineRef("b".repeat(40));
    h.tick();
    await settle();
    // A ref change gets the distinct drain signal on both topologies (#65), so
    // a draining tenant can report why (#23) — the fleet no longer sends a
    // plain SIGTERM for this.
    for (const s of initial) expect(s.fake.kills).toContain(REF_CHANGE_DRAIN_SIGNAL);
    expect(h.launches).toBe(2); // re-materialized once
    expect(h.spawned).toHaveLength(4); // 2 initial + 2 respawned
  });

  test("a throwing discovery skips the tenant axis instead of draining the fleet", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const initial = [...h.spawned];

    // A transient `repos/` read error (EACCES/EMFILE) → discover throws. The
    // supervisor must treat it as unknown state, not "every tenant removed".
    h.setThrowOnDiscover(true);
    h.tick();
    await settle();
    for (const s of initial) expect(s.fake.kills).toEqual([]); // nobody drained
    expect(h.discoverErrors).toHaveLength(1);

    // Recovers on the next good poll — no respawn churn (fleet was never torn down).
    h.setThrowOnDiscover(false);
    h.tick();
    await settle();
    expect(h.spawned).toHaveLength(2);
  });

  test("DuplicateOriginSlugError aborts the supervisor (#138)", async () => {
    const clock = gatedClock();
    let throwDuplicateOrigin = false;
    const spawned: Array<ReturnType<typeof fakeChild>> = [];

    const result = supervise<DiscoveredTenant>({
      intervalMs: 1000,
      launch: () => ({
        entry: "/data/engine/src/cli.ts",
        sha: "a".repeat(40),
        config: "1:1",
        source: { ...DEFAULT_ENGINE_SOURCE },
        quarantinedSha: null,
        guarded: true,
        sample: () => ({ config: "1:1", remoteSha: "a".repeat(40) }),
      }),
      children: {
        discover: () => {
          if (throwDuplicateOrigin) {
            throw new DuplicateOriginSlugError("acme/widget", "/a", "/b");
          }
          return [sample("acme/widget", "fp1")];
        },
        spawn: () => {
          const fake = fakeChild();
          spawned.push(fake);
          return fake.child;
        },
      },
      // A fatal discover error (unlike a transient one) is rethrown by
      // `onDiscoverError`, so `supervise` rejects instead of respawning.
      onChildGone: () => "respawn",
      onDiscoverError: (e) => {
        throw e;
      },
      stop: {
        get requested() {
          return false;
        },
        wait: clock.wait,
      },
    });

    await settle();
    expect(spawned).toHaveLength(1);

    throwDuplicateOrigin = true;
    clock.tick();
    await expect(result).rejects.toBeInstanceOf(DuplicateOriginSlugError);
  });

  test("a hold id keeps a missing sample from draining (#86/#91)", async () => {
    const clock = gatedClock();
    const engineState = {
      config: "1:1",
      remoteSha: "a".repeat(40),
      source: { ...DEFAULT_ENGINE_SOURCE },
    };
    let samples: TenantSample[] = [sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")];
    let hold: string[] = [];
    const spawned: Array<{ slug: string | null; fake: ReturnType<typeof fakeChild> }> = [];
    let stopRequested = false;

    const result = supervise<DiscoveredTenant>({
      intervalMs: 1000,
      childRespawnBackoffMs: 500,
      launch: () => ({
        entry: "/data/engine/src/cli.ts",
        sha: engineState.remoteSha,
        config: engineState.config,
        source: { ...engineState.source },
        quarantinedSha: null,
        guarded: true,
        sample: () => ({ config: engineState.config, remoteSha: engineState.remoteSha }),
      }),
      children: {
        discover: () => ({ samples, hold }),
        spawn: (t) => {
          const fake = fakeChild();
          spawned.push({ slug: t.slug, fake });
          return fake.child;
        },
      },
      onChildGone: () => "respawn",
      stop: {
        get requested() {
          return stopRequested;
        },
        wait: clock.wait,
      },
    });

    await settle();
    expect(spawned).toHaveLength(2);
    const gadgetDir = tenant("acme/gadget").id;

    // Mid-rewrite: gadget disappears from samples but is marked held.
    samples = [sample("acme/widget", "fp1")];
    hold = [gadgetDir];
    clock.tick();
    await settle();
    const gadget = spawned.find((s) => s.slug === "acme/gadget")!;
    expect(gadget.fake.kills).toEqual([]);

    // Dir genuinely gone → drain.
    hold = [];
    clock.tick();
    await settle();
    expect(gadget.fake.kills).toContain("SIGTERM");

    stopRequested = true;
    clock.tick();
    for (const s of spawned) s.fake.exit();
    await result;
  });

  test("respawns a child that died on its own (per-tenant supervision)", async () => {
    const h = harness([sample("acme/widget", "fp1")]);
    await settle();
    const first = h.spawned[0]!;

    first.fake.exit({ code: 1, signal: null }); // crash
    await settle();
    h.tick(); // release the respawn backoff wait
    await settle();
    expect(h.spawned.filter((s) => s.slug === "acme/widget")).toHaveLength(2);
  });

  test("a container stop drains every child and resolves 0", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const all = [...h.spawned];

    h.requestStop();
    // The drained children must settle their exits so drainAll resolves.
    for (const s of all) s.fake.exit();
    const exit = await h.result;
    expect(exit).toEqual({ code: 0, signal: null });
    for (const s of all) expect(s.fake.kills).toContain("SIGTERM");
  });

  test("SIGKILLs a child that ignores SIGTERM after the drain grace (#79)", async () => {
    const clock = gatedClock();
    const timers = gatedTimers();
    const stubborn = stubbornChild();
    const reaped: string[] = [];
    let stopRequested = false;

    const result = supervise<DiscoveredTenant>({
      intervalMs: 1000,
      drainTimer: timers.make,
      launch: () => ({
        entry: "/data/engine/src/cli.ts",
        sha: "a".repeat(40),
        config: "1:1",
        source: { ...DEFAULT_ENGINE_SOURCE },
        quarantinedSha: null,
        guarded: true,
        sample: () => ({ config: "1:1", remoteSha: "a".repeat(40) }),
      }),
      children: {
        discover: () => [sample("acme/widget", "fp1")],
        spawn: () => stubborn.child,
      },
      onChildGone: () => "respawn",
      onReap: (id) => reaped.push(id),
      stop: {
        get requested() {
          return stopRequested;
        },
        wait: clock.wait,
      },
    });

    await settle();
    expect(stubborn.kills).toEqual([]);

    // Container stop → drainAll → drain sends SIGTERM, which this child ignores.
    stopRequested = true;
    clock.tick();
    await settle();
    expect(stubborn.kills).toEqual(["SIGTERM"]); // still waiting on the grace

    // The grace elapses → escalate to SIGKILL, which brings it down and lets
    // drain (and drainAll, and the supervisor) complete.
    timers.fireAll();
    const exit = await result;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(stubborn.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(reaped).toEqual([tenant("acme/widget").id]); // onReap still fires after kill
  });

  test("a graceful drain cancels the grace timer and never SIGKILLs (#79)", async () => {
    const clock = gatedClock();
    const timers = gatedTimers();
    const spawned: Array<ReturnType<typeof fakeChild>> = [];
    let stopRequested = false;

    const result = supervise<DiscoveredTenant>({
      intervalMs: 1000,
      drainTimer: timers.make,
      launch: () => ({
        entry: "/data/engine/src/cli.ts",
        sha: "a".repeat(40),
        config: "1:1",
        source: { ...DEFAULT_ENGINE_SOURCE },
        quarantinedSha: null,
        guarded: true,
        sample: () => ({ config: "1:1", remoteSha: "a".repeat(40) }),
      }),
      children: {
        discover: () => [sample("acme/widget", "fp1")],
        spawn: () => {
          const fake = fakeChild();
          spawned.push(fake);
          return fake.child;
        },
      },
      onChildGone: () => "respawn",
      stop: {
        get requested() {
          return stopRequested;
        },
        wait: clock.wait,
      },
    });

    await settle();
    stopRequested = true;
    clock.tick();
    // A well-behaved child settles its exit on SIGTERM (fakeChild does).
    const exit = await result;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(spawned[0]!.kills).toEqual(["SIGTERM"]); // no SIGKILL
    expect(timers.canceledCount()).toBe(1); // grace timer was canceled, not left pending
  });
});

// --- Fed by a real crash-loop guard (#79) -----------------------------------
//
// `buildFleetDeps` (deployment.ts) wires the fleet to the crash-loop guard the
// same way flat does: `onChildRun`/`onChildTick` feed its bookkeeping, and its
// live tenant roster — mutated on spawn and on a tenant-axis removal — is what
// makes the breadth half of breadth × count (#78) reflect who is actually
// running instead of staying permanently empty. `launch` here stands in for
// `launchTarget`: it re-consults `guard.fallbackFor` on every call, exactly as
// the real one does. `isCondemned` is supervise's third engine-axis trigger.

const THRESHOLD = 3;
const HEALTHY_MS = 1_000;
const SHA_GOOD = "9".repeat(40);
const SHA_BAD = "b".repeat(40);

function guardedFleetHarness(initial: TenantSample[]) {
  const clock = gatedClock();
  const engineState = { config: "1:1", remoteSha: SHA_GOOD };
  const liveTenants = new Set<string>();
  const guard = createCrashGuard({
    engineDir: "/data/engine",
    log: () => {},
    roster: () => [...liveTenants],
    store: fakeStore(),
    threshold: THRESHOLD,
    healthyMs: HEALTHY_MS,
  });
  let tenants = [...initial];
  const spawned: Array<{
    slug: string | null;
    sha: string | null;
    fake: ReturnType<typeof fakeChild>;
  }> = [];
  let stopRequested = false;
  let clockMs = 0;

  const launch = (): LaunchedEngine => {
    const target = engineState.remoteSha;
    const pin = guard.fallbackFor(target);
    const sha = pin ?? target;
    return {
      entry: "/data/engine/src/cli.ts",
      sha,
      config: engineState.config,
      quarantinedSha: pin !== null ? target : null,
      guarded: true,
      sample: () => ({ config: engineState.config, remoteSha: engineState.remoteSha }),
    };
  };

  const result = supervise<DiscoveredTenant>({
    now: () => clockMs,
    intervalMs: 1000,
    childRespawnBackoffMs: 500,
    launch,
    children: {
      discover: () => tenants,
      spawn: (t, engine) => {
        const fake = fakeChild();
        spawned.push({ slug: t.slug, sha: engine.sha, fake });
        liveTenants.add(t.id);
        return fake.child;
      },
    },
    // A fleet child that dies is always respawned (#60 §6) — `shouldRetry` is
    // flat-only; the fleet's `onChildGone` never consults the guard.
    onChildGone: () => "respawn",
    onChildRun: (run) => guard.record(run, run.tenant.id),
    onChildTick: ({ engine, elapsedMs }) => {
      if (engine.sha !== null) guard.noteAlive(engine.sha, elapsedMs);
    },
    isCondemned: (engine) => engine.guarded && engine.sha !== null && guard.condemns(engine.sha),
    onChildChange: ({ removed }) => {
      for (const id of removed) liveTenants.delete(id);
    },
    stop: {
      get requested() {
        return stopRequested;
      },
      wait: clock.wait,
    },
  });

  return {
    result,
    guard,
    latestShaFor: (slug: string) =>
      [...spawned].reverse().find((s) => s.slug === slug)?.sha ?? null,
    killsFor: (slug: string) => spawned.filter((s) => s.slug === slug).flatMap((s) => s.fake.kills),
    crash: (slug: string) => {
      const last = [...spawned].reverse().find((s) => s.slug === slug);
      last?.fake.exit({ code: 1, signal: null });
    },
    moveEngineRef: (sha: string) => {
      engineState.remoteSha = sha;
    },
    tick: clock.tick,
    advance: (ms: number) => {
      clockMs += ms;
    },
    requestStop: () => {
      stopRequested = true;
      clock.tick();
    },
  };
}

describe("fleet + a real crash-loop guard (#79)", () => {
  test("a fleet whose every child crashes fast relaunches onto the last-good commit", async () => {
    const h = guardedFleetHarness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();

    // Prove SHA_GOOD as the fallback target before anything goes wrong.
    h.advance(HEALTHY_MS);
    h.tick();
    await settle();

    // The tracked ref moves to a commit neither tenant can boot on.
    h.moveEngineRef(SHA_BAD);
    h.tick();
    await settle();
    expect(h.latestShaFor("acme/widget")).toBe(SHA_BAD);
    expect(h.latestShaFor("acme/gadget")).toBe(SHA_BAD);

    // Breadth (#78): each tenant fast-crashing once is not enough on its own.
    h.crash("acme/widget");
    await settle();
    h.tick();
    await settle();
    h.crash("acme/gadget");
    await settle();
    h.tick();
    await settle();
    expect(h.guard.condemns(SHA_BAD)).toBe(false); // count 2/3

    // The third fast crash, with both tenants now in `crashedTenants`,
    // condemns the commit — this respawn lands straight on the fallback.
    h.crash("acme/widget");
    await settle();
    h.tick();
    await settle();
    expect(h.guard.condemns(SHA_BAD)).toBe(true);
    expect(h.latestShaFor("acme/widget")).toBe(SHA_GOOD);

    // Gadget is still crash-looping too (the premise: *every* child crashes),
    // so its own very next respawn also lands on the fallback — the fleet is
    // not stuck respawning it onto the condemned commit forever.
    h.crash("acme/gadget");
    await settle();
    h.tick();
    await settle();
    expect(h.latestShaFor("acme/gadget")).toBe(SHA_GOOD);
  });

  test("one tenant crash-looping alone never condemns the shared engine", async () => {
    const h = guardedFleetHarness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();

    h.advance(HEALTHY_MS);
    h.tick();
    await settle();

    h.moveEngineRef(SHA_BAD);
    h.tick();
    await settle();
    // The one shared-engine drain so far, from the ref move above.
    const gadgetKillsAfterRefMove = h.killsFor("acme/gadget");

    // Widget alone fast-crashes past the threshold; gadget never does.
    for (let i = 0; i < THRESHOLD + 2; i++) {
      h.crash("acme/widget");
      await settle();
      h.tick(); // release the respawn backoff
      await settle();
    }

    // Breadth rules this out — one broken tenant does not cost the fleet its
    // engine: gadget is never drained again, and the commit is never condemned.
    expect(h.guard.condemns(SHA_BAD)).toBe(false);
    expect(h.killsFor("acme/gadget")).toEqual(gadgetKillsAfterRefMove);
    expect(h.latestShaFor("acme/widget")).toBe(SHA_BAD); // still respawning, unpinned
  });

  test("a pinned fleet does not chase the tip while it still points at the quarantined commit", async () => {
    const h = guardedFleetHarness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();

    h.advance(HEALTHY_MS);
    h.tick();
    await settle();
    h.moveEngineRef(SHA_BAD);
    h.tick();
    await settle();

    // Condemn SHA_BAD: three fast crashes with full breadth.
    h.crash("acme/widget");
    await settle();
    h.tick();
    await settle();
    h.crash("acme/gadget");
    await settle();
    h.tick();
    await settle();
    h.crash("acme/widget");
    await settle();
    h.tick();
    await settle();
    expect(h.guard.condemns(SHA_BAD)).toBe(true);
    expect(h.latestShaFor("acme/widget")).toBe(SHA_GOOD);

    const killsBefore = h.killsFor("acme/gadget");

    // The tracked branch still points at the quarantined commit — several more
    // polls must not read that as a change to chase.
    h.tick();
    await settle();
    h.tick();
    await settle();

    expect(h.killsFor("acme/gadget")).toEqual(killsBefore); // no new drain
    expect(h.guard.condemns(SHA_GOOD)).toBe(false); // the fallback itself is fine
  });
});
