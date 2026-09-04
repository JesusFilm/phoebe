// The lease's grammar (#418/#423): how a reason string is written, how the owner
// is read back out of it at both grains, and how git's porcelain listing is
// parsed.

import { describe, expect, test } from "vite-plus/test";
import {
  formatLeaseReason,
  leaseHolder,
  leasePipeline,
  parseWorktreeList,
  WorktreeLeasedError,
} from "./worktree-lease.ts";

describe("formatLeaseReason", () => {
  test("stamps the owner and the pid", () => {
    expect(formatLeaseReason({ owner: "work#issues:issue%3A88", pid: 42 })).toBe(
      "pipeline=work#issues:issue%3A88 pid=42",
    );
  });
});

// The unit grain (#423): what a unit compares its own lease against before it
// takes a tree apart. A sibling unit of this very pipeline is as much someone
// else as another pipeline is.
describe("leaseHolder", () => {
  test("reads the whole owner, unit segment included", () => {
    expect(leaseHolder("pipeline=work#issues:issue%3A88 pid=42")).toBe("work#issues:issue%3A88");
  });

  test("an older engine's pipeline-only lease is a holder too", () => {
    expect(leaseHolder("pipeline=work pid=42")).toBe("work");
  });

  test("a lock nothing here wrote has no holder", () => {
    expect(leaseHolder("held while I debug this")).toBeNull();
    expect(leaseHolder(null)).toBeNull();
  });
});

describe("leasePipeline", () => {
  test("reads the owner out of a lease this engine wrote", () => {
    expect(leasePipeline("pipeline=work pid=42")).toBe("work");
    expect(leasePipeline("pipeline=intake pid=7")).toBe("intake");
  });

  // The owner is `<pipeline>#<kind>:<ref>` since #423. The boot-time break
  // reads only the pipeline segment, so it keeps clearing its own leases
  // without being taught that units exist — and so will the stale-state sweep.
  test("reads only the pipeline segment of a unit-keyed owner", () => {
    expect(leasePipeline("pipeline=work#issues:issue%3A88 pid=42")).toBe("work");
    expect(leasePipeline("pipeline=intake#conflicts:pr%3A12 pid=9")).toBe("intake");
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
    const error = new WorktreeLeasedError("/w/issue-7", "work#conflicts:pr%3A12");
    expect(error.message).toContain("/w/issue-7");
    expect(error.message).toContain("work#conflicts:pr%3A12");
    expect(error.holder).toBe("work#conflicts:pr%3A12");
  });

  test("an unattributable lock says so rather than naming nobody", () => {
    expect(new WorktreeLeasedError("/w/issue-7", null).message).toContain("another writer");
  });
});
