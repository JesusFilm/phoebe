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
