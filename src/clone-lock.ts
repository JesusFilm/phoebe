// The clone lock (#418) — the one place two engine processes on a fresh tenant
// have to take turns.
//
// Every other shared-clone operation is safe to run concurrently: fetch and
// worktree administration are guarded by git's own ref locking, and the fetch
// backoff already absorbs the blips that produces. The first clone is not. Two
// processes racing `git clone` into one empty directory produce a half-written
// tree, an adopted-but-incomplete clone, or a hard failure — so it is
// serialized, and nothing else is.
//
// `mkdir` is the primitive: it is atomic on every filesystem the container
// mounts, needs no daemon, and leaves a directory a human can delete. The lock
// lives under the tenant's own `state/` dir, so it is per-tenant by
// construction. It is emphatically *not* a tenant mutex — it is held for one
// clone and released, and a process that finds a clone already there takes it,
// sees the work is done, and moves on.

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSleepSync, type SleepSync } from "./backoff.ts";

/** The lock directory inside a tenant's `state/` dir. */
export const CLONE_LOCK_DIR = "clone.lock";

/** How long a process waits between attempts to take the lock. */
const POLL_MS = 500;

/**
 * How old a lock has to be before a waiter breaks it. Generous on purpose: the
 * only thing under the lock is one `git clone`, and a large repo on a slow
 * link legitimately takes minutes. A lock older than this means the process
 * that took it died — the alternative to breaking it is a tenant wedged until
 * a human deletes a directory.
 */
const STALE_AFTER_MS = 30 * 60 * 1000;

export type CloneLockOptions = {
  sleepSync?: SleepSync;
  now?: () => number;
  staleAfterMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
};

/** Age of the lock directory in ms, or `null` when it is already gone. */
function lockAgeMs(lockDir: string, now: number): number | null {
  try {
    return now - statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Run `fn` holding the tenant's clone lock, waiting for whoever holds it now.
 * Released in `finally`, so a throwing `fn` does not strand the next process.
 *
 * The waiter breaks a lock older than `staleAfterMs` rather than waiting
 * forever on a dead holder, and says so — an unexplained break is the kind of
 * thing an operator finds out about from the damage.
 */
export function withCloneLock<T>(stateDir: string, fn: () => T, opts: CloneLockOptions = {}): T {
  const sleepSync = opts.sleepSync ?? defaultSleepSync;
  const now = opts.now ?? (() => Date.now());
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  const lockDir = join(stateDir, CLONE_LOCK_DIR);

  mkdirSync(stateDir, { recursive: true });
  let waiting = false;
  for (;;) {
    try {
      // `recursive: false` is the whole mechanism: it makes the call fail with
      // EEXIST when someone else got here first, which `recursive: true` would
      // silently swallow.
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!waiting) {
        log(`waiting for the clone lock at ${lockDir} — another pipeline is cloning.`);
        waiting = true;
      }
      const age = lockAgeMs(lockDir, now());
      if (age !== null && age > staleAfterMs) {
        log(
          `breaking the clone lock at ${lockDir} — held for ` +
            `${Math.round(age / 60_000)}min, so its holder is gone.`,
        );
        rmSync(lockDir, { recursive: true, force: true });
      }
      sleepSync(pollMs);
    }
  }

  try {
    // Diagnostic only — nothing reads it back. It is what turns a stuck lock
    // into a question an operator can answer.
    writeFileSync(join(lockDir, "owner"), `pid=${process.pid}\n`);
  } catch {
    // A lock we hold but cannot describe is still a lock.
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
