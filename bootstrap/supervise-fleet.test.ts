// Fleet supervision tests (#58/#59): one child per tenant, hot add/remove/change,
// shared-engine relaunch-all, stop-drains-all, and per-tenant respawn of a child
// that died on its own — all driven through injected fakes (scripted children, a
// gated clock, a stop latch), no processes or real timers.

import { describe, expect, test } from "vite-plus/test";
import type { EngineExit, LaunchedEngine, WatchState } from "./reconcile.ts";
import type { DiscoveredTenant, TenantSample } from "./tenants.ts";
import { DuplicateOriginSlugError } from "./tenants.ts";
import {
  superviseFleet,
  type DrainTimer,
  type FleetChild,
  type FleetRun,
  type RowExitAction,
} from "./supervise-fleet.ts";

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
    gitIdentity: null,
  };
}

function sample(slug: string, fingerprint: string | null): TenantSample {
  return { tenant: tenant(slug), fingerprint };
}

function fakeChild(): { child: FleetChild; kills: string[]; exit: (e?: EngineExit) => void } {
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
function stubbornChild(): { child: FleetChild; kills: string[] } {
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
    confirmEngineSource: async () => ({ ...engineState.source }),
    sample: () => ({ config: engineState.config, remoteSha: engineState.remoteSha }),
  });

  const result = superviseFleet({
    intervalMs: 1000,
    crashBackoffMs: 500,
    launch: () => {
      launches += 1;
      return engine();
    },
    discover: () => {
      if (throwOnDiscover) throw new Error("EACCES: repos/ momentarily unreadable");
      return tenants;
    },
    onDiscoverError: (e) => discoverErrors.push(e),
    onEngineChange: () => {
      engineChanges += 1;
    },
    spawn: (t) => {
      const fake = fakeChild();
      spawned.push({ slug: t.slug, fake });
      return fake.child;
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
    for (const s of initial) expect(s.fake.kills).toContain("SIGTERM");
    expect(h.launches).toBe(2); // re-materialized once
    expect(h.spawned).toHaveLength(4); // 2 initial + 2 respawned
  });

  test("a root config edit that does not move the engine source does not drain the fleet", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const initial = [...h.spawned];

    h.moveEngineConfig("2:2");
    h.tick();
    await settle();
    for (const s of initial) expect(s.fake.kills).toEqual([]);
    expect(h.launches).toBe(1);
    expect(h.engineChanges).toBe(0);
  });

  test("rebasing the engine fingerprint prevents config churn every poll (#138)", async () => {
    const h = harness([sample("acme/widget", "fp1")]);
    await settle();
    const initial = [...h.spawned];

    h.moveEngineConfig("2:2");
    h.tick();
    await settle();
    h.moveEngineConfig("3:3");
    h.tick();
    await settle();

    for (const s of initial) expect(s.fake.kills).toEqual([]);
    expect(h.launches).toBe(1);
    expect(h.engineChanges).toBe(0);
    expect(h.spawned).toHaveLength(1);
  });

  test("a root config edit that moves the engine source drains and relaunches", async () => {
    const h = harness([sample("acme/widget", "fp1")]);
    await settle();
    const initial = [...h.spawned];

    h.moveEngineConfig("2:2");
    h.moveEngineSource("next");
    h.tick();
    await settle();
    for (const s of initial) expect(s.fake.kills).toContain("SIGTERM");
    expect(h.launches).toBe(2);
    expect(h.engineChanges).toBe(1);
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

  test("DuplicateOriginSlugError drains the fleet before aborting (#138)", async () => {
    const clock = gatedClock();
    let throwDuplicateOrigin = false;
    const spawned: Array<ReturnType<typeof fakeChild>> = [];

    const result = superviseFleet({
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
    const rejection = expect(result).rejects.toBeInstanceOf(DuplicateOriginSlugError);
    await settle();
    expect(spawned[0]!.kills).toContain("SIGTERM");
    await rejection;
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

    const result = superviseFleet({
      intervalMs: 1000,
      crashBackoffMs: 500,
      launch: () => ({
        entry: "/data/engine/src/cli.ts",
        sha: engineState.remoteSha,
        config: engineState.config,
        source: { ...engineState.source },
        quarantinedSha: null,
        guarded: true,
        confirmEngineSource: async () => ({ ...engineState.source }),
        sample: () => ({ config: engineState.config, remoteSha: engineState.remoteSha }),
      }),
      discover: () => ({ samples, hold }),
      spawn: (t) => {
        const fake = fakeChild();
        spawned.push({ slug: t.slug, fake });
        return fake.child;
      },
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

    const result = superviseFleet({
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
      discover: () => [sample("acme/widget", "fp1")],
      spawn: () => stubborn.child,
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

    const result = superviseFleet({
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
      discover: () => [sample("acme/widget", "fp1")],
      spawn: () => {
        const fake = fakeChild();
        spawned.push(fake);
        return fake.child;
      },
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

// --- solo, as a one-tenant fleet (#416) --------------------------------------
// Solo used to have its own single-child loop. These are the behaviours that
// loop guaranteed, now asserted against `superviseFleet` driving one row with
// the arm's exit policy injected: the engine's exit is the container's, a fast
// crash re-materializes the engine so the crash-loop fallback can land, and the
// tenant axis stays inert because the root config *is* the engine's config.

const SOLO_ROW: DiscoveredTenant = {
  id: "/etc/phoebe",
  slug: null,
  dir: "/etc/phoebe",
  configPath: "/etc/phoebe/phoebe.config.ts",
  envPath: "/etc/phoebe/.env",
  gitIdentity: null,
};

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/**
 * A child only the test settles — unlike `fakeChild`, `SIGTERM` does not end it.
 * That is what makes a drain genuinely awaited, so a test can drive what lands
 * between "we asked it to stop" and "it is gone".
 */
function scriptedChild(): {
  child: FleetChild;
  kills: string[];
  exit: (exit?: EngineExit) => void;
} {
  const kills: string[] = [];
  let settle!: (exit: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  return {
    kills,
    child: {
      kill: (signal) => {
        kills.push(signal);
      },
      exited,
    },
    exit: (exit = { code: 0, signal: null }) => settle(exit),
  };
}

/** A drain grace that never expires — every drain here ends on the child's exit. */
const patientDrainTimer: DrainTimer = () => ({
  expired: new Promise<void>(() => {}),
  cancel: () => {},
});

function soloHarness(
  options: {
    launch?: (attempt: number) => Promise<LaunchedEngine> | LaunchedEngine;
    decide?: (run: FleetRun) => RowExitAction;
  } = {},
) {
  const clock = gatedClock();
  const state: WatchState & { sha: string | null; source: typeof DEFAULT_ENGINE_SOURCE } = {
    config: "1:2",
    remoteSha: SHA_A,
    sha: SHA_A,
    source: { ...DEFAULT_ENGINE_SOURCE },
  };
  const children: Array<ReturnType<typeof scriptedChild>> = [];
  const entries: string[] = [];
  const relaunches: string[] = [];
  const runs: FleetRun[] = [];
  const ticks: number[] = [];
  let stopRequested = false;
  let attempt = 0;
  let clockMs = 0;

  const result = superviseFleet({
    intervalMs: 1000,
    crashBackoffMs: 500,
    now: () => clockMs,
    drainTimer: patientDrainTimer,
    // The root is the one tenant, and its fingerprint is a constant: a config
    // edit is the engine axis's business, never the tenant axis's.
    discover: () => [{ tenant: SOLO_ROW, fingerprint: "solo" }],
    launch: async () => {
      const n = attempt++;
      if (options.launch) return await options.launch(n);
      return {
        entry: `/engine/${n}/src/cli.ts`,
        sha: state.sha,
        config: state.config,
        source: { ...state.source },
        quarantinedSha: null,
        guarded: true,
        confirmEngineSource: async () => ({ ...state.source }),
        sample: () => ({ config: state.config, remoteSha: state.remoteSha }),
      };
    },
    spawn: (_tenant, engine) => {
      entries.push(engine.entry);
      const next = scriptedChild();
      children.push(next);
      return next.child;
    },
    stop: {
      get requested() {
        return stopRequested;
      },
      wait: clock.wait,
    },
    onRunEnd: (run) => runs.push(run),
    onRunTick: (tick) => ticks.push(tick.elapsedMs),
    onEngineChange: (reason) => relaunches.push(reason),
    rowExit: {
      decide: (run) => options.decide?.(run) ?? "exit",
      propagateOnStop: true,
    },
  });

  return {
    result,
    state,
    children,
    entries,
    relaunches,
    runs,
    ticks,
    tick: clock.tick,
    /** Move the injected clock forward, so run durations are asserted exactly. */
    advance: (ms: number) => {
      clockMs += ms;
    },
    requestStop: () => {
      stopRequested = true;
      clock.tick();
    },
  };
}

describe("superviseFleet — solo's one row", () => {
  test("runs the engine and stays out of its way while nothing changes", async () => {
    const h = soloHarness();
    await settle();
    expect(h.entries).toEqual(["/engine/0/src/cli.ts"]);

    for (let i = 0; i < 5; i++) {
      h.tick();
      await settle();
    }

    expect(h.entries).toHaveLength(1);
    expect(h.children[0]?.kills).toEqual([]);
    expect(h.relaunches).toEqual([]);

    h.requestStop();
    await settle();
    h.children[0]?.exit();
    expect(await h.result).toEqual({ code: 0, signal: null });
  });

  test("an engine that exits on its own is not relaunched — its exit is the result", async () => {
    const h = soloHarness();
    await settle();

    h.children[0]?.exit({ code: 3, signal: null });

    expect(await h.result).toEqual({ code: 3, signal: null });
    expect(h.entries).toHaveLength(1);
  });

  test("editing the mounted config drains the engine, then relaunches it", async () => {
    const h = soloHarness();
    await settle();

    h.state.config = "9:9";
    h.state.source = { source: "github", ref: "next", repo: "JesusFilm/phoebe" };
    h.tick();
    await settle();

    // Drained, not killed outright — and nothing new starts until it is gone.
    expect(h.relaunches).toEqual(["config"]);
    expect(h.children[0]?.kills).toEqual(["SIGTERM"]);
    expect(h.entries).toHaveLength(1);

    h.children[0]?.exit();
    await settle();
    expect(h.entries).toEqual(["/engine/0/src/cli.ts", "/engine/1/src/cli.ts"]);

    h.requestStop();
    await settle();
    h.children[1]?.exit();
    await h.result;
  });

  test("a config edit that does not move the engine source is rebased without draining (#138)", async () => {
    const h = soloHarness();
    await settle();

    h.state.config = "9:9";
    h.tick();
    await settle();

    expect(h.relaunches).toEqual([]);
    expect(h.children[0]?.kills).toEqual([]);
    expect(h.entries).toHaveLength(1);

    h.state.config = "10:10";
    h.tick();
    await settle();
    expect(h.relaunches).toEqual([]);
    expect(h.entries).toHaveLength(1);

    h.requestStop();
    await settle();
    h.children[0]?.exit();
    await h.result;
  });

  test("the tracked ref advancing relaunches the engine on the new commit", async () => {
    const h = soloHarness();
    await settle();

    h.state.remoteSha = SHA_B;
    h.state.sha = SHA_B;
    h.tick();
    await settle();
    h.children[0]?.exit();
    await settle();

    expect(h.relaunches).toEqual(["ref"]);
    expect(h.entries).toHaveLength(2);

    // The relaunched engine is on the new commit, so the watch goes quiet again.
    h.tick();
    await settle();
    expect(h.entries).toHaveLength(2);

    h.requestStop();
    await settle();
    h.children[1]?.exit();
    await h.result;
  });

  test("an outside stop drains without relaunching, even mid-poll", async () => {
    const h = soloHarness();
    await settle();

    // A container SIGTERM: the engine is already draining via the forwarded
    // signal, so the loop must wait it out rather than start anything new.
    h.requestStop();
    await settle();
    expect(h.entries).toHaveLength(1);

    h.children[0]?.exit({ code: 0, signal: null });
    expect(await h.result).toEqual({ code: 0, signal: null });
    expect(h.entries).toHaveLength(1);
  });

  test("a stop landing during a relaunch drain does not respawn into a shutdown", async () => {
    const h = soloHarness();
    await settle();

    h.state.config = "9:9";
    h.state.source = { source: "github", ref: "next", repo: "JesusFilm/phoebe" };
    h.tick();
    await settle();
    expect(h.children[0]?.kills).toEqual(["SIGTERM"]);

    // The container goes down while the engine is finishing its unit.
    h.requestStop();
    h.children[0]?.exit({ code: 0, signal: null });

    expect(await h.result).toEqual({ code: 0, signal: null });
    expect(h.entries).toHaveLength(1);
  });

  test("a relaunch that cannot resolve the engine retries instead of exiting", async () => {
    // The engine has already drained, so a transient failure here must not take
    // the container down with it — poll again and try to bring it back.
    // Two failures, because the drained child's exit wakes the loop once more
    // straight away: the fleet retries immediately, then falls back to the poll
    // cadence. Both attempts have to fail for "nothing is running" to hold.
    const h = soloHarness({
      launch: async (attempt) => {
        if (attempt === 1 || attempt === 2) throw new Error("network is down");
        return {
          entry: `/engine/${attempt}/src/cli.ts`,
          sha: SHA_A,
          config: attempt === 0 ? "1:2" : "9:9",
          source: { ...DEFAULT_ENGINE_SOURCE, ref: attempt === 0 ? "main" : "next" },
          quarantinedSha: null,
          guarded: true,
          confirmEngineSource: async () => ({ ...DEFAULT_ENGINE_SOURCE, ref: "next" }),
          sample: () => ({ config: "9:9", remoteSha: SHA_A }),
        };
      },
    });
    await settle();
    expect(h.entries).toEqual(["/engine/0/src/cli.ts"]);

    h.tick();
    await settle();
    h.children[0]?.exit();
    await settle();

    // Both attempts threw; nothing new is running yet — and boot is still up.
    expect(h.entries).toHaveLength(1);

    h.tick();
    await settle();
    expect(h.entries).toEqual(["/engine/0/src/cli.ts", "/engine/3/src/cli.ts"]);

    h.requestStop();
    await settle();
    h.children[1]?.exit();
    await h.result;
  });

  test("a failure on the very first launch is fatal — a bad config fails loudly", async () => {
    const h = soloHarness({
      launch: () => {
        throw new Error("no engine is mounted at /opt/phoebe-engine");
      },
    });

    await expect(h.result).rejects.toThrow(/no engine is mounted/);
  });

  test("every finished run is reported, with what it exited as and how long it lived", async () => {
    // The crash-loop guard is only as good as this hook: it is where boot learns
    // that a commit ran healthily (or died on startup).
    const h = soloHarness();
    await settle();

    h.advance(1_500);
    h.children[0]?.exit({ code: 7, signal: null });
    await h.result;

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.tenantId).toBe(SOLO_ROW.id);
    expect(h.runs[0]?.exit).toEqual({ code: 7, signal: null });
    expect(h.runs[0]?.elapsedMs).toBe(1_500);
    expect(h.runs[0]?.engine.sha).toBe(SHA_A);
    // The engine went of its own accord — this exit is evidence about the commit.
    expect(h.runs[0]?.requestedStop).toBe(false);
  });

  test("a run boot ended is flagged as such, however it ended", async () => {
    // The guard must be able to tell "this commit died" from "we stopped it":
    // crediting or blaming a run boot cut short would corrupt the record.
    const h = soloHarness();
    await settle();

    h.state.config = "9:9";
    h.state.source = { source: "github", ref: "next", repo: "JesusFilm/phoebe" };
    h.tick();
    await settle();
    h.children[0]?.exit();
    await settle();
    expect(h.runs[0]?.requestedStop).toBe(true);

    h.requestStop();
    await settle();
    h.children[1]?.exit();
    await h.result;
    expect(h.runs[1]?.requestedStop).toBe(true);
  });

  test("each poll reports how long the engine has been up", async () => {
    // How a commit that never exits still gets banked as last-good.
    const h = soloHarness();
    await settle();
    expect(h.ticks).toEqual([]);

    h.advance(30_000);
    h.tick();
    await settle();
    h.advance(30_000);
    h.tick();
    await settle();

    expect(h.ticks).toEqual([30_000, 60_000]);

    h.requestStop();
    await settle();
    h.children[0]?.exit();
    await h.result;
  });

  test("a run drained for a reconcile is reported too, and the next run times itself", async () => {
    // A long, healthy run that ends in a config-change drain is exactly what
    // should be remembered as last-good — so it has to reach the hook as well.
    const h = soloHarness();
    await settle();

    h.advance(90_000);
    h.state.config = "9:9";
    h.state.source = { source: "github", ref: "next", repo: "JesusFilm/phoebe" };
    h.tick();
    await settle();
    h.children[0]?.exit();
    await settle();

    expect(h.runs.map((run) => run.elapsedMs)).toEqual([90_000]);

    h.advance(400);
    h.requestStop();
    await settle();
    h.children[1]?.exit();
    await h.result;

    expect(h.runs.map((run) => run.elapsedMs)).toEqual([90_000, 400]);
  });

  test("a crash the guard wants to survive relaunches instead of ending the container", async () => {
    const seen: FleetRun[] = [];
    const h = soloHarness({
      decide: (run) => {
        seen.push(run);
        return "relaunch";
      },
    });
    await settle();

    h.advance(300);
    h.children[0]?.exit({ code: 1, signal: null });
    await settle();

    // Backed off first — a commit that dies instantly must not spin the loop.
    expect(h.entries).toHaveLength(1);
    expect(seen[0]?.elapsedMs).toBe(300);

    h.tick();
    await settle();
    // A fresh `launch`, not a bare respawn: the fallback to a last-good commit
    // only takes effect through re-materializing the engine.
    expect(h.entries).toEqual(["/engine/0/src/cli.ts", "/engine/1/src/cli.ts"]);

    h.requestStop();
    await settle();
    h.children[1]?.exit();
    await h.result;
  });

  test("a stop landing during the crash backoff does not respawn into a shutdown", async () => {
    const h = soloHarness({ decide: () => "relaunch" });
    await settle();

    h.children[0]?.exit({ code: 1, signal: null });
    await settle();
    h.requestStop();
    await settle();

    // The crash is still what the container exits with — a shutdown mid-backoff
    // should not launder a failing engine into a clean stop.
    expect(h.entries).toHaveLength(1);
    expect(await h.result).toEqual({ code: 1, signal: null });
  });

  test("a stop and a crash arriving together propagates the crash, not a relaunch", async () => {
    // The container is going down; the engine's exit is the container's exit,
    // whatever the guard would have preferred.
    const h = soloHarness({ decide: () => "relaunch" });
    await settle();

    h.requestStop();
    await settle();
    h.children[0]?.exit({ code: 1, signal: null });

    expect(await h.result).toEqual({ code: 1, signal: null });
    expect(h.entries).toHaveLength(1);
  });
});
