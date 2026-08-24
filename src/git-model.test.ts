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
import { asBranchRef } from "./branded.ts";
import {
  addWorktreeForExistingBranch,
  addWorktreeForNewBranch,
  appendTrailerToCommits,
  commitCount,
  ensureClone,
  fetchOrigin,
  originBranchSha,
  pushBranch,
  pushBranchWithLease,
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
    const dir = worktreeDirForBranch(worktreesDir, asBranchRef("agent/issue-12"));
    expect(dir).toBe(join(worktreesDir, "agent-issue-12"));
  });

  test("new-branch worktree bases on the requested ref and counts commits", () => {
    const branch = asBranchRef("agent/issue-12");
    const worktreeDir = worktreeDirForBranch(worktreesDir, branch);
    addWorktreeForNewBranch({ repoDir, worktreeDir, branch, baseRef: "origin/main" }, testGit);

    expect(git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
    expect(git(worktreeDir, "rev-parse", "HEAD").trim()).toBe(
      originBranchSha(repoDir, asBranchRef("main"), testGit),
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
    const branch = asBranchRef("agent/issue-12");
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
      {
        repoDir: "/data/repo",
        worktreeDir: "/data/worktrees/x",
        branch: asBranchRef("agent/issue-9"),
      },
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

  test("ensureClone is a no-op when the existing clone's origin matches", () => {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const runner: GitRunner = (args, opts) => {
      calls.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
      return "https://example.com/repo.git\n";
    };
    ensureClone({ repoUrl: "https://example.com/repo.git", repoDir }, runner);
    // Only the origin check runs — no clone, no fetch.
    expect(calls).toEqual([{ args: ["config", "--get", "remote.origin.url"], cwd: repoDir }]);
  });

  test("ensureClone refuses an existing clone whose origin is a different repo", () => {
    const runner: GitRunner = () => "https://example.com/OTHER.git\n";
    expect(() => ensureClone({ repoUrl: "https://example.com/repo.git", repoDir }, runner)).toThrow(
      /Refusing to work a foreign clone/,
    );
  });

  test("ensureClone refuses an existing clone with no configured origin", () => {
    // `repoDir` has `.git` but no `remote.origin.url` (beforeAll only writes the
    // tracking ref). The real runner's `git config --get` exits non-zero here, so
    // this proves the missing-origin lookup routes through the refusal path
    // instead of surfacing a raw `Command failed`.
    expect(() =>
      ensureClone({ repoUrl: "https://example.com/repo.git", repoDir }, testGit),
    ).toThrow(/Refusing to work a foreign clone/);
  });

  test("ensureClone clones the configured URL into the repo dir when missing", () => {
    const { runner, calls } = spyGit();
    const freshDir = join(root, "fresh");
    ensureClone({ repoUrl: "https://example.com/repo.git", repoDir: freshDir }, runner);
    expect(calls).toEqual([{ args: ["clone", "https://example.com/repo.git", freshDir] }]);
  });

  test("pushBranch pushes the branch to origin from the worktree", () => {
    const { runner, calls } = spyGit();
    pushBranch("/data/worktrees/x", asBranchRef("agent/issue-12"), runner);
    expect(calls).toEqual([
      { args: ["push", "origin", "agent/issue-12"], cwd: "/data/worktrees/x" },
    ]);
  });

  test("pushBranchWithLease pushes with --force-with-lease from the worktree", () => {
    const { runner, calls } = spyGit();
    pushBranchWithLease("/data/worktrees/x", asBranchRef("phoebe/issue-12"), runner);
    expect(calls).toEqual([
      {
        args: ["push", "--force-with-lease", "origin", "phoebe/issue-12"],
        cwd: "/data/worktrees/x",
      },
    ]);
  });

  test("fetchOrigin fetches in the clone", () => {
    const { runner, calls } = spyGit();
    fetchOrigin("/data/repo", runner);
    expect(calls).toEqual([{ args: ["fetch", "origin"], cwd: "/data/repo" }]);
  });
});

describe("appendTrailerToCommits", () => {
  const TRAILER = "Co-authored-by: octocat <583231+octocat@users.noreply.github.com>";
  let localGit: GitRunner;

  beforeAll(() => {
    // The rebase `--exec` step spawns its own `git commit`, which sees repo
    // config but not the `-c` identity flags on the outer runner.
    git(repoDir, "config", "user.name", "test");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "commit.gpgsign", "false");
    localGit = testGit;
  });

  function freshWorktree(name: string): string {
    const branch = asBranchRef(`agent/${name}`);
    const worktreeDir = worktreeDirForBranch(worktreesDir, branch);
    addWorktreeForNewBranch({ repoDir, worktreeDir, branch, baseRef: "origin/main" }, localGit);
    return worktreeDir;
  }

  function commitFile(worktreeDir: string, name: string, message: string): void {
    writeFileSync(join(worktreeDir, name), `${name}\n`);
    git(worktreeDir, "add", ".");
    git(worktreeDir, "commit", "-m", message);
  }

  test("appends the trailer to every commit since base, leaving trees and authorship intact", () => {
    const worktreeDir = freshWorktree("trailer-linear");
    commitFile(worktreeDir, "a.txt", "Phoebe: first\n\nBody line.");
    commitFile(worktreeDir, "b.txt", "Phoebe: second");
    const treesBefore = git(worktreeDir, "log", "--format=%T %an %ae %ad", "origin/main..HEAD");

    const outcome = appendTrailerToCommits(
      { worktreeDir, baseRef: "origin/main", trailer: TRAILER },
      localGit,
    );

    expect(outcome).toBe("rewritten");
    expect(commitCount(worktreeDir, "origin/main..HEAD", localGit)).toBe(2);
    expect(git(worktreeDir, "log", "--format=%T %an %ae %ad", "origin/main..HEAD")).toBe(
      treesBefore,
    );
    const messages = git(worktreeDir, "log", "--format=%B%x00", "origin/main..HEAD")
      .split("\0")
      .map((m) => m.trim())
      .filter(Boolean);
    expect(messages).toEqual([
      `Phoebe: second\n\n${TRAILER}`,
      `Phoebe: first\n\nBody line.\n\n${TRAILER}`,
    ]);
    expect(git(worktreeDir, "status", "--porcelain")).toBe("");
    removeWorktree(repoDir, worktreeDir, localGit);
  });

  test("does not duplicate a trailer the agent already wrote", () => {
    const worktreeDir = freshWorktree("trailer-dup");
    commitFile(worktreeDir, "a.txt", `Phoebe: first\n\n${TRAILER}`);

    appendTrailerToCommits({ worktreeDir, baseRef: "origin/main", trailer: TRAILER }, localGit);

    const message = git(worktreeDir, "log", "-1", "--format=%B").trim();
    expect(message).toBe(`Phoebe: first\n\n${TRAILER}`);
    removeWorktree(repoDir, worktreeDir, localGit);
  });

  test("survives uncommitted changes the agent left behind", () => {
    const worktreeDir = freshWorktree("trailer-dirty");
    commitFile(worktreeDir, "a.txt", "Phoebe: first");
    writeFileSync(join(worktreeDir, "a.txt"), "modified\n");
    writeFileSync(join(worktreeDir, "untracked.txt"), "loose\n");

    const outcome = appendTrailerToCommits(
      { worktreeDir, baseRef: "origin/main", trailer: TRAILER },
      localGit,
    );

    expect(outcome).toBe("rewritten");
    expect(git(worktreeDir, "log", "-1", "--format=%B").trim()).toBe(`Phoebe: first\n\n${TRAILER}`);
    expect(git(worktreeDir, "status", "--porcelain")).toContain(" M a.txt");
    expect(git(worktreeDir, "status", "--porcelain")).toContain("?? untracked.txt");
    removeWorktree(repoDir, worktreeDir, localGit);
  });

  test("returns 'nothing' when there are no commits since base", () => {
    const worktreeDir = freshWorktree("trailer-empty");
    expect(
      appendTrailerToCommits({ worktreeDir, baseRef: "origin/main", trailer: TRAILER }, localGit),
    ).toBe("nothing");
    removeWorktree(repoDir, worktreeDir, localGit);
  });

  test("leaves history untouched when the range contains a merge commit", () => {
    const worktreeDir = freshWorktree("trailer-merge");
    commitFile(worktreeDir, "a.txt", "Phoebe: mainline");
    git(worktreeDir, "checkout", "-b", "side", "origin/main");
    commitFile(worktreeDir, "b.txt", "Phoebe: side");
    git(worktreeDir, "checkout", "agent/trailer-merge");
    git(worktreeDir, "merge", "--no-ff", "-m", "Phoebe: merge side", "side");
    const headBefore = git(worktreeDir, "rev-parse", "HEAD");

    const outcome = appendTrailerToCommits(
      { worktreeDir, baseRef: "origin/main", trailer: TRAILER },
      localGit,
    );

    expect(outcome).toBe("skipped-merges");
    expect(git(worktreeDir, "rev-parse", "HEAD")).toBe(headBefore);
    removeWorktree(repoDir, worktreeDir, localGit);
    git(repoDir, "branch", "-D", "side");
  });

  test("restores the original history when the rewrite fails midway", () => {
    const worktreeDir = freshWorktree("trailer-abort");
    commitFile(worktreeDir, "a.txt", "Phoebe: first");
    const headBefore = git(worktreeDir, "rev-parse", "HEAD");
    const failingRebase: GitRunner = (args, opts) => {
      if (args[0] === "rebase" && args.includes("--exec")) {
        // Simulate the exec step dying: start the real rebase with a failing
        // command so git leaves the worktree mid-rebase, then surface the throw.
        return localGit(
          ["rebase", "--exec", "false", ...args.slice(args.indexOf("--exec") + 2)],
          opts,
        );
      }
      return localGit(args, opts);
    };

    const outcome = appendTrailerToCommits(
      { worktreeDir, baseRef: "origin/main", trailer: TRAILER },
      failingRebase,
    );

    expect(outcome).toBe("failed");
    expect(git(worktreeDir, "rev-parse", "HEAD")).toBe(headBefore);
    expect(
      existsSync(join(git(worktreeDir, "rev-parse", "--git-dir").trim(), "rebase-merge")),
    ).toBe(false);
    removeWorktree(repoDir, worktreeDir, localGit);
  });
});
