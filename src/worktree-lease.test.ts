// The lease's grammar (#418): how a reason string is written, how the owner is
// read back out of it, and how git's porcelain listing is parsed.

import { describe, expect, test } from "vite-plus/test";
import {
  formatLeaseReason,
  leasePipeline,
  parseWorktreeList,
  WorktreeLeasedError,
} from "./worktree-lease.ts";

describe("formatLeaseReason", () => {
  test("stamps the pipeline and the pid", () => {
    expect(formatLeaseReason({ pipeline: "work", pid: 42 })).toBe("pipeline=work pid=42");
  });
});

describe("leasePipeline", () => {
  test("reads the owner out of a lease this engine wrote", () => {
    expect(leasePipeline("pipeline=work pid=42")).toBe("work");
    expect(leasePipeline("pipeline=intake pid=7")).toBe("intake");
  });

  // The per-unit isolation ticket widens the owner to `<pipeline>#<unit-ref>`.
  // The boot-time break reads only the pipeline segment, so it keeps clearing
  // its own leases across that change without being taught about it.
  test("reads only the pipeline segment of a widened owner", () => {
    expect(leasePipeline("pipeline=work#issue:88 pid=42")).toBe("work");
    expect(leasePipeline("pipeline=intake#pr:12 pid=9")).toBe("intake");
  });

  test("a lock nothing here wrote has no owner", () => {
    expect(leasePipeline("held while I debug this")).toBeNull();
    expect(leasePipeline("")).toBeNull();
    expect(leasePipeline(null)).toBeNull();
  });
});

describe("parseWorktreeList", () => {
  const porcelain = [
    "worktree /data/repos/acme/widget/repo",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /data/repos/acme/widget/worktrees/phoebe-issue-7",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/phoebe/issue-7",
    "locked pipeline=work pid=42",
    "",
    "worktree /data/repos/acme/widget/worktrees/readonly-scout",
    "HEAD 3333333333333333333333333333333333333333",
    "detached",
    "locked",
    "",
  ].join("\n");

  test("names every registered tree and the reason each carries", () => {
    expect(parseWorktreeList(porcelain)).toEqual([
      { dir: "/data/repos/acme/widget/repo", reason: null },
      {
        dir: "/data/repos/acme/widget/worktrees/phoebe-issue-7",
        reason: "pipeline=work pid=42",
      },
      { dir: "/data/repos/acme/widget/worktrees/readonly-scout", reason: "" },
    ]);
  });

  // A bare `git worktree lock` is still a lock. Reading it as unlocked would
  // send the engine straight into the removal the lock exists to prevent.
  test("a lock with no reason is locked, not unlocked", () => {
    const [, , bare] = parseWorktreeList(porcelain);
    expect(bare?.reason).toBe("");
    expect(leasePipeline(bare?.reason ?? null)).toBeNull();
  });

  test("an empty listing is no worktrees, not a parse failure", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("WorktreeLeasedError", () => {
  test("names the holder so the skip line says who to wait for", () => {
    const error = new WorktreeLeasedError("/w/issue-7", "intake");
    expect(error.message).toContain("/w/issue-7");
    expect(error.message).toContain("pipeline intake");
    expect(error.holder).toBe("intake");
  });

  test("an unattributable lock says so rather than naming nobody", () => {
    expect(new WorktreeLeasedError("/w/issue-7", null).message).toContain("another writer");
  });
});
