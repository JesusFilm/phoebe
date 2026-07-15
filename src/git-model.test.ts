// Exercises the origin-hub git model against a real temp repo standing in for
// the container's /data/repo clone.
//
// No git *transport* runs live here (clone, fetch, push): on Git for Windows
// every local-path transport spawns MSYS sh for the pack handshake, and that
// sh dies with a cygwin shared-memory error under the vp task runner's
// process tree. The temp repo gets its `origin/main` ref written directly,
// worktree/commit operations run against real git, and transport commands are
// asserted through the injectable GitRunner seam.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  addWorktreeForExistingBranch,
  addWorktreeForNewBranch,
  commitCount,
  ensureClone,
  fetchOrigin,
  originBranchSha,
  pushBranch,
  removeWorktree,
  worktreeDirForBranch,
  type GitRunner,
} from "./git-model.ts";

const IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });

/** Same shape as the production default runner, with test identity config. */
const testGit: GitRunner = (args, opts) =>
  execFileSync("git", [...IDENTITY, ...args], {
    encoding: "utf8",
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    ...(opts?.stdio ? { stdio: opts.stdio } : {}),
  }) as unknown as string;

/** Records invocations instead of running them. */
function spyGit(): { runner: GitRunner; calls: Array<{ args: string[]; cwd?: string }> } {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  return {
    calls,
    runner: (args, opts) => {
      calls.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
      return "";
    },
  };
}

let root: string;
let repoDir: string;
let worktreesDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "phoebe-git-model-"));
  repoDir = join(root, "repo");
  worktreesDir = join(root, "worktrees");

  execFileSync("git", ["init", "-b", "main", repoDir], { encoding: "utf8" });
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "seed");
  // Write the remote-tracking ref directly instead of fetching over a live
  // transport (see the header comment).
  git(repoDir, "update-ref", "refs/remotes/origin/main", "HEAD");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("git model", () => {
  test("worktreeDirForBranch produces a filesystem-safe dir under worktreesDir", () => {
    const dir = worktreeDirForBranch(worktreesDir, "agent/issue-12");
    expect(dir).toBe(join(worktreesDir, "agent-issue-12"));
  });

  test("new-branch worktree bases on the requested ref and counts commits", () => {
    const branch = "agent/issue-12";
    const worktreeDir = worktreeDirForBranch(worktreesDir, branch);
    addWorktreeForNewBranch({ repoDir, worktreeDir, branch, baseRef: "origin/main" }, testGit);

    expect(git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
    expect(git(worktreeDir, "rev-parse", "HEAD").trim()).toBe(
      originBranchSha(repoDir, "main", testGit),
    );
    expect(commitCount(worktreeDir, "origin/main..HEAD", testGit)).toBe(0);

    writeFileSync(join(worktreeDir, "work.txt"), "unit\n");
    git(worktreeDir, "add", ".");
    git(worktreeDir, "commit", "-m", "unit work");
    expect(commitCount(worktreeDir, "origin/main..HEAD", testGit)).toBe(1);

    removeWorktree(repoDir, worktreeDir, testGit);
    expect(existsSync(worktreeDir)).toBe(false);
  });

  test("existing-branch worktree reuses the local branch left by a prior unit", () => {
    const branch = "agent/issue-12";
    const worktreeDir = worktreeDirForBranch(worktreesDir, branch);
    addWorktreeForExistingBranch({ repoDir, worktreeDir, branch }, testGit);
    expect(git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
    removeWorktree(repoDir, worktreeDir, testGit);
  });

  test("existing-branch worktree falls back to -B origin/<branch> when the local branch is missing", () => {
    const { runner, calls } = spyGit();
    const failPlainAdd: GitRunner = (args, opts) => {
      if (args[1] === "add" && !args.includes("-B")) {
        calls.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
        throw new Error("no such branch");
      }
      return runner(args, opts);
    };
    addWorktreeForExistingBranch(
      { repoDir: "/data/repo", worktreeDir: "/data/worktrees/x", branch: "agent/issue-9" },
      failPlainAdd,
    );
    expect(calls[1]?.args).toEqual([
      "worktree",
      "add",
      "-B",
      "agent/issue-9",
      "/data/worktrees/x",
      "origin/agent/issue-9",
    ]);
    expect(calls[1]?.cwd).toBe("/data/repo");
  });

  test("ensureClone is a no-op when a clone already exists", () => {
    const { runner, calls } = spyGit();
    ensureClone({ repoUrl: "https://example.com/repo.git", repoDir }, runner);
    expect(calls).toEqual([]);
  });

  test("ensureClone clones the configured URL into the repo dir when missing", () => {
    const { runner, calls } = spyGit();
    const freshDir = join(root, "fresh");
    ensureClone({ repoUrl: "https://example.com/repo.git", repoDir: freshDir }, runner);
    expect(calls).toEqual([{ args: ["clone", "https://example.com/repo.git", freshDir] }]);
  });

  test("pushBranch pushes the branch to origin from the worktree", () => {
    const { runner, calls } = spyGit();
    pushBranch("/data/worktrees/x", "agent/issue-12", runner);
    expect(calls).toEqual([
      { args: ["push", "origin", "agent/issue-12"], cwd: "/data/worktrees/x" },
    ]);
  });

  test("fetchOrigin fetches in the clone", () => {
    const { runner, calls } = spyGit();
    fetchOrigin("/data/repo", runner);
    expect(calls).toEqual([{ args: ["fetch", "origin"], cwd: "/data/repo" }]);
  });
});
