// The clone lock (#418): two pipelines booting on a fresh tenant produce one
// clone. Exercised against a real directory, because `mkdir`'s EEXIST is the
// whole mechanism and a stub of it would test nothing.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { CLONE_LOCK_DIR, withCloneLock } from "./clone-lock.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = join(mkdtempSync(join(tmpdir(), "phoebe-clone-lock-")), "state");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("withCloneLock", () => {
  test("takes the lock, runs the body, and releases it", () => {
    const seen: string[] = [];
    const result = withCloneLock(stateDir, () => {
      seen.push("body");
      expect(existsSync(join(stateDir, CLONE_LOCK_DIR))).toBe(true);
      return "cloned";
    });

    expect(result).toBe("cloned");
    expect(seen).toEqual(["body"]);
    expect(existsSync(join(stateDir, CLONE_LOCK_DIR))).toBe(false);
  });

  test("creates the state dir it locks under", () => {
    withCloneLock(stateDir, () => undefined);
    expect(existsSync(stateDir)).toBe(true);
  });

  // The acceptance case, with the second process's wait made synchronous: the
  // held lock is released from inside the fake sleep, standing in for the
  // holder finishing its clone.
  test("a second process waits for the holder, then proceeds", () => {
    mkdirSync(join(stateDir, CLONE_LOCK_DIR), { recursive: true });
    const lines: string[] = [];
    let slept = 0;
    let ran = false;

    withCloneLock(
      stateDir,
      () => {
        ran = true;
      },
      {
        log: (line) => lines.push(line),
        sleepSync: () => {
          slept++;
          // The holder finishes its clone and lets go.
          rmSync(join(stateDir, CLONE_LOCK_DIR), { recursive: true, force: true });
        },
      },
    );

    expect(slept).toBe(1);
    expect(ran).toBe(true);
    expect(lines.some((line) => line.includes("waiting for the clone lock"))).toBe(true);
  });

  test("says it is waiting once, not once per poll", () => {
    mkdirSync(join(stateDir, CLONE_LOCK_DIR), { recursive: true });
    const lines: string[] = [];
    let slept = 0;

    withCloneLock(stateDir, () => undefined, {
      log: (line) => lines.push(line),
      sleepSync: () => {
        if (++slept === 3) rmSync(join(stateDir, CLONE_LOCK_DIR), { recursive: true, force: true });
      },
    });

    expect(slept).toBe(3);
    expect(lines.filter((line) => line.includes("waiting for the clone lock"))).toHaveLength(1);
  });

  // A holder that died mid-clone leaves the directory behind. Waiting on it
  // forever wedges the tenant until a human deletes a directory, so the waiter
  // breaks it — and says so, because a silent break is how the damage happens
  // without anyone knowing where it came from.
  test("breaks a lock whose holder is gone, and says why", () => {
    mkdirSync(join(stateDir, CLONE_LOCK_DIR), { recursive: true });
    const lines: string[] = [];
    let ran = false;

    withCloneLock(
      stateDir,
      () => {
        ran = true;
      },
      {
        log: (line) => lines.push(line),
        sleepSync: () => undefined,
        // The lock was made just now; pretend an hour has gone by.
        now: () => Date.now() + 60 * 60 * 1000,
        staleAfterMs: 30 * 60 * 1000,
      },
    );

    expect(ran).toBe(true);
    expect(lines.some((line) => line.includes("breaking the clone lock"))).toBe(true);
  });

  test("a throwing body still releases the lock", () => {
    expect(() =>
      withCloneLock(stateDir, () => {
        throw new Error("clone failed");
      }),
    ).toThrow("clone failed");
    expect(existsSync(join(stateDir, CLONE_LOCK_DIR))).toBe(false);
  });
});
