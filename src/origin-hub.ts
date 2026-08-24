// The origin hub: the container's private clone of the target repository.
// It owns all local git state; work units run in worktrees off it and push
// straight to origin. Constructed once and closed over by every operation
// that touches the local tree.
//
// `git-model.ts` is the implementation; this module is the seam. The engine
// holds one hub rather than threading repoDir, worktreesDir, and a git
// runner through every call site.

import {
  addWorktreeForExistingBranch,
  addWorktreeForNewBranch,
  appendTrailerToCommits,
  commitCount,
  defaultGit,
  ensureClone,
  fetchOrigin,
  originBranchSha,
  pushBranch,
  removeWorktree,
  worktreeDirForBranch,
  type GitRunner,
  type TrailerRewriteOutcome,
} from "./git-model.ts";
import { type BranchRef, type Sha } from "./branded.ts";
import type { PhoebeConfig } from "./config-schema.ts";

export type OriginHub = {
  fetch(): void;
  branchHead(branch: BranchRef): Sha;
  worktreeDirFor(branch: BranchRef): string;
  addWorktreeForNew(opts: { worktreeDir: string; branch: BranchRef; baseRef: string }): void;
  addWorktreeForExisting(opts: { worktreeDir: string; branch: BranchRef }): void;
  removeWorktree(worktreeDir: string): void;
  commitCount(worktreeDir: string, range: string): number;
  pushBranch(worktreeDir: string, branch: BranchRef): void;
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
): OriginHub {
  const repo = inContainer ? config.paths.repoDir : process.cwd();
  const worktrees = config.paths.worktreesDir;
  return {
    fetch() {
      fetchOrigin(repo, git);
    },
    branchHead(branch) {
      return originBranchSha(repo, branch, git);
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
    removeWorktree(worktreeDir) {
      removeWorktree(repo, worktreeDir, git);
    },
    commitCount(worktreeDir, range) {
      return commitCount(worktreeDir, range, git);
    },
    pushBranch(worktreeDir, branch) {
      pushBranch(worktreeDir, branch, git);
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
