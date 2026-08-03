// The crash-loop fallback (#43): when a freshly-fetched engine SHA dies fast,
// over and over, `phoebe boot` stops chasing the tracked ref and pins back to
// the last SHA that ran healthily.
//
// Everything here is the *policy* — a fold over finished runs plus the choice of
// which commit to run next — kept pure so the whole ladder (first crash, third
// crash, fallback, recovery when the branch moves on) is asserted without
// spawning an engine or waiting out a healthy window. The persistence half is
// tested against a real temp dir, because "survives a container restart" is a
// claim about a file.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  CRASH_LOOP_THRESHOLD,
  ENGINE_STATE_DIR,
  HEALTHY_RUN_MS,
  INITIAL_CRASH_LOOP_STATE,
  crashLoopStatePath,
  createCrashGuard,
  fallbackSha,
  hasFallbackTarget,
  judgeRun,
  readCrashLoopState,
  recordRun,
  writeCrashLoopState,
  type CrashGuardEvent,
  type CrashLoopState,
} from "./crash-loop.ts";

const BAD = "b".repeat(40);
const GOOD = "9".repeat(40);
const NEXT = "e".repeat(40);

/** A run that died on startup — the shape the fallback exists to catch. */
function crash(sha: string) {
  return { sha, exitCode: 1, elapsedMs: 400, requestedStop: false };
}

/** A run that lived past the healthy window. */
function healthy(sha: string) {
  return { sha, exitCode: 0, elapsedMs: HEALTHY_RUN_MS * 2, requestedStop: false };
}

describe("judgeRun", () => {
  test("surviving the healthy window proves the commit, however the run then ended", () => {
    // The code booted and worked; whatever ended it an hour in is not a bad
    // deployment, and pinning to older code would not help.
    expect(
      judgeRun({ sha: GOOD, exitCode: 1, elapsedMs: HEALTHY_RUN_MS, requestedStop: true }),
    ).toBe("healthy");
  });

  test("exiting 0 unprompted proves it too — it finished what it was asked to do", () => {
    expect(judgeRun({ sha: GOOD, exitCode: 0, elapsedMs: 5, requestedStop: false })).toBe(
      "healthy",
    );
  });

  test("a fast non-zero exit is a crash", () => {
    expect(judgeRun(crash(BAD))).toBe("crash");
  });

  test("a run boot cut short proves nothing either way", () => {
    // This is the dangerous case: a container stop landing seconds into a
    // relaunch of a crash-looping commit. Crediting that exit as healthy would
    // promote the bad commit to last-good and disarm the fallback for good.
    expect(judgeRun({ sha: BAD, exitCode: 0, elapsedMs: 5, requestedStop: true })).toBe(
      "inconclusive",
    );
  });

  test("a signal death says nothing about the code", () => {
    // Something outside killed the process — an OOM reaper, a `docker kill`.
    expect(judgeRun({ sha: BAD, exitCode: null, elapsedMs: 5, requestedStop: false })).toBe(
      "inconclusive",
    );
  });
});

describe("recordRun", () => {
  test("a healthy run becomes the fallback target", () => {
    expect(recordRun(INITIAL_CRASH_LOOP_STATE, healthy(GOOD))).toEqual({
      lastGoodSha: GOOD,
      failingSha: null,
      failureCount: 0,
    });
  });

  test("a fast crash opens a count against its own sha", () => {
    expect(recordRun({ lastGoodSha: GOOD, failingSha: null, failureCount: 0 }, crash(BAD))).toEqual(
      {
        lastGoodSha: GOOD,
        failingSha: BAD,
        failureCount: 1,
      },
    );
  });

  test("consecutive crashes of the same sha accumulate toward the threshold", () => {
    let state: CrashLoopState = { lastGoodSha: GOOD, failingSha: null, failureCount: 0 };
    for (let i = 0; i < 3; i++) state = recordRun(state, crash(BAD));
    expect(state).toEqual({ lastGoodSha: GOOD, failingSha: BAD, failureCount: 3 });
  });

  test("a crash of a different sha starts its own count", () => {
    // The branch moved while the old commit was failing; the new commit gets a
    // clean slate rather than inheriting a verdict it did not earn.
    expect(recordRun({ lastGoodSha: GOOD, failingSha: BAD, failureCount: 2 }, crash(NEXT))).toEqual(
      { lastGoodSha: GOOD, failingSha: NEXT, failureCount: 1 },
    );
  });

  test("a healthy fallback run keeps the crash-looping sha quarantined", () => {
    // The engine is running GOOD *because* BAD is quarantined. Letting a healthy
    // fallback run clear the record would send boot straight back into BAD.
    expect(
      recordRun({ lastGoodSha: GOOD, failingSha: BAD, failureCount: 3 }, healthy(GOOD)),
    ).toEqual({ lastGoodSha: GOOD, failingSha: BAD, failureCount: 3 });
  });

  test("a healthy run of the failing sha itself lifts the quarantine", () => {
    // Whatever was wrong was transient, not the commit — stop avoiding it.
    expect(
      recordRun({ lastGoodSha: GOOD, failingSha: BAD, failureCount: 2 }, healthy(BAD)),
    ).toEqual({ lastGoodSha: BAD, failingSha: null, failureCount: 0 });
  });

  test("an inconclusive run leaves the record exactly as it was", () => {
    // A container stop landing during a crash-loop must not credit the crashing
    // commit — that would disarm the fallback permanently.
    const state: CrashLoopState = { lastGoodSha: GOOD, failingSha: BAD, failureCount: 2 };
    expect(recordRun(state, { sha: BAD, exitCode: 0, elapsedMs: 5, requestedStop: true })).toEqual(
      state,
    );
  });

  test("the fallback crashing too does not release the quarantine", () => {
    // Boot is running GOOD *because* BAD is quarantined. If GOOD dies as well,
    // the honest answer is "out of options" — not "BAD is fine again".
    const state: CrashLoopState = {
      lastGoodSha: GOOD,
      failingSha: BAD,
      failureCount: CRASH_LOOP_THRESHOLD,
    };
    expect(recordRun(state, crash(GOOD))).toEqual(state);
  });
});

describe("fallbackSha", () => {
  test("below the threshold the target still gets to run", () => {
    // A single startup crash may be a flaky network or a busy host; give the
    // configured ref its full allowance before pinning away from it.
    expect(fallbackSha(BAD, { lastGoodSha: GOOD, failingSha: BAD, failureCount: 2 })).toBeNull();
  });

  test("at the threshold the last-good sha takes over", () => {
    expect(
      fallbackSha(BAD, { lastGoodSha: GOOD, failingSha: BAD, failureCount: CRASH_LOOP_THRESHOLD }),
    ).toBe(GOOD);
  });

  test("with nothing known-good there is nowhere to fall back to", () => {
    // First boot of a fresh volume: the very first ref crash-loops and no
    // earlier commit was ever proven. Boot must fail loudly, not invent a pin.
    expect(fallbackSha(BAD, { lastGoodSha: null, failingSha: BAD, failureCount: 9 })).toBeNull();
  });

  test("falling back to the crashing sha itself would change nothing", () => {
    expect(fallbackSha(BAD, { lastGoodSha: BAD, failingSha: BAD, failureCount: 9 })).toBeNull();
  });

  test("a quarantine on some other sha does not divert this one", () => {
    // The branch advanced past the bad commit — reconcile resumes normally.
    expect(fallbackSha(NEXT, { lastGoodSha: GOOD, failingSha: BAD, failureCount: 9 })).toBeNull();
  });
});

describe("hasFallbackTarget", () => {
  test("a different known-good sha is worth relaunching for", () => {
    expect(hasFallbackTarget({ lastGoodSha: GOOD, failingSha: BAD, failureCount: 1 }, BAD)).toBe(
      true,
    );
  });

  test("nothing known-good means retrying is pointless", () => {
    expect(hasFallbackTarget(INITIAL_CRASH_LOOP_STATE, BAD)).toBe(false);
  });

  test("the known-good sha crashing is the end of the road", () => {
    // The fallback itself died fast; boot has run out of better ideas and lets
    // the container exit rather than looping on the same commit forever.
    expect(hasFallbackTarget({ lastGoodSha: GOOD, failingSha: GOOD, failureCount: 1 }, GOOD)).toBe(
      false,
    );
  });
});

describe("the ladder, end to end", () => {
  test("three fast crashes pin to last-good, and the branch moving on releases it", () => {
    let state = recordRun(INITIAL_CRASH_LOOP_STATE, healthy(GOOD));

    for (let i = 1; i <= CRASH_LOOP_THRESHOLD; i++) {
      expect(fallbackSha(BAD, state)).toBeNull();
      state = recordRun(state, crash(BAD));
    }

    // Threshold reached: boot runs GOOD instead of the tracked ref's tip.
    expect(fallbackSha(BAD, state)).toBe(GOOD);
    state = recordRun(state, healthy(GOOD));
    expect(fallbackSha(BAD, state)).toBe(GOOD);

    // A fix lands and the branch advances: the new tip is not quarantined, so
    // the fallback lapses and the new commit runs.
    expect(fallbackSha(NEXT, state)).toBeNull();
    state = recordRun(state, healthy(NEXT));
    expect(state.lastGoodSha).toBe(NEXT);
  });
});

describe("crashLoopStatePath", () => {
  test("defaults to the deployment-global engine dir when given no arg", () => {
    // The guard is fleet-wide (#60/#62): its state lives beside the shared
    // engine checkout at /data/engine, not under any tenant's state dir.
    expect(crashLoopStatePath()).toBe(join(ENGINE_STATE_DIR, "engine-crash-loop.json"));
  });

  test("joins the record filename under an explicit engine dir", () => {
    expect(crashLoopStatePath("/srv/engine")).toBe("/srv/engine/engine-crash-loop.json");
  });
});

describe("persistence", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crash-loop-test-"));
    path = crashLoopStatePath(join(dir, "state"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("state written by one boot is read back by the next", () => {
    // This is the whole "survives a container restart" claim.
    const state: CrashLoopState = { lastGoodSha: GOOD, failingSha: BAD, failureCount: 3 };
    writeCrashLoopState(path, state);
    expect(readCrashLoopState(path)).toEqual(state);
  });

  test("writing creates the state dir when the volume is empty", () => {
    writeCrashLoopState(path, INITIAL_CRASH_LOOP_STATE);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(INITIAL_CRASH_LOOP_STATE);
  });

  test("no file yet means nothing is known — not an error", () => {
    expect(readCrashLoopState(join(dir, "absent.json"))).toEqual(INITIAL_CRASH_LOOP_STATE);
  });

  test("an unparseable file is discarded rather than crashing boot", () => {
    // A half-written file (container killed mid-write) must not brick the
    // bootstrapper; the worst case is losing one fallback target.
    writeCrashLoopState(path, INITIAL_CRASH_LOOP_STATE);
    writeFileSync(path, "{ not json");
    expect(readCrashLoopState(path)).toEqual(INITIAL_CRASH_LOOP_STATE);
  });

  test("a file of the wrong shape is discarded too", () => {
    writeCrashLoopState(path, INITIAL_CRASH_LOOP_STATE);
    writeFileSync(path, JSON.stringify({ lastGoodSha: 12, failureCount: "many" }));
    expect(readCrashLoopState(path)).toEqual(INITIAL_CRASH_LOOP_STATE);
  });
});

describe("createCrashGuard", () => {
  let dir: string;
  let path: string;
  let events: CrashGuardEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crash-guard-test-"));
    path = crashLoopStatePath(join(dir, "state"));
    events = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const guard = () => createCrashGuard({ statePath: path, onEvent: (e) => events.push(e) });
  const kinds = () => events.map((event) => event.kind);

  test("a healthy engine leaves the guard with nothing to do", () => {
    const g = guard();
    g.record(healthy(GOOD));
    expect(g.fallbackFor(GOOD)).toBeNull();
    expect(g.shouldRetry(healthy(GOOD))).toBe(false);
    expect(kinds()).toEqual(["last-good"]);
  });

  test("a crash-looping tip is pinned to the last-good commit once the threshold is met", () => {
    const g = guard();
    g.record(healthy(GOOD));

    for (let i = 1; i <= CRASH_LOOP_THRESHOLD; i++) {
      expect(g.fallbackFor(BAD)).toBeNull();
      // Worth another go: there is a better commit to end up on.
      expect(g.shouldRetry(crash(BAD))).toBe(true);
      g.record(crash(BAD));
    }

    expect(g.fallbackFor(BAD)).toBe(GOOD);
    expect(kinds()).toEqual(["last-good", "crash", "crash", "crash", "fallback"]);
    expect(events.at(-1)).toMatchObject({
      kind: "fallback",
      quarantinedSha: BAD,
      lastGoodSha: GOOD,
      failureCount: CRASH_LOOP_THRESHOLD,
    });
  });

  test("the pin outlives the container — a fresh guard reads the same verdict", () => {
    const first = guard();
    first.record(healthy(GOOD));
    for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) first.record(crash(BAD));

    // A new boot, same state volume: it must not have to re-learn the crash.
    events = [];
    expect(guard().fallbackFor(BAD)).toBe(GOOD);
    expect(kinds()).toEqual(["fallback"]);
  });

  test("running the fallback does not un-quarantine the bad commit", () => {
    const g = guard();
    g.record(healthy(GOOD));
    for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) g.record(crash(BAD));

    g.record(healthy(GOOD));
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("the tracked ref moving past the bad commit lifts the fallback, once", () => {
    const g = guard();
    g.record(healthy(GOOD));
    for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) g.record(crash(BAD));
    expect(g.fallbackFor(BAD)).toBe(GOOD);

    events = [];
    // A fix landed; the tip is a commit nobody has a verdict on, so it runs.
    expect(g.fallbackFor(NEXT)).toBeNull();
    expect(events).toEqual([{ kind: "recovered", quarantinedSha: BAD, sha: NEXT }]);

    // And the stale quarantine is gone rather than being re-announced forever.
    events = [];
    expect(g.fallbackFor(NEXT)).toBeNull();
    expect(events).toEqual([]);
    expect(readCrashLoopState(path).failingSha).toBeNull();
  });

  test("a crash with nothing known-good is not worth retrying", () => {
    // First boot onto a broken ref: there is no better commit to reach, so boot
    // lets the container exit where an operator can see it.
    expect(guard().shouldRetry(crash(BAD))).toBe(false);
  });

  test("the fallback crashing too is the end of the road, and BAD stays quarantined", () => {
    const g = guard();
    g.record(healthy(GOOD));
    for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) g.record(crash(BAD));
    expect(g.fallbackFor(BAD)).toBe(GOOD);

    expect(g.shouldRetry(crash(GOOD))).toBe(false);
    events = [];
    g.record(crash(GOOD));
    expect(events).toEqual([
      { kind: "fallback-crashed", sha: GOOD, quarantinedSha: BAD, exitCode: 1, elapsedMs: 400 },
    ]);
    // The container exits and comes back onto the same bad tip; the pin holds.
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("a long-running engine is banked as last-good while it is still running", () => {
    // An engine up for a month that is then killed outright (host reboot, OOM)
    // exits without ever being judged. Without this, the bad commit waiting on
    // the branch would have nothing to fall back to.
    const g = guard();
    g.noteAlive(GOOD, HEALTHY_RUN_MS);
    expect(kinds()).toEqual(["last-good"]);
    expect(readCrashLoopState(path).lastGoodSha).toBe(GOOD);

    // Only once, though — every poll tick calls this.
    events = [];
    g.noteAlive(GOOD, HEALTHY_RUN_MS * 10);
    expect(events).toEqual([]);
  });

  test("a young engine has not proved anything yet", () => {
    const g = guard();
    g.noteAlive(BAD, HEALTHY_RUN_MS - 1);
    expect(events).toEqual([]);
    expect(readCrashLoopState(path)).toEqual(INITIAL_CRASH_LOOP_STATE);
  });

  test("an engine outliving the window while a commit is quarantined keeps the quarantine", () => {
    const g = guard();
    g.record(healthy(GOOD));
    for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) g.record(crash(BAD));

    // The fallback run of GOOD survives the window — that must not free BAD.
    g.noteAlive(GOOD, HEALTHY_RUN_MS * 5);
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("a healthy exit is never a reason to relaunch", () => {
    const g = guard();
    g.record(healthy(GOOD));
    expect(g.shouldRetry({ sha: BAD, exitCode: 0, elapsedMs: 5, requestedStop: false })).toBe(
      false,
    );
  });

  test("a run boot cut short is not a reason to relaunch either", () => {
    // Boot is already deciding what happens next; a stop is not a crash.
    const g = guard();
    g.record(healthy(GOOD));
    expect(g.shouldRetry({ sha: BAD, exitCode: 1, elapsedMs: 5, requestedStop: true })).toBe(false);
  });

  test("an unwritable state dir is reported, not thrown — boot still runs", () => {
    // The state volume is missing or read-only. Losing the fallback is bad;
    // refusing to run the engine over it would be worse.
    const blocked = join(dir, "file");
    writeFileSync(blocked, "not a directory");
    const g = createCrashGuard({
      statePath: join(blocked, "state.json"),
      onEvent: (event) => events.push(event),
    });

    expect(() => g.record(healthy(GOOD))).not.toThrow();
    expect(kinds()).toContain("persist-failed");
    // In-memory bookkeeping still works for the life of this container.
    expect(g.shouldRetry(crash(BAD))).toBe(true);
  });
});
