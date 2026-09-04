// Origin-hub git model: a private clone owns all local git state, work units
// run in worktrees off it, finished branches push straight to origin. Every
// function takes the clone directory explicitly so tests can run against a
// temp clone.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { withBackoffSync, type SleepSync } from "./backoff.ts";
import { asSha, type BranchRef, type Sha } from "./branded.ts";
import {
  leasePipeline,
  parseWorktreeList,
  WorktreeLeasedError,
  type WorktreeEntry,
} from "./worktree-lease.ts";

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

// GitHub's git endpoint blips too (HTTP 504 mid-negotiation reads as
// `fatal: expected 'acknowledgments'`). The runner inherits stdio, so there is
// no stderr to tell a blip from a real failure — but a fetch is idempotent, so
// every failure is worth the same two retries. A persistent cause (auth, a
// gone remote) still fails ~10s later into the caller's existing recovery.
const FETCH_RETRY_SCHEDULE_MS = [2_000, 8_000];

export function fetchOrigin(
  repoDir: string,
  git: GitRunner = defaultGit,
  sleepSync?: SleepSync,
  warn: (line: string) => void = (line) => console.warn(`[phoebe] ${line}`),
): void {
  withBackoffSync(() => git(["fetch", "origin"], { cwd: repoDir, stdio: "inherit" }), {
    scheduleMs: FETCH_RETRY_SCHEDULE_MS,
    isRetryable: () => true,
    onRetry: (_error, delayMs, retry) => {
      warn(
        `\`git fetch origin\` failed — retrying in ${delayMs / 1000}s ` +
          `(retry ${retry}/${FETCH_RETRY_SCHEDULE_MS.length}).`,
      );
    },
    ...(sleepSync ? { sleepSync } : {}),
  });
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
 * Create a worktree detached at `ref` — a checkout with no branch attached.
 *
 * The read-only workspace (#397) is this and nothing else: no local ref is
 * created or moved in the clone, and `git push` from a detached HEAD fails for
 * want of a refspec. Not a sandbox — a kind is trusted as the tenant and holds
 * the token — but the shape means publishing takes deliberate effort rather
 * than habit.
 */
export function addWorktreeDetached(
  opts: { repoDir: string; worktreeDir: string; ref: string },
  git: GitRunner = defaultGit,
): void {
  git(["worktree", "add", "--detach", opts.worktreeDir, opts.ref], {
    cwd: opts.repoDir,
    stdio: "inherit",
  });
}

/** How many paths `git status --porcelain` reports as changed in a worktree. */
export function dirtyFileCount(worktreeDir: string, git: GitRunner = defaultGit): number {
  return git(["status", "--porcelain"], { cwd: worktreeDir })
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

// --- The worktree lease (#418) -----------------------------------------------
// `git worktree lock` is the lease's enforcement, not a flag beside it: a
// locked tree refuses `worktree remove --force` (it wants a second `-f`) and
// `worktree prune` skips it. The reason string's grammar lives in
// worktree-lease.ts.

/** Take the lease on `worktreeDir`, stamping `reason` on it. */
export function lockWorktree(
  repoDir: string,
  worktreeDir: string,
  reason: string,
  git: GitRunner = defaultGit,
): void {
  git(["worktree", "lock", "--reason", reason, worktreeDir], { cwd: repoDir, stdio: "ignore" });
}

/**
 * Release the lease on `worktreeDir`. Best-effort: git exits non-zero when the
 * tree is not locked or no longer registered, and both are the state the caller
 * was asking for.
 */
export function unlockWorktree(
  repoDir: string,
  worktreeDir: string,
  git: GitRunner = defaultGit,
): void {
  try {
    git(["worktree", "unlock", worktreeDir], { cwd: repoDir, stdio: "ignore" });
  } catch {
    // Already unlocked, or already gone.
  }
}

/** Every worktree registered on the clone, with the lock reason each carries. */
export function listWorktrees(repoDir: string, git: GitRunner = defaultGit): WorktreeEntry[] {
  return parseWorktreeList(git(["worktree", "list", "--porcelain"], { cwd: repoDir }));
}

/**
 * Resolve a path for comparison against git's listing, which prints each tree's
 * real absolute path. `realpathSync` is what makes a symlinked data root
 * compare equal; a path that does not exist yet falls back to lexical
 * resolution.
 */
function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The lease on `worktreeDir`. `locked: false` covers the tree being
 * unregistered as much as unlocked; `locked: true` with a null pipeline is a
 * lock nothing here wrote — a hand-placed one — which callers treat as another
 * writer's, not their own. A clone that cannot be listed at all reports no
 * lease: there is none this process could honour, and the caller's existing
 * tolerance for a missing clone is what it falls back on.
 */
export function worktreeLease(
  repoDir: string,
  worktreeDir: string,
  git: GitRunner = defaultGit,
): { locked: boolean; pipeline: string | null } {
  let entries: WorktreeEntry[];
  try {
    entries = listWorktrees(repoDir, git);
  } catch {
    return { locked: false, pipeline: null };
  }
  const wanted = comparablePath(worktreeDir);
  const entry = entries.find((row) => comparablePath(row.dir) === wanted);
  if (!entry || entry.reason === null) return { locked: false, pipeline: null };
  return { locked: true, pipeline: leasePipeline(entry.reason) };
}

/**
 * Remove a worktree, unless it is leased.
 *
 * The lease check comes first and throws, because the fallback below is a
 * recursive delete: git's own refusal would be enough to stop `worktree
 * remove`, and the fallback would then go around it and take a sibling
 * pipeline's live tree out from under a running agent (#418). A caller drops
 * its own lease first (`unlockWorktree`); anything still locked here belongs to
 * someone else and must survive. Past the lease, the fallback stays what it
 * was: a directory left behind by a killed run is not a worktree git will
 * remove, and clearing it is how the next run self-heals.
 */
export function removeWorktree(
  repoDir: string,
  worktreeDir: string,
  git: GitRunner = defaultGit,
): void {
  const lease = worktreeLease(repoDir, worktreeDir, git);
  if (lease.locked) throw new WorktreeLeasedError(worktreeDir, lease.pipeline);
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

/**
 * Push `branch` to origin with `--force-with-lease`.
 *
 * Use this after `appendTrailerToCommits`: Phoebe owns the branch exclusively,
 * but the agent may have already published it before control returned to the
 * daemon. The trailer rewrite changes every SHA in the range, so a plain push
 * is rejected as non-fast-forward. `--force-with-lease` republishes safely —
 * it still fails loudly if any writer other than this run touched the ref.
 */
export function pushBranchWithLease(
  worktreeDir: string,
  branch: BranchRef,
  git: GitRunner = defaultGit,
): void {
  git(["push", "--force-with-lease", "origin", branch], { cwd: worktreeDir, stdio: "inherit" });
}

export type TrailerRewriteOutcome = "rewritten" | "nothing" | "skipped-merges" | "failed";

/** Single-quote `value` for POSIX `sh` — the only shell `git rebase --exec` runs through. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Append `trailer` to the message of every commit in `baseRef..HEAD` (#198).
 * Phoebe is the sole writer on issue branches, but the agent prompt includes a
 * `gh pr create` step — so the branch may already be published by the time
 * control returns here. The push that follows must use `pushBranchWithLease`
 * rather than `pushBranch`. Trees, authorship, and order are preserved; only
 * messages change.
 *
 * Runs `git rebase --exec 'git commit --amend --trailer …'` over the range with
 * `--autostash` (the agent may leave uncommitted files) and `--no-verify` on
 * both the rebase and the amend (repo hooks already ran on the original
 * commit). `trailer.ifexists=addIfDifferent` keeps a trailer the agent already
 * wrote from being duplicated.
 *
 * Never throws: credit is best-effort. A range holding a merge commit is left
 * alone (a rebase would flatten it) and reported as `skipped-merges`; a rebase
 * that fails midway is aborted so HEAD is exactly what the agent left, and
 * reported as `failed`.
 */
export function appendTrailerToCommits(
  opts: { worktreeDir: string; baseRef: string; trailer: string },
  git: GitRunner = defaultGit,
): TrailerRewriteOutcome {
  const { worktreeDir, baseRef, trailer } = opts;
  const range = `${baseRef}..HEAD`;
  if (commitCount(worktreeDir, range, git) === 0) return "nothing";
  const merges = Number(
    git(["rev-list", "--count", "--merges", range], { cwd: worktreeDir }).trim(),
  );
  if (merges > 0) return "skipped-merges";

  const amend = [
    "git",
    "-c",
    "trailer.ifexists=addIfDifferent",
    "commit",
    "--amend",
    "--no-edit",
    "--no-verify",
    "--trailer",
    shellQuote(trailer),
  ].join(" ");
  try {
    git(["rebase", "--no-verify", "--autostash", "--exec", amend, baseRef], {
      cwd: worktreeDir,
      stdio: "pipe",
    });
    return "rewritten";
  } catch {
    try {
      git(["rebase", "--abort"], { cwd: worktreeDir, stdio: "ignore" });
    } catch {
      // Nothing to abort — the rebase never started.
    }
    return "failed";
  }
}
