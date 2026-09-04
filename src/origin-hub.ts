// The origin hub: the container's private clone of the target repository.
// It owns all local git state; work units run in worktrees off it and push
// straight to origin. Constructed once and closed over by every operation
// that touches the local tree.
//
// `git-model.ts` is the implementation; this module is the seam. The engine
// holds one hub rather than threading repoDir, worktreesDir, and a git
// runner through every call site.

import {
  addWorktreeDetached,
  addWorktreeForExistingBranch,
  addWorktreeForNewBranch,
  appendTrailerToCommits,
  commitCount,
  defaultGit,
  dirtyFileCount,
  ensureClone,
  fetchOrigin,
  listWorktrees,
  lockWorktree,
  originBranchSha,
  pushBranch,
  pushBranchWithLease,
  removeWorktree,
  unlockWorktree,
  worktreeDirForBranch,
  worktreeLease,
  type GitRunner,
  type TrailerRewriteOutcome,
} from "./git-model.ts";
import { type BranchRef, type Sha } from "./branded.ts";
import type { PhoebeConfig } from "./config-schema.ts";
import { leasePipeline, type WorktreeEntry } from "./worktree-lease.ts";

export type OriginHub = {
  fetch(): void;
  branchHead(branch: BranchRef): Sha;
  commitsBehind(branch: BranchRef, upstream: string): number;
  worktreeDirFor(branch: BranchRef): string;
  addWorktreeForNew(opts: { worktreeDir: string; branch: BranchRef; baseRef: string }): void;
  addWorktreeForExisting(opts: { worktreeDir: string; branch: BranchRef }): void;
  addWorktreeDetached(opts: { worktreeDir: string; ref: string }): void;
  /** Refuses — throws `WorktreeLeasedError` — on a tree leased by anyone (#418). */
  removeWorktree(worktreeDir: string): void;
  /** Take the worktree lease on `worktreeDir` with `reason` (#418). */
  lockWorktree(worktreeDir: string, reason: string): void;
  /** Drop the lease on `worktreeDir`; a no-op when there is none. */
  unlockWorktree(worktreeDir: string): void;
  /** Which pipeline leases `worktreeDir`, and whether it is locked at all. */
  worktreeLease(worktreeDir: string): { locked: boolean; pipeline: string | null };
  /** Every registered worktree with its lock reason — what the boot-time break walks. */
  listWorktrees(): WorktreeEntry[];
  commitCount(worktreeDir: string, range: string): number;
  dirtyFileCount(worktreeDir: string): number;
  pushBranch(worktreeDir: string, branch: BranchRef): void;
  pushBranchWithLease(worktreeDir: string, branch: BranchRef): void;
  appendTrailerToCommits(opts: {
    worktreeDir: string;
    baseRef: string;
    trailer: string;
  }): TrailerRewriteOutcome;
};

/**
 * Build the origin hub for this engine: bind the private clone directory,
 * the worktrees directory, and the git runner so every caller holds one
 * collaborator instead of three.
 *
 * In the container, `repoDir` is the private clone on the named volume.
 * On the host (selection and `--dry-run` only), it is the current checkout.
 */
export function createOriginHub(
  config: PhoebeConfig,
  inContainer: boolean,
  git: GitRunner = defaultGit,
  opts: { warn?: (line: string) => void } = {},
): OriginHub {
  const repo = inContainer ? config.paths.repoDir : process.cwd();
  const worktrees = config.paths.worktreesDir;
  return {
    fetch() {
      fetchOrigin(repo, git, undefined, opts.warn);
    },
    branchHead(branch) {
      return originBranchSha(repo, branch, git);
    },
    commitsBehind(branch, upstream) {
      return commitCount(repo, `origin/${branch}..origin/${upstream}`, git);
    },
    worktreeDirFor(branch) {
      return worktreeDirForBranch(worktrees, branch);
    },
    addWorktreeForNew({ worktreeDir, branch, baseRef }) {
      addWorktreeForNewBranch({ repoDir: repo, worktreeDir, branch, baseRef }, git);
    },
    addWorktreeForExisting({ worktreeDir, branch }) {
      addWorktreeForExistingBranch({ repoDir: repo, worktreeDir, branch }, git);
    },
    addWorktreeDetached({ worktreeDir, ref }) {
      addWorktreeDetached({ repoDir: repo, worktreeDir, ref }, git);
    },
    removeWorktree(worktreeDir) {
      removeWorktree(repo, worktreeDir, git);
    },
    lockWorktree(worktreeDir, reason) {
      lockWorktree(repo, worktreeDir, reason, git);
    },
    unlockWorktree(worktreeDir) {
      unlockWorktree(repo, worktreeDir, git);
    },
    worktreeLease(worktreeDir) {
      return worktreeLease(repo, worktreeDir, git);
    },
    listWorktrees() {
      return listWorktrees(repo, git);
    },
    commitCount(worktreeDir, range) {
      return commitCount(worktreeDir, range, git);
    },
    dirtyFileCount(worktreeDir) {
      return dirtyFileCount(worktreeDir, git);
    },
    pushBranch(worktreeDir, branch) {
      pushBranch(worktreeDir, branch, git);
    },
    pushBranchWithLease(worktreeDir, branch) {
      pushBranchWithLease(worktreeDir, branch, git);
    },
    appendTrailerToCommits(opts) {
      return appendTrailerToCommits(opts, git);
    },
  };
}

/**
 * Bootstrap the private clone the engine needs. A no-op once the clone
 * exists. Called from the process entry point before the engine factory,
 * so it never runs on the host (selection and `--dry-run` need no clone).
 */
export function ensureOriginClone(
  config: PhoebeConfig,
  inContainer: boolean,
  git: GitRunner = defaultGit,
): void {
  const repo = inContainer ? config.paths.repoDir : process.cwd();
  ensureClone({ repoUrl: config.repoUrl, repoDir: repo }, git);
}

/**
 * Whether this pipeline's kinds need the origin hub at all (#418).
 *
 * A pipeline every one of whose kinds declares `scratch` never touches the
 * clone: no worktree, no detached checkout, no fetch. Cloning for it costs the
 * tenant a full copy of the repo and a slow first boot for nothing, and on a
 * fresh tenant it puts the process into the clone lock's queue for work it
 * will not do. The `workspace` declaration is the whole test — a kind that
 * builds its own worktrees through `ctx.agent` declares `worktree`, which is
 * what makes the five built-ins say yes.
 */
export function requiresOriginClone(
  workOrder: readonly string[],
  workspaceModeFor: (kind: string) => string,
): boolean {
  return workOrder.some((kind) => {
    const mode = workspaceModeFor(kind);
    return mode === "worktree" || mode === "readonly";
  });
}

/**
 * Drop every worktree lease this pipeline left behind, and report the trees
 * some other pipeline still holds (#418).
 *
 * Run once at boot, before any unit. A lease outlives the process that took it
 * — a killed engine leaves its trees locked — so a pipeline unconditionally
 * breaks its own, whatever it finds. It never breaks another's: that tree may
 * have a live agent inside it, and the sibling will release it itself.
 */
export function breakOwnLeases(
  hub: OriginHub,
  pipeline: string,
): { broken: string[]; heldByOthers: Array<{ dir: string; pipeline: string | null }> } {
  const broken: string[] = [];
  const heldByOthers: Array<{ dir: string; pipeline: string | null }> = [];
  for (const entry of hub.listWorktrees()) {
    if (entry.reason === null) continue;
    const owner = leasePipeline(entry.reason);
    if (owner === pipeline) {
      hub.unlockWorktree(entry.dir);
      broken.push(entry.dir);
    } else {
      heldByOthers.push({ dir: entry.dir, pipeline: owner });
    }
  }
  return { broken, heldByOthers };
}
