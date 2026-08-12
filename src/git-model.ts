// Origin-hub git model: a private clone owns all local git state, work units
// run in worktrees off it, finished branches push straight to origin. Every
// function takes the clone directory explicitly so tests can run against a
// temp clone.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { asSha, type BranchRef, type Sha } from "./branded.ts";

export type GitRunner = (
  args: string[],
  opts?: { cwd?: string; stdio?: "inherit" | "ignore" | "pipe"; timeout?: number },
) => string;

export const defaultGit: GitRunner = (args, opts) =>
  execFileSync("git", args, {
    encoding: "utf8",
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    ...(opts?.stdio ? { stdio: opts.stdio } : {}),
    // A network git call on the supervisor's event loop (reconcile's `ls-remote`)
    // must not block it forever on a hung remote — the caller bounds it.
    ...(opts?.timeout ? { timeout: opts.timeout } : {}),
  }) as unknown as string;

/**
 * How long `git gc`'s automatic housekeeping keeps a worktree's administrative
 * files around once its directory goes missing, before treating them as
 * reclaimable. Git's own default (`3.months.ago`) is sized for a worktree that
 * lives on removable media and might legitimately vanish for a season; a
 * crashed container's worktree lives on this host's volume, and no unit here
 * runs anywhere near long enough (`runTimeoutMs` defaults to 45 minutes) to
 * need more than a few days of slack before its stale metadata is swept.
 */
const WORKTREE_PRUNE_EXPIRE = "3.days.ago";

/**
 * Clone the repo into `repoDir` unless a clone already exists there.
 *
 * An existing clone is only adopted if its `origin` actually points at
 * `repoUrl`. Each tenant's `/data/repos/<owner>/<repo>/repo` dir is supposed to
 * be that tenant's private clone, but two Phoebe containers on one host can end
 * up sharing the `phoebe-data` volume (a compose project-name collision
 * namespaces the "private" volumes identically). Adopting
 * a foreign clone by mere presence of `.git` would silently run every worktree,
 * branch, and push against the wrong repo while `gh` calls still used this
 * instance's `repoSlug` — reading one repo's issues and doing the work on
 * another's tree. So a mismatch fails loudly instead: isolate the instances (see
 * `COMPOSE_PROJECT_NAME`) or wipe the shared volume.
 */
export function ensureClone(
  opts: { repoUrl: string; repoDir: string },
  git: GitRunner = defaultGit,
): void {
  if (existsSync(join(opts.repoDir, ".git"))) {
    // `git config --get` exits non-zero when the key is unset, which `defaultGit`
    // surfaces as a throw. An unreadable origin is not the configured `repoUrl`,
    // so treat it as an absent origin and fall through to the refusal below —
    // reaching the explicit `<none>` message rather than a raw `Command failed`.
    let origin = "";
    try {
      origin = git(["config", "--get", "remote.origin.url"], { cwd: opts.repoDir }).trim();
    } catch {
      origin = "";
    }
    if (origin !== opts.repoUrl) {
      throw new Error(
        `Existing clone at ${opts.repoDir} has origin \`${origin || "<none>"}\`, but this ` +
          `Phoebe is configured for \`${opts.repoUrl}\`. Refusing to work a foreign clone — the ` +
          `state volume is shared with another instance. Give each instance a distinct compose ` +
          `project (COMPOSE_PROJECT_NAME), or wipe this volume, then retry.`,
      );
    }
    return;
  }
  mkdirSync(opts.repoDir, { recursive: true });
  git(["clone", opts.repoUrl, opts.repoDir], { stdio: "inherit" });
  git(["config", "gc.worktreePruneExpire", WORKTREE_PRUNE_EXPIRE], { cwd: opts.repoDir });
}

export function fetchOrigin(repoDir: string, git: GitRunner = defaultGit): void {
  git(["fetch", "origin"], { cwd: repoDir, stdio: "inherit" });
}

export function originBranchSha(
  repoDir: string,
  branch: BranchRef,
  git: GitRunner = defaultGit,
): Sha {
  return asSha(git(["rev-parse", `origin/${branch}`], { cwd: repoDir }).trim());
}

/** Filesystem-safe worktree directory name for a branch. */
export function worktreeDirForBranch(worktreesDir: string, branch: BranchRef): string {
  return join(worktreesDir, branch.toLowerCase().replace(/[^a-z0-9]/g, "-"));
}

/** Create a worktree on a (possibly new) branch reset to `baseRef`. */
export function addWorktreeForNewBranch(
  opts: { repoDir: string; worktreeDir: string; branch: BranchRef; baseRef: string },
  git: GitRunner = defaultGit,
): void {
  git(["worktree", "add", "-B", opts.branch, opts.worktreeDir, opts.baseRef], {
    cwd: opts.repoDir,
    stdio: "inherit",
  });
}

/** Create a worktree on an existing branch (local first, then origin/<branch>). */
export function addWorktreeForExistingBranch(
  opts: { repoDir: string; worktreeDir: string; branch: BranchRef },
  git: GitRunner = defaultGit,
): void {
  try {
    git(["worktree", "add", opts.worktreeDir, opts.branch], {
      cwd: opts.repoDir,
      stdio: "inherit",
    });
  } catch {
    git(["worktree", "add", "-B", opts.branch, opts.worktreeDir, `origin/${opts.branch}`], {
      cwd: opts.repoDir,
      stdio: "inherit",
    });
  }
}

/**
 * Mark a worktree locked — `git worktree remove`/`prune` both refuse to touch
 * it (short of `--force --force`) until `unlockWorktree` lifts it. Meant to
 * bracket a live unit: lock before the agent starts, unlock when it's done,
 * so nothing sweeps the worktree out from under a run that's still going.
 * `reason` shows up in `git worktree list` for anyone inspecting the clone.
 */
export function lockWorktree(
  repoDir: string,
  worktreeDir: string,
  reason: string,
  git: GitRunner = defaultGit,
): void {
  git(["worktree", "lock", "--reason", reason, worktreeDir], { cwd: repoDir, stdio: "ignore" });
}

/**
 * Undo `lockWorktree`. Best-effort by design: this is also the unlock path a
 * locked worktree needs when its engine dies without ever calling it back —
 * the crash-loop fallback (`bootstrap/crash-loop.ts`) can call this on
 * restart for any worktree its last run left locked, and "wasn't locked" or
 * "already gone" must not be errors there, only a genuine git failure would
 * be. `removeWorktree` below also calls this on every worktree it clears, so
 * a stale lock never outlives the engine that forgot to release it.
 */
export function unlockWorktree(
  repoDir: string,
  worktreeDir: string,
  git: GitRunner = defaultGit,
): void {
  try {
    git(["worktree", "unlock", worktreeDir], { cwd: repoDir, stdio: "ignore" });
  } catch {
    // Not locked, or already gone — nothing to undo.
  }
}

/**
 * Re-sync every linked worktree's administrative links against `repoDir`.
 * Run this after the volume the clone and its worktrees live on gets
 * remounted (or reappears after being briefly unavailable) — without it,
 * `git worktree list` and worktree-scoped git commands keep tripping over
 * stale paths recorded before the remount.
 */
export function repairWorktree(repoDir: string, git: GitRunner = defaultGit): void {
  git(["worktree", "repair"], { cwd: repoDir, stdio: "inherit" });
}

/** True when `worktreeDir`'s working tree has staged, unstaged, or untracked changes. */
function hasUncommittedChanges(worktreeDir: string, git: GitRunner): boolean {
  return git(["status", "--porcelain"], { cwd: worktreeDir }).trim().length > 0;
}

/**
 * True when `worktreeDir`'s HEAD is not reachable from any remote-tracking
 * branch — the sign that removing the worktree would discard commits that
 * exist nowhere else. A fresh worktree whose HEAD is still its unmodified
 * base commit is *not* unpushed by this measure: that commit already lives on
 * `origin/<base>` under a different name, so there is nothing unique to lose.
 */
function hasUnpushedCommits(worktreeDir: string, git: GitRunner): boolean {
  return git(["branch", "-r", "--contains", "HEAD"], { cwd: worktreeDir }).trim().length === 0;
}

/**
 * Remove a worktree and prune its administrative state.
 *
 * Refuses by default when the worktree holds uncommitted changes or commits
 * absent from every remote — the case this exists for is a crash mid-push,
 * where the only copy of finished work is sitting in the worktree a `finally`
 * block is about to discard unconditionally. Pass `{ force: true }` to remove
 * it anyway — an operator has looked and confirmed it is safe to drop, or a
 * caller is intentionally overwriting a branch it owns.
 *
 * Unlocks the worktree (best-effort) before removing it either way: a lock
 * left by `lockWorktree` must not turn into the reason a now-safe-to-clear
 * worktree can never be reclaimed.
 */
export function removeWorktree(
  repoDir: string,
  worktreeDir: string,
  opts: { force?: boolean } = {},
  git: GitRunner = defaultGit,
): void {
  if (!opts.force && existsSync(worktreeDir)) {
    let unsafe: boolean;
    try {
      unsafe = hasUncommittedChanges(worktreeDir, git) || hasUnpushedCommits(worktreeDir, git);
    } catch {
      // Can't prove it's safe to discard — refuse rather than guess.
      unsafe = true;
    }
    if (unsafe) {
      throw new Error(
        `Refusing to remove worktree at ${worktreeDir} — it has uncommitted or unpushed work. ` +
          `Push or commit it, or pass { force: true } to discard it.`,
      );
    }
  }
  unlockWorktree(repoDir, worktreeDir, git);
  try {
    git(["worktree", "remove", "--force", worktreeDir], { cwd: repoDir, stdio: "ignore" });
  } catch {
    rmSync(worktreeDir, { recursive: true, force: true });
  }
  try {
    git(["worktree", "prune"], { cwd: repoDir, stdio: "ignore" });
  } catch {
    // Best-effort.
  }
}

export function commitCount(
  worktreeDir: string,
  range: string,
  git: GitRunner = defaultGit,
): number {
  return Number(git(["rev-list", "--count", range], { cwd: worktreeDir }).trim());
}

export function pushBranch(
  worktreeDir: string,
  branch: BranchRef,
  git: GitRunner = defaultGit,
): void {
  git(["push", "origin", branch], { cwd: worktreeDir, stdio: "inherit" });
}
