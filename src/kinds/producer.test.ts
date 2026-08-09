// The producer core (issues/research): priority ordering, blocker-aware
// selection, the status-v2 issue queue, and a fetch/select/refFor smoke test
// for each of the two factories built on it.

import { describe, expect, test } from "vite-plus/test";
import { asPrNumber } from "../branded.ts";
import { sampleConfig as config } from "../test-config.ts";
import type { GitHub } from "../github.ts";
import { createQuarantine } from "../quarantine.ts";
import type { StackConfig } from "../stack.ts";
import type { BlockerPrState, Issue } from "../stack.ts";
import type { CycleContext } from "../cycle.ts";
import type { Io, KindDeps } from "./kind.ts";
import {
  buildInitialPrBody,
  buildIssueQueue,
  classifyPriority,
  compareIssues,
  createIssuesKind,
  createResearchKind,
  followUpPrComment,
  issueAttemptFailureSignature,
  selectIssue,
} from "./producer.ts";

const STACK_CONFIG: StackConfig = {
  blockedByPattern: String.raw`Blocked by\s+#(\d+)`,
  blockerSource: "body",
  branchPrefix: "phoebe/",
  stackMode: "banner",
};

function issue(overrides: Partial<Issue> & Pick<Issue, "number">): Issue {
  return {
    title: `Issue ${overrides.number}`,
    body: "",
    labels: ["ready-for-agent"],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("classifyPriority", () => {
  test("classifies bug-fix issues highest", () => {
    expect(classifyPriority(issue({ number: 1, title: "Fix crash on startup" }))).toBe("bug");
  });

  test("classifies tracer bullets", () => {
    expect(classifyPriority(issue({ number: 2, title: "Wire API-mode discovery POC" }))).toBe(
      "tracer",
    );
  });

  test("defaults to polish", () => {
    expect(classifyPriority(issue({ number: 3, title: "Add quota resilience" }))).toBe("polish");
  });
});

describe("compareIssues", () => {
  test("orders bug before polish, then oldest createdAt", () => {
    const bug = issue({
      number: 10,
      title: "Fix broken workflow",
      createdAt: "2026-06-02T00:00:00Z",
    });
    const polish = issue({
      number: 5,
      title: "Add toggle",
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect(compareIssues(bug, polish)).toBeLessThan(0);
    expect(compareIssues(polish, bug)).toBeGreaterThan(0);
  });
});

describe("selectIssue", () => {
  test("picks highest-priority workable issue and skips blocked-without-PR", () => {
    const issues = [
      issue({
        number: 103,
        title: "Add toggle",
        body: "Blocked by #98",
        createdAt: "2026-06-01T00:00:00Z",
      }),
      issue({ number: 108, title: "Phoebe poll loop", createdAt: "2026-06-02T00:00:00Z" }),
    ];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    const picked = selectIssue(issues, states, STACK_CONFIG);
    expect(picked?.issue.number).toBe(108);
    expect(picked?.resolution.worktreeBase).toBe("origin/main");
  });

  test("returns null when every issue is blocked without an open PR", () => {
    const issues = [
      issue({ number: 102, body: "Blocked by #98" }),
      issue({ number: 103, body: "Blocked by #98" }),
    ];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(selectIssue(issues, states, STACK_CONFIG)).toBeNull();
  });

  test("threads per-issue native blockers into base resolution under native source", () => {
    // No body ref; the blocker is known only via the native dependencies map.
    const issues = [issue({ number: 102, body: "## Blocked by\n\n- #98" })];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    const nativeBlockersByIssue = new Map<number, readonly number[]>([[102, [98]]]);
    const picked = selectIssue(
      issues,
      states,
      { ...STACK_CONFIG, blockerSource: "native" },
      undefined,
      nativeBlockersByIssue,
    );
    expect(picked?.issue.number).toBe(102);
    expect(picked?.resolution.stacked).toBe(true);
    expect(picked?.resolution.blockerIssueNumber).toBe(98);
  });

  test("excludes quarantined issues", () => {
    const issues = [
      issue({ number: 1, labels: ["phoebe:quarantined"] }),
      issue({ number: 2, labels: [] }),
    ];
    expect(selectIssue(issues, new Map(), STACK_CONFIG)?.issue.number).toBe(2);
  });
});

describe("buildIssueQueue (#20)", () => {
  test("returns an empty queue when there are no eligible issues", () => {
    expect(buildIssueQueue([], new Map(), STACK_CONFIG)).toEqual([]);
  });

  test("orders a linear chain and reports the full resolved blocker set", () => {
    const issues = [
      issue({ number: 101, title: "Add toggle", body: "Blocked by #100" }),
      issue({ number: 100, title: "Fix crash on startup" }),
    ];
    const states = new Map<number, BlockerPrState>([
      [100, { hasOpenPr: true, openPrNumber: asPrNumber(200), hasMergedPr: false }],
    ]);
    expect(buildIssueQueue(issues, states, STACK_CONFIG)).toEqual([
      { issueNumber: 100, blockedBy: [], workable: true },
      { issueNumber: 101, blockedBy: [100], workable: true },
    ]);
  });

  test("marks an issue not workable when a blocker has no PR yet", () => {
    const issues = [issue({ number: 101, body: "Blocked by #100" })];
    const states = new Map<number, BlockerPrState>([
      [100, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(buildIssueQueue(issues, states, STACK_CONFIG)).toEqual([
      { issueNumber: 101, blockedBy: [100], workable: false },
    ]);
  });

  test("reports both blockers on a diamond issue, workable once each has a PR", () => {
    const issues = [issue({ number: 103, body: "Blocked by #101\nBlocked by #102" })];
    const states = new Map<number, BlockerPrState>([
      [101, { hasOpenPr: true, openPrNumber: asPrNumber(201), hasMergedPr: false }],
      [102, { hasOpenPr: true, openPrNumber: asPrNumber(202), hasMergedPr: false }],
    ]);
    expect(buildIssueQueue(issues, states, STACK_CONFIG)).toEqual([
      { issueNumber: 103, blockedBy: [101, 102], workable: true },
    ]);
  });

  test("excludes quarantined issues", () => {
    const issues = [issue({ number: 104, labels: ["phoebe:quarantined"] })];
    expect(buildIssueQueue(issues, new Map(), STACK_CONFIG)).toEqual([]);
  });
});

describe("buildInitialPrBody", () => {
  test("includes stacked banner on initial PR only", () => {
    const body = buildInitialPrBody({
      issueNumber: 103,
      commitCount: 2,
      stacked: { blockerIssueNumber: 98, blockerPrNumber: asPrNumber(104) },
    });
    expect(body).toContain("Closes #103");
    expect(body).toContain("Blocked by #98");
    expect(body).toContain("Commits: 2");
  });
});

describe("followUpPrComment", () => {
  test("contains only the incremental delta, not the stacked banner", () => {
    const comment = followUpPrComment(103, 2);
    expect(comment).toContain("#103");
    expect(comment).toContain("2 new commit(s)");
    expect(comment).not.toContain("Blocked by");
    expect(comment).not.toContain("Do not merge");
    expect(comment).not.toContain("Closes #");
  });
});

describe("issueAttemptFailureSignature (#22)", () => {
  test("embeds the verification report's failed command", () => {
    expect(issueAttemptFailureSignature({ failedCommand: "apply_patch", agentExitCode: 1 })).toBe(
      "apply-patch-failed",
    );
  });
  test("falls back to the agent exit code with no verification report", () => {
    expect(issueAttemptFailureSignature({ agentExitCode: 2 })).toBe("agent-exit-2");
  });
  test("falls back to a generic marker with no signal at all", () => {
    expect(issueAttemptFailureSignature({ agentExitCode: null })).toBe("no-commit-produced");
    expect(issueAttemptFailureSignature({ agentExitCode: 0 })).toBe("no-commit-produced");
  });
});

// --- Kind factories: fetch/select/refFor through the interface --------------

function fakeIo(overrides: Partial<Io> = {}): Io {
  const github: GitHub = overrides.github ?? {
    issuesWithLabel: () => [],
    issueBody: () => "",
    issueActivity: () => ({ updatedAt: "2026-01-01T00:00:00Z", comments: [], labels: [] }),
    nativeBlockers: () => [],
    prNumberForHead: () => undefined,
    openPrs: () => [],
    prMergeInfo: () => {
      throw new Error("not implemented in fake");
    },
    prActivity: () => ({ headRefOid: "" as never, lastCommitAt: null, comments: [], labels: [] }),
    reviewThreads: () => [],
    commitCheckRuns: () => [],
    commentIssue: () => {},
    commentPr: () => {},
    createPr: () => {},
    retargetPr: () => {},
    labelIssue: () => {},
    unlabelIssue: () => {},
    labelPr: () => {},
    linkStack: () => {},
    installStackExtension: () => {},
    login: () => "phoebe-bot",
    updateComment: () => {},
  };
  return {
    github,
    git: {
      fetchOrigin: () => {},
      originBranchSha: () => "" as never,
      prepareWorktree: () => "/tmp/worktree",
      removeWorktree: () => {},
      pushBranch: () => {},
      commitCount: () => 0,
      gitInWorktree: () => "",
    },
    agent: { run: async () => 0 },
    prompts: {
      load: () => "template",
      defaultArgs: () => ({}),
      render: (template) => template,
    },
    shell: { run: () => {} },
    quarantine: createQuarantine({
      github,
      config: { maxUnitTimeouts: config.maxUnitTimeouts, maxUnitAttempts: config.maxUnitAttempts },
      log: () => {},
    }),
    ...overrides,
  };
}

function fakeCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  return {
    mainHead: "" as never,
    openPrs: [],
    login: async () => "phoebe-bot",
    pools: { ready: [], research: [] },
    issueBodies: new Map(),
    blockerStates: new Map(),
    nativeBlockers: new Map(),
    runtimeId: "runtime-1",
    ...overrides,
  };
}

describe("createIssuesKind", () => {
  test("is one-shot eligible and fetches from ctx.pools.ready", async () => {
    const deps: KindDeps = { config, io: fakeIo() };
    const kind = createIssuesKind(deps);
    expect(kind.oneShot).toBe(true);
    expect(kind.name).toBe("issues");

    const ready = [issue({ number: 42 })];
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] } }));
    const unit = kind.select(data, fakeCtx());
    expect(unit?.issue.number).toBe(42);
    const ref = kind.refFor(unit!);
    expect(ref).toEqual({
      kind: "issues",
      target: { type: "issue", number: 42 },
      branch: "phoebe/issue-42",
    });
  });

  test("describeIdle explains a non-empty, unworkable pool", async () => {
    const deps: KindDeps = { config, io: fakeIo() };
    const kind = createIssuesKind(deps);
    const ready = [issue({ number: 1, body: "Blocked by #2" })];
    const blockerStates = new Map<number, BlockerPrState>([
      [2, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] }, blockerStates }));
    expect(kind.describeIdle?.(data)).toMatch(/none workable this cycle/);
  });

  test("has a sweep (reclaim); research does not", () => {
    const deps: KindDeps = { config, io: fakeIo() };
    expect(createIssuesKind(deps).sweep !== undefined).toBe(true);
    expect(createResearchKind(deps).sweep !== undefined).toBe(false);
  });
});

describe("createResearchKind", () => {
  test("is one-shot eligible and fetches from ctx.pools.research", async () => {
    const deps: KindDeps = { config, io: fakeIo() };
    const kind = createResearchKind(deps);
    expect(kind.oneShot).toBe(true);
    expect(kind.name).toBe("research");

    const research = [issue({ number: 7 })];
    const data = await kind.fetch(fakeCtx({ pools: { ready: [], research } }));
    const unit = kind.select(data, fakeCtx());
    expect(unit?.issue.number).toBe(7);
    expect(kind.refFor(unit!).target).toEqual({ type: "issue", number: 7 });
  });
});
