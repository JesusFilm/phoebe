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
  opts?: { cwd?: string; stdio?: "inherit" | "ignore" | "pipe" },
) => string;

export const defaultGit: GitRunner = (args, opts) =>
  execFileSync("git", args, {
    encoding: "utf8",
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    ...(opts?.stdio ? { stdio: opts.stdio } : {}),
  }) as unknown as string;

/** Clone the repo into `repoDir` unless a clone already exists there. */
export function ensureClone(
  opts: { repoUrl: string; repoDir: string },
  git: GitRunner = defaultGit,
): void {
  if (existsSync(join(opts.repoDir, ".git"))) return;
  mkdirSync(opts.repoDir, { recursive: true });
  git(["clone", opts.repoUrl, opts.repoDir], { stdio: "inherit" });
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

export function removeWorktree(
  repoDir: string,
  worktreeDir: string,
  git: GitRunner = defaultGit,
): void {
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
