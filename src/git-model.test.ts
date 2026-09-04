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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { asBranchRef } from "./branded.ts";
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
  withOutputPrefix,
  worktreeDirForBranch,
  worktreeLease,
  type GitRunner,
} from "./git-model.ts";
import { formatLeaseReason, WorktreeLeasedError } from "./worktree-lease.ts";

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

  // The read-only workspace (#397). Detachment is the don't-push contract in
  // full: no ref to push, and none created in the clone either.
  test("detached worktree checks out the ref on no branch and creates no ref", () => {
    const worktreeDir = join(worktreesDir, "readonly", "auditor");
    const refsBefore = git(repoDir, "for-each-ref", "--format=%(refname)").trim();
    addWorktreeDetached({ repoDir, worktreeDir, ref: "origin/main" }, testGit);

    expect(git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");
    expect(git(worktreeDir, "rev-parse", "HEAD").trim()).toBe(
      originBranchSha(repoDir, asBranchRef("main"), testGit),
    );
    expect(git(repoDir, "for-each-ref", "--format=%(refname)").trim()).toBe(refsBefore);

    removeWorktree(repoDir, worktreeDir, testGit);
    expect(existsSync(worktreeDir)).toBe(false);
  });

  test("dirtyFileCount counts what a kind left in a tree about to be discarded", () => {
    const worktreeDir = join(worktreesDir, "readonly", "auditor");
    addWorktreeDetached({ repoDir, worktreeDir, ref: "origin/main" }, testGit);
    expect(dirtyFileCount(worktreeDir, testGit)).toBe(0);

    writeFileSync(join(worktreeDir, "notes.md"), "the kind wrote here\n");
    writeFileSync(join(worktreeDir, "README.md"), "and edited here\n");
    expect(dirtyFileCount(worktreeDir, testGit)).toBe(2);

    // Committing hides the change from `git status`, which is why the boundary
    // check asks `commitCount` as well.
    git(worktreeDir, "add", ".");
    git(worktreeDir, "commit", "-m", "work with nowhere to go");
    expect(dirtyFileCount(worktreeDir, testGit)).toBe(0);
    expect(commitCount(worktreeDir, "origin/main..HEAD", testGit)).toBe(1);

    removeWorktree(repoDir, worktreeDir, testGit);
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

describe("fetchOrigin retry", () => {
  test("retries a failed fetch through the schedule, then succeeds", () => {
    const slept: number[] = [];
    let calls = 0;
    const runner: GitRunner = () => {
      calls++;
      if (calls === 1) throw new Error("fatal: expected 'acknowledgments'");
      return "";
    };
    fetchOrigin("/data/repo", runner, (ms) => slept.push(ms));
    expect(calls).toBe(2);
    expect(slept).toEqual([2_000]);
  });

  test("a fetch that keeps failing throws after the schedule is spent", () => {
    const slept: number[] = [];
    let calls = 0;
    const runner: GitRunner = () => {
      calls++;
      throw new Error("fatal: unable to access");
    };
    expect(() => fetchOrigin("/data/repo", runner, (ms) => slept.push(ms))).toThrow(
      "unable to access",
    );
    expect(calls).toBe(3);
    expect(slept).toEqual([2_000, 8_000]);
  });
});

// ---------------------------------------------------------------------------
// The worktree lease (#418)
// ---------------------------------------------------------------------------
//
// Against real git, because the lease *is* git's behaviour: a locked tree
// refusing `remove --force` is the enforcement, not a convention layered over
// it. Verified on 2.39 and 2.54 alike.

describe("the worktree lease", () => {
  const leaseBranch = asBranchRef("agent/leased");
  /** One unit's owner, as `unitOwner` composes it (#423). */
  const OWNER = "work#issues:issue%3A7";
  let leased: string;

  beforeAll(() => {
    leased = worktreeDirForBranch(worktreesDir, leaseBranch);
    addWorktreeForNewBranch(
      { repoDir, worktreeDir: leased, branch: leaseBranch, baseRef: "origin/main" },
      testGit,
    );
  });

  afterAll(() => {
    unlockWorktree(repoDir, leased, testGit);
    removeWorktree(repoDir, leased, testGit);
  });

  test("an unlocked tree reports no lease", () => {
    expect(worktreeLease(repoDir, leased, testGit)).toEqual({ locked: false, holder: null });
  });

  // The holder is the whole owner — row *and* unit (#423) — because the caller
  // is one unit asking whether the tree it wants is its own.
  test("a lock names the unit that took it", () => {
    lockWorktree(repoDir, leased, formatLeaseReason({ owner: OWNER, pid: 4242 }), testGit);
    expect(worktreeLease(repoDir, leased, testGit)).toEqual({ locked: true, holder: OWNER });
  });

  test("the listing carries the reason verbatim, pid and all", () => {
    const entry = listWorktrees(repoDir, testGit).find((row) => row.dir.endsWith("agent-leased"));
    expect(entry?.reason).toBe(`pipeline=${OWNER} pid=4242`);
  });

  // The hazard the lease exists for: the old teardown fell back to a recursive
  // delete when git refused, which would take a sibling's live tree apart.
  test("removeWorktree throws on a leased tree rather than deleting it", () => {
    expect(() => removeWorktree(repoDir, leased, testGit)).toThrow(WorktreeLeasedError);
    expect(existsSync(leased)).toBe(true);
    expect(existsSync(join(leased, "README.md"))).toBe(true);
  });

  test("unlocking lets the tree be removed again", () => {
    unlockWorktree(repoDir, leased, testGit);
    expect(worktreeLease(repoDir, leased, testGit).locked).toBe(false);

    const throwaway = worktreeDirForBranch(worktreesDir, asBranchRef("agent/throwaway"));
    addWorktreeForNewBranch(
      {
        repoDir,
        worktreeDir: throwaway,
        branch: asBranchRef("agent/throwaway"),
        baseRef: "origin/main",
      },
      testGit,
    );
    lockWorktree(repoDir, throwaway, formatLeaseReason({ owner: OWNER, pid: 1 }), testGit);
    unlockWorktree(repoDir, throwaway, testGit);
    removeWorktree(repoDir, throwaway, testGit);
    expect(existsSync(throwaway)).toBe(false);
  });

  test("unlocking a tree that is not locked is a no-op, not a failure", () => {
    expect(() => unlockWorktree(repoDir, leased, testGit)).not.toThrow();
  });

  // The path git prints is its own; a caller's may be a symlink or unnormalized.
  test("an unregistered path reports no lease", () => {
    expect(worktreeLease(repoDir, join(worktreesDir, "never-existed"), testGit)).toEqual({
      locked: false,
      holder: null,
    });
  });

  test("removing a directory that is not a worktree still clears it", () => {
    const orphan = join(worktreesDir, "orphan-from-a-killed-run");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "half-written.txt"), "from the run that died\n");

    removeWorktree(repoDir, orphan, testGit);
    expect(existsSync(orphan)).toBe(false);
  });
});

// Attributable git output (#423). The wrapper's job is to turn the calls that
// used to inherit the engine's terminal into calls whose every line comes back
// through a callback, so a concurrent pipeline can stamp each with its unit.
describe("withOutputPrefix", () => {
  test("a call that would have inherited comes back line by line instead", () => {
    const lines: string[] = [];
    const runner = withOutputPrefix(defaultGit, (line) =>
      lines.push(`[work#issues:issue%3A7] ${line}`),
    );
    const tree = join(worktreesDir, "echoed");

    // `worktree add` says what it did on stderr — the stream a piped runner
    // would drop if it kept only stdout.
    runner(["worktree", "add", "-B", "agent/echoed", tree, "origin/main"], {
      cwd: repoDir,
      stdio: "inherit",
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith("[work#issues:issue%3A7] "))).toBe(true);
    expect(lines.some((line) => line.includes("agent/echoed"))).toBe(true);

    unlockWorktree(repoDir, tree, testGit);
    removeWorktree(repoDir, tree, testGit);
  });

  test("a failing call still throws, with what git said on the error", () => {
    const lines: string[] = [];
    const runner = withOutputPrefix(defaultGit, (line) => lines.push(line));

    expect(() =>
      runner(["worktree", "add", join(worktreesDir, "no-such"), "refs/heads/never-existed"], {
        cwd: repoDir,
        stdio: "inherit",
      }),
    ).toThrow(/never-existed/);
    expect(lines.length).toBeGreaterThan(0);
  });

  // Only the inheriting calls change. A caller that asked for stdout, or asked
  // for silence, gets exactly what it asked for.
  test("calls that capture or discard pass through untouched", () => {
    const lines: string[] = [];
    const spy = spyGit();
    const runner = withOutputPrefix(spy.runner, (line) => lines.push(line));

    runner(["rev-parse", "origin/main"], { cwd: repoDir });
    runner(["worktree", "prune"], { cwd: repoDir, stdio: "ignore" });

    expect(lines).toEqual([]);
    expect(spy.calls.map((call) => call.args[0])).toEqual(["rev-parse", "worktree"]);
  });
});
