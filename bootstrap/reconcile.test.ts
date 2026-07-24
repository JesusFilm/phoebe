// The reconcile watch loop (#42): while the engine runs, `phoebe boot` polls the
// mounted config and the tracked ref, and on a change drains the engine
// (SIGTERM) and relaunches it in the same container.
//
// Two seams are tested here. `detectChange` is the pure decision — "is the
// running engine stale?" — comparing what is live now against what the running
// engine was launched from. `superviseEngine` is the loop, driven through
// injected fakes (a scripted child, a gated clock, a stop latch) so the
// drain-then-relaunch ordering is asserted without spawning processes or
// waiting on real timers.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  configFingerprint,
  detectChange,
  superviseEngine,
  type EngineExit,
  type LaunchedEngine,
  type SupervisedChild,
  type WatchState,
} from "./reconcile.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("detectChange", () => {
  test("nothing moved — no relaunch", () => {
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "1:2", remoteSha: SHA_A },
      }),
    ).toBeNull();
  });

  test("the mounted config changed — relaunch to re-read the engine source", () => {
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "9:9", remoteSha: SHA_A },
      }),
    ).toBe("config");
  });

  test("the tracked ref advanced past the running commit — relaunch onto it", () => {
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "1:2", remoteSha: SHA_B },
      }),
    ).toBe("ref");
  });

  test("a pinned ref reports nothing to watch, so it never relaunches", () => {
    // `lsRemoteBranchSha` returns null for a pinned SHA/tag; the running commit
    // is whatever that pin resolved to, and must not be read as a mismatch.
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "1:2", remoteSha: null },
      }),
    ).toBeNull();
  });

  test("a local mount has no commit to compare, so the ref-watch is inert", () => {
    expect(
      detectChange({
        launched: { config: "1:2", sha: null },
        current: { config: "1:2", remoteSha: SHA_B },
      }),
    ).toBeNull();
  });

  test("an unreadable config is treated as unchanged, not as a change", () => {
    // A config being rewritten (or a mount blipping) must not relaunch the
    // engine on the strength of a failed stat.
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: null, remoteSha: SHA_A },
      }),
    ).toBeNull();
  });

  test("a config change is reported ahead of a ref change when both moved", () => {
    // Re-reading the config may itself change which ref is tracked, so it wins.
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "9:9", remoteSha: SHA_B },
      }),
    ).toBe("config");
  });
});

describe("configFingerprint", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
    path = join(dir, "phoebe.config.ts");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stable file fingerprints the same twice (a no-change poll is a stat)", () => {
    writeFileSync(path, "export default {}");
    expect(configFingerprint(path)).toBe(configFingerprint(path));
  });

  test("an edit changes the fingerprint", () => {
    writeFileSync(path, "export default {}");
    const before = configFingerprint(path);
    writeFileSync(path, "export default { engine: { source: 'local' } }");
    expect(configFingerprint(path)).not.toBe(before);
  });

  test("a same-size rewrite is still caught (mtime moves even when size does not)", () => {
    const stat = (() => {
      let mtimeMs = 1;
      return () => ({ mtimeMs: mtimeMs++, size: 10 });
    })();
    expect(configFingerprint(path, stat)).not.toBe(configFingerprint(path, stat));
  });

  test("a missing file fingerprints as null rather than throwing", () => {
    expect(configFingerprint(join(dir, "gone.ts"))).toBeNull();
  });
});

// --- superviseEngine --------------------------------------------------------

/** A stand-in engine process whose exit the test controls. */
function fakeChild(): {
  child: SupervisedChild;
  kills: string[];
  exit: (exit?: EngineExit) => void;
} {
  const kills: string[] = [];
  let settle: (exit: EngineExit) => void;
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

/** A poll clock the test advances by hand — no real timers in the loop tests. */
function gatedClock(): { wait: () => Promise<void>; tick: () => void } {
  const pending: Array<() => void> = [];
  return {
    wait: () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
    tick: () => pending.shift()?.(),
  };
}

/** Let the loop's queued microtasks/promises settle before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A supervised run wired to fakes. `state` is the live world the poll samples;
 * mutate it to simulate an edited config or an advanced ref, then `tick()`.
 */
function harness(
  options: {
    launch?: (attempt: number) => Promise<LaunchedEngine> | LaunchedEngine;
  } = {},
) {
  const clock = gatedClock();
  const state: WatchState & { sha: string | null } = {
    config: "1:2",
    remoteSha: SHA_A,
    sha: SHA_A,
  };
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const entries: string[] = [];
  const relaunches: string[] = [];
  let stopRequested = false;
  let attempt = 0;

  const result = superviseEngine({
    launch: async () => {
      const n = attempt++;
      if (options.launch) return await options.launch(n);
      return {
        entry: `/engine/${n}/src/cli.ts`,
        sha: state.sha,
        config: state.config,
        sample: () => ({ config: state.config, remoteSha: state.remoteSha }),
      };
    },
    spawn: (entry) => {
      entries.push(entry);
      const next = fakeChild();
      children.push(next);
      return next.child;
    },
    stop: {
      get requested() {
        return stopRequested;
      },
      wait: clock.wait,
    },
    onRelaunch: (reason) => relaunches.push(reason),
  });

  return {
    result,
    state,
    children,
    entries,
    relaunches,
    tick: clock.tick,
    requestStop: () => {
      stopRequested = true;
      clock.tick();
    },
  };
}

describe("superviseEngine", () => {
  test("runs the engine and stays out of its way while nothing changes", async () => {
    const h = harness();
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
    const h = harness();
    await settle();

    h.children[0]?.exit({ code: 3, signal: null });

    expect(await h.result).toEqual({ code: 3, signal: null });
    expect(h.entries).toHaveLength(1);
  });

  test("editing the mounted config drains the engine, then relaunches it", async () => {
    const h = harness();
    await settle();

    h.state.config = "9:9";
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

  test("the tracked ref advancing relaunches the engine on the new commit", async () => {
    const h = harness();
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
    const h = harness();
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
    const h = harness();
    await settle();

    h.state.config = "9:9";
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
    const h = harness({
      launch: async (attempt) => {
        if (attempt === 1) throw new Error("network is down");
        return {
          entry: `/engine/${attempt}/src/cli.ts`,
          sha: SHA_A,
          config: attempt === 0 ? "1:2" : "9:9",
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

    // Attempt 1 threw; nothing new is running yet.
    expect(h.entries).toHaveLength(1);

    h.tick();
    await settle();
    expect(h.entries).toEqual(["/engine/0/src/cli.ts", "/engine/2/src/cli.ts"]);

    h.requestStop();
    await settle();
    h.children[1]?.exit();
    await h.result;
  });

  test("a failure on the very first launch is fatal — a bad config fails loudly", async () => {
    const h = harness({
      launch: () => {
        throw new Error("no engine is mounted at /opt/phoebe-engine");
      },
    });

    await expect(h.result).rejects.toThrow(/no engine is mounted/);
  });
});
