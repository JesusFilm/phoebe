// The producer core (issues/research): priority ordering, blocker-aware
// selection, the status-v2 issue queue, and a fetch/select/refFor smoke test
// for each of the two factories built on it.

import { describe, expect, test } from "vite-plus/test";
import { asPrNumber } from "../branded.ts";
import { sampleConfig as config } from "../test-config.ts";
import type { GitHub } from "../github.ts";
import { createQuarantine, issueContentBaseline, PHOEBE_QUARANTINE_LABEL } from "../quarantine.ts";
import type { StackConfig } from "../stack.ts";
import type { BlockerPrState, Issue } from "../stack.ts";
import type { CycleContext } from "../cycle.ts";
import type { VerificationResult } from "../verification.ts";
import type { Io, KindDeps } from "./kind.ts";
import {
  buildInitialPrBody,
  buildIssueQueue,
  classifyPriority,
  compareIssues,
  createIssuesKind,
  createResearchKind,
  followUpPrComment,
  isTestLikePath,
  issueAttemptFailureSignature,
  selectIssue,
} from "./producer.ts";

const STACK_CONFIG: StackConfig = {
  blockedByPattern: String.raw`Blocked by\s+#(\d+)`,
  blockerSource: "body",
  branchPrefix: "phoebe/",
  stackMode: "banner",
};

const PRIORITY_LABEL_PREFIX = "priority:";

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
    expect(
      classifyPriority(issue({ number: 1, title: "Fix crash on startup" }), PRIORITY_LABEL_PREFIX),
    ).toBe("bug");
  });

  test("classifies tracer bullets", () => {
    expect(
      classifyPriority(
        issue({ number: 2, title: "Wire API-mode discovery POC" }),
        PRIORITY_LABEL_PREFIX,
      ),
    ).toBe("tracer");
  });

  test("defaults to polish", () => {
    expect(
      classifyPriority(issue({ number: 3, title: "Add quota resilience" }), PRIORITY_LABEL_PREFIX),
    ).toBe("polish");
  });

  test("a priority label overrides conflicting title/body text (#87, #130)", () => {
    expect(
      classifyPriority(
        issue({
          number: 4,
          title: "Fix crash on startup",
          labels: ["ready-for-agent", "priority:polish"],
        }),
        PRIORITY_LABEL_PREFIX,
      ),
    ).toBe("polish");
  });

  test("no priority label falls back to the title/body cascade", () => {
    expect(
      classifyPriority(
        issue({ number: 5, title: "Fix crash on startup", labels: ["ready-for-agent"] }),
        PRIORITY_LABEL_PREFIX,
      ),
    ).toBe("bug");
  });

  test("multiple conflicting priority labels resolve via PRIORITY_ORDER (bug > tracer > polish > refactor)", () => {
    expect(
      classifyPriority(
        issue({
          number: 6,
          title: "Add quota resilience",
          labels: ["ready-for-agent", "priority:refactor", "priority:tracer"],
        }),
        PRIORITY_LABEL_PREFIX,
      ),
    ).toBe("tracer");
  });

  test("calls onConflict with every matched bucket, in PRIORITY_ORDER, when labels conflict", () => {
    const conflicts: Array<{ number: number; labels: readonly string[] }> = [];
    classifyPriority(
      issue({
        number: 6,
        labels: ["ready-for-agent", "priority:refactor", "priority:tracer"],
      }),
      PRIORITY_LABEL_PREFIX,
      (conflicted, labels) => conflicts.push({ number: conflicted.number, labels }),
    );
    expect(conflicts).toEqual([{ number: 6, labels: ["tracer", "refactor"] }]);
  });

  test("does not call onConflict for a single priority label or none at all", () => {
    const conflicts: unknown[] = [];
    const onConflict = (issue: Issue, labels: readonly string[]) =>
      conflicts.push({ issue, labels });
    classifyPriority(
      issue({ number: 7, labels: ["ready-for-agent", "priority:bug"] }),
      PRIORITY_LABEL_PREFIX,
      onConflict,
    );
    classifyPriority(
      issue({ number: 8, title: "Add quota resilience", labels: ["ready-for-agent"] }),
      PRIORITY_LABEL_PREFIX,
      onConflict,
    );
    expect(conflicts).toEqual([]);
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
    expect(compareIssues(bug, polish, PRIORITY_LABEL_PREFIX)).toBeLessThan(0);
    expect(compareIssues(polish, bug, PRIORITY_LABEL_PREFIX)).toBeGreaterThan(0);
  });

  test("a priority label reorders issues against their keyword-implied priority", () => {
    const labeledRefactor = issue({
      number: 20,
      title: "Fix broken workflow",
      labels: ["ready-for-agent", "priority:refactor"],
      createdAt: "2026-06-01T00:00:00Z",
    });
    const unlabeledPolish = issue({
      number: 21,
      title: "Add toggle",
      createdAt: "2026-06-02T00:00:00Z",
    });
    expect(compareIssues(labeledRefactor, unlabeledPolish, PRIORITY_LABEL_PREFIX)).toBeGreaterThan(
      0,
    );
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
    const picked = selectIssue(issues, states, STACK_CONFIG, PRIORITY_LABEL_PREFIX);
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
    expect(selectIssue(issues, states, STACK_CONFIG, PRIORITY_LABEL_PREFIX)).toBeNull();
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
      PRIORITY_LABEL_PREFIX,
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
    expect(selectIssue(issues, new Map(), STACK_CONFIG, PRIORITY_LABEL_PREFIX)?.issue.number).toBe(
      2,
    );
  });

  test("logs one warning for an issue with conflicting priority labels, and none for a clean pool (#144)", () => {
    const warnings: string[] = [];
    const issues = [
      issue({
        number: 6,
        labels: ["ready-for-agent", "priority:refactor", "priority:tracer"],
      }),
      issue({ number: 7, labels: ["ready-for-agent", "priority:bug"] }),
    ];
    selectIssue(
      issues,
      new Map(),
      STACK_CONFIG,
      PRIORITY_LABEL_PREFIX,
      undefined,
      undefined,
      (message) => warnings.push(message),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("#6");
    expect(warnings[0]).toContain("priority:refactor");
    expect(warnings[0]).toContain("priority:tracer");
  });
});

describe("buildIssueQueue (#20)", () => {
  test("returns an empty queue when there are no eligible issues", () => {
    expect(buildIssueQueue([], new Map(), STACK_CONFIG, PRIORITY_LABEL_PREFIX)).toEqual([]);
  });

  test("orders a linear chain and reports the full resolved blocker set", () => {
    const issues = [
      issue({ number: 101, title: "Add toggle", body: "Blocked by #100" }),
      issue({ number: 100, title: "Fix crash on startup" }),
    ];
    const states = new Map<number, BlockerPrState>([
      [100, { hasOpenPr: true, openPrNumber: asPrNumber(200), hasMergedPr: false }],
    ]);
    expect(buildIssueQueue(issues, states, STACK_CONFIG, PRIORITY_LABEL_PREFIX)).toEqual([
      { issueNumber: 100, blockedBy: [], workable: true },
      { issueNumber: 101, blockedBy: [100], workable: true },
    ]);
  });

  test("marks an issue not workable when a blocker has no PR yet", () => {
    const issues = [issue({ number: 101, body: "Blocked by #100" })];
    const states = new Map<number, BlockerPrState>([
      [100, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(buildIssueQueue(issues, states, STACK_CONFIG, PRIORITY_LABEL_PREFIX)).toEqual([
      { issueNumber: 101, blockedBy: [100], workable: false },
    ]);
  });

  test("reports both blockers on a diamond issue, workable once each has a PR", () => {
    const issues = [issue({ number: 103, body: "Blocked by #101\nBlocked by #102" })];
    const states = new Map<number, BlockerPrState>([
      [101, { hasOpenPr: true, openPrNumber: asPrNumber(201), hasMergedPr: false }],
      [102, { hasOpenPr: true, openPrNumber: asPrNumber(202), hasMergedPr: false }],
    ]);
    expect(buildIssueQueue(issues, states, STACK_CONFIG, PRIORITY_LABEL_PREFIX)).toEqual([
      { issueNumber: 103, blockedBy: [101, 102], workable: true },
    ]);
  });

  test("excludes quarantined issues", () => {
    const issues = [issue({ number: 104, labels: ["phoebe:quarantined"] })];
    expect(buildIssueQueue(issues, new Map(), STACK_CONFIG, PRIORITY_LABEL_PREFIX)).toEqual([]);
  });

  test("warns once per conflicting-priority-label issue, not once per comparison (#144)", () => {
    const warnings: string[] = [];
    const issues = [
      issue({ number: 1, labels: ["ready-for-agent", "priority:bug", "priority:polish"] }),
      issue({ number: 2, labels: ["ready-for-agent"] }),
      issue({ number: 3, labels: ["ready-for-agent"] }),
    ];
    buildIssueQueue(
      issues,
      new Map(),
      STACK_CONFIG,
      PRIORITY_LABEL_PREFIX,
      undefined,
      undefined,
      (message) => warnings.push(message),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("#1");
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

describe("issueAttemptFailureSignature (#22, typed reasons #173)", () => {
  const FAILED: VerificationResult = {
    command: "pnpm run check",
    status: "failed",
    summary: "pnpm run check exited 1.",
  };
  const TIMED_OUT: VerificationResult = {
    command: "pnpm test",
    status: "failed",
    summary: "pnpm test timed out.",
    timedOut: true,
  };
  const PASSED: VerificationResult = {
    command: "pnpm run check",
    status: "passed",
    summary: "pnpm run check passed.",
  };

  test("a failed verification command yields verify-failed", () => {
    expect(issueAttemptFailureSignature({ verification: [PASSED, FAILED], agentExitCode: 1 })).toBe(
      "verify-failed",
    );
  });
  test("a timed-out verification command yields verify-timeout, outranking a plain failure", () => {
    expect(
      issueAttemptFailureSignature({ verification: [FAILED, TIMED_OUT], agentExitCode: 1 }),
    ).toBe("verify-timeout");
  });
  test("verification outranks the agent exit code — an agent that exits 0 but fails its own check is still verify-failed", () => {
    expect(issueAttemptFailureSignature({ verification: [FAILED], agentExitCode: 0 })).toBe(
      "verify-failed",
    );
  });
  test("falls back to the agent exit code with no failing verification result", () => {
    expect(issueAttemptFailureSignature({ verification: [PASSED], agentExitCode: 2 })).toBe(
      "agent-failed",
    );
    expect(issueAttemptFailureSignature({ verification: undefined, agentExitCode: 2 })).toBe(
      "agent-failed",
    );
  });
  test("falls back to a generic marker with no signal at all", () => {
    expect(issueAttemptFailureSignature({ verification: undefined, agentExitCode: null })).toBe(
      "no-commit",
    );
    expect(issueAttemptFailureSignature({ verification: [PASSED], agentExitCode: 0 })).toBe(
      "no-commit",
    );
  });
});

// --- Kind factories: fetch/select/refFor through the interface --------------

function fakeIo(overrides: Partial<Io> = {}): Io {
  const github: GitHub = overrides.github ?? {
    issuesWithLabel: () => [],
    issueBody: () => "",
    issueActivity: () => ({
      updatedAt: "2026-01-01T00:00:00Z",
      comments: [],
      labels: [],
      body: "",
    }),
    nativeBlockers: () => [],
    labelRemovals: () => [],
    prNumberForHead: () => undefined,
    openPrs: () => [],
    prsWithLabel: () => [],
    prMergeInfo: () => {
      throw new Error("not implemented in fake");
    },
    prActivity: () => ({ headRefOid: "" as never, lastCommitAt: null, comments: [], labels: [] }),
    reviewThreads: () => [],
    commitCheckRuns: () => [],
    resolveReviewThread: () => {},
    minimizeComment: () => {},
    commentIssue: () => {},
    commentPr: () => {},
    createPr: () => {},
    retargetPr: () => {},
    labelIssue: () => {},
    unlabelIssue: () => {},
    labelPr: () => {},
    unlabelPr: () => {},
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
    agent: { run: async () => ({ exitCode: 0 }) },
    prompts: {
      load: () => "template",
      defaultArgs: () => ({}),
      render: (template) => template,
    },
    shell: { run: () => {}, tryRun: () => 0, capture: () => ({ exitCode: 0, output: "" }) },
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

describe("createIssuesKind — run threads the issue's labels to the agent invocation (#155)", () => {
  test("the issue's labels reach io.agent.run", async () => {
    let receivedLabels: readonly string[] | undefined;
    const io = fakeIo({
      agent: {
        run: async (opts) => {
          receivedLabels = opts.labels;
          return { exitCode: 0 };
        },
      },
    });
    const deps: KindDeps = { config, io };
    const kind = createIssuesKind(deps);
    const target = issue({ number: 55, labels: ["ready-for-agent", "phoebe:tier:strong"] });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(receivedLabels).toEqual(["ready-for-agent", "phoebe:tier:strong"]);
  });

  test("usage and costUsd off io.agent.run reach the UnitResult (#165)", async () => {
    const io = fakeIo({
      agent: {
        run: async () => ({
          exitCode: 0,
          usage: { inputTokens: 9, outputTokens: 56 },
          costUsd: 0.015,
        }),
      },
    });
    const deps: KindDeps = { config, io };
    const kind = createIssuesKind(deps);
    const target = issue({ number: 56 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    const result = await kind.run(unit, fakeCtx());

    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 56 });
    expect(result.costUsd).toBe(0.015);
  });
});

// --- Repro-test-must-fail-first gate (#171) ----------------------------------

describe("isTestLikePath (#171)", () => {
  test("matches common test-file conventions", () => {
    expect(isTestLikePath("src/kinds/producer.test.ts")).toBe(true);
    expect(isTestLikePath("src/kinds/producer.spec.ts")).toBe(true);
    expect(isTestLikePath("internal/foo_test.go")).toBe(true);
    expect(isTestLikePath("scripts/test_foo.py")).toBe(true);
    expect(isTestLikePath("tests/foo.py")).toBe(true);
    expect(isTestLikePath("src/__tests__/foo.ts")).toBe(true);
  });

  test("does not match ordinary source paths", () => {
    expect(isTestLikePath("src/kinds/producer.ts")).toBe(false);
    expect(isTestLikePath("src/latest.ts")).toBe(false);
    expect(isTestLikePath("docs/contest-rules.md")).toBe(false);
  });
});

type QuarantineRecordCall = { trigger: string; signature: string; reason: string };

function fakeReproIo(opts: {
  diffOutput?: string;
  testCwdBehavior?: (cwd: string) => number;
  installThrowsFor?: (cwd: string) => boolean;
  prepareWorktreeThrowsForRepro?: boolean;
}): { io: Io; createdPrs: Array<{ head: string }>; quarantineCalls: QuarantineRecordCall[] } {
  const createdPrs: Array<{ head: string }> = [];
  const quarantineCalls: QuarantineRecordCall[] = [];

  const io = fakeIo({
    git: {
      fetchOrigin: () => {},
      originBranchSha: () => "" as never,
      prepareWorktree: (prepareOpts) => {
        if (prepareOpts.force) {
          if (opts.prepareWorktreeThrowsForRepro) {
            throw new Error("worktree add failed");
          }
          return "/tmp/repro-worktree";
        }
        return "/tmp/worktree";
      },
      removeWorktree: () => {},
      pushBranch: () => {},
      commitCount: () => 1,
      gitInWorktree: (_dir, args) => (args[0] === "diff" ? (opts.diffOutput ?? "") : ""),
    },
    shell: {
      run: (_command, cwd) => {
        if (opts.installThrowsFor?.(cwd)) {
          throw new Error("install failed");
        }
      },
      tryRun: (_command, cwd) => opts.testCwdBehavior?.(cwd) ?? 1,
      capture: () => ({ exitCode: 0, output: "" }),
    },
    github: {
      issuesWithLabel: () => [],
      issueBody: () => "",
      issueActivity: () => ({
        updatedAt: "2026-01-01T00:00:00Z",
        comments: [],
        labels: [],
        body: "",
      }),
      nativeBlockers: () => [],
      labelRemovals: () => [],
      prNumberForHead: () => undefined,
      openPrs: () => [],
      prsWithLabel: () => [],
      prMergeInfo: () => {
        throw new Error("not implemented in fake");
      },
      prActivity: () => ({ headRefOid: "" as never, lastCommitAt: null, comments: [], labels: [] }),
      reviewThreads: () => [],
      commitCheckRuns: () => [],
      resolveReviewThread: () => {},
      minimizeComment: () => {},
      commentIssue: () => {},
      commentPr: () => {},
      createPr: (createOpts) => {
        createdPrs.push({ head: createOpts.head });
      },
      retargetPr: () => {},
      labelIssue: () => {},
      unlabelIssue: () => {},
      labelPr: () => {},
      unlabelPr: () => {},
      linkStack: () => {},
      installStackExtension: () => {},
      login: () => "phoebe-bot",
      updateComment: () => {},
    },
    quarantine: {
      record: (_unit, trigger, detail) => {
        quarantineCalls.push({ trigger, signature: detail.signature, reason: detail.reason });
      },
      resolve: () => {},
      recordNoOp: () => {},
      sweepUnstuck: () => {},
    },
  });
  return { io, createdPrs, quarantineCalls };
}

describe("createIssuesKind — repro-test-must-fail-first gate (#171)", () => {
  test("no test-like path in the diff — the gate is a no-op, PR opens normally", async () => {
    const { io, createdPrs, quarantineCalls } = fakeReproIo({
      diffOutput: "src/kinds/producer.ts\n",
    });
    const kind = createIssuesKind({ config, io });
    const target = issue({ number: 60 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(createdPrs).toEqual([{ head: "phoebe/issue-60" }]);
    expect(quarantineCalls).toEqual([]);
  });

  test("new test fails against the pre-change tree (confirmed) — PR opens normally", async () => {
    const { io, createdPrs, quarantineCalls } = fakeReproIo({
      diffOutput: "src/kinds/foo.test.ts\n",
      testCwdBehavior: (cwd) => (cwd === "/tmp/repro-worktree" ? 1 : 0),
    });
    const kind = createIssuesKind({ config, io });
    const target = issue({ number: 61 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(createdPrs).toEqual([{ head: "phoebe/issue-61" }]);
    expect(quarantineCalls).toEqual([]);
  });

  test("new test already passes against the pre-change tree (weak) — discarded, no PR, quarantine recorded", async () => {
    const { io, createdPrs, quarantineCalls } = fakeReproIo({
      diffOutput: "src/kinds/foo.test.ts\n",
      testCwdBehavior: () => 0,
    });
    const kind = createIssuesKind({ config, io });
    const target = issue({ number: 62 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(createdPrs).toEqual([]);
    expect(quarantineCalls).toEqual([
      { trigger: "no-pr", signature: "repro-test-passed-pre-patch", reason: expect.any(String) },
    ]);
  });

  test("pre-patch install failure is untestable — fails open, PR still opens", async () => {
    const { io, createdPrs, quarantineCalls } = fakeReproIo({
      diffOutput: "src/kinds/foo.test.ts\n",
      installThrowsFor: (cwd) => cwd === "/tmp/repro-worktree",
    });
    const kind = createIssuesKind({ config, io });
    const target = issue({ number: 63 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(createdPrs).toEqual([{ head: "phoebe/issue-63" }]);
    expect(quarantineCalls).toEqual([]);
  });

  test("cannot even prepare the pre-patch worktree — untestable, fails open", async () => {
    const { io, createdPrs, quarantineCalls } = fakeReproIo({
      diffOutput: "src/kinds/foo.test.ts\n",
      prepareWorktreeThrowsForRepro: true,
    });
    const kind = createIssuesKind({ config, io });
    const target = issue({ number: 64 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(createdPrs).toEqual([{ head: "phoebe/issue-64" }]);
    expect(quarantineCalls).toEqual([]);
  });
});

describe("createIssuesKind — engine-executed verification (#166)", () => {
  test("verifyMode 'agent' never calls io.shell.capture", async () => {
    let captureCalled = false;
    const io = fakeIo({
      shell: {
        run: () => {},
        tryRun: () => 0,
        capture: () => {
          captureCalled = true;
          return { exitCode: 0, output: "" };
        },
      },
    });
    const deps: KindDeps = { config: { ...config, verifyMode: "agent" }, io };
    const kind = createIssuesKind(deps);
    const target = issue({ number: 60 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(captureCalled).toBe(false);
  });

  test("verifyMode 'engine' runs checkCommand and testCommand itself and reports that result", async () => {
    const capturedCommands: string[] = [];
    const io = fakeIo({
      shell: {
        run: () => {},
        tryRun: () => 0,
        capture: (command) => {
          capturedCommands.push(command);
          return command === config.testCommand
            ? { exitCode: 1, output: "boom" }
            : { exitCode: 0, output: "" };
        },
      },
    });
    const deps: KindDeps = { config: { ...config, verifyMode: "engine" }, io };
    const kind = createIssuesKind(deps);
    const target = issue({ number: 61 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    const result = await kind.run(unit, fakeCtx());

    expect(capturedCommands).toEqual([config.checkCommand, config.testCommand]);
    expect(result.verification).toEqual([
      { command: config.checkCommand, status: "passed", summary: `${config.checkCommand} passed.` },
      {
        command: config.testCommand,
        status: "failed",
        summary: `${config.testCommand} exited 1.\nboom`,
      },
    ]);
  });

  test("verifyMode 'both' reports the engine's result and logs a disagreement with the agent's report", async () => {
    const logLines: string[] = [];
    const io = fakeIo({
      shell: {
        run: () => {},
        tryRun: () => 0,
        capture: () => ({ exitCode: 1, output: "engine says it failed" }),
      },
    });
    const deps: KindDeps = { config: { ...config, verifyMode: "both" }, io };
    const kind = createIssuesKind(deps);
    const target = issue({ number: 62 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    const originalConsoleLog = console.log;
    console.log = (line: string) => logLines.push(line);
    try {
      await kind.run(unit, fakeCtx());
    } finally {
      console.log = originalConsoleLog;
    }

    // No VERIFICATION_RESULT_FILE was actually written (the fake agent never
    // wrote one), so the agent side of the comparison is "reported nothing" —
    // still a disagreement against the engine's failed result.
    expect(logLines.some((line) => line.includes("verification disagreement"))).toBe(true);
  });
});

// --- no-pr / timed-out backoff (#137) ----------------------------------------

function markerComment(kind: "issues" | "research", trigger: "no-pr" | "timed-out", at: string) {
  return {
    id: `IC_${kind}_${trigger}`,
    body: `<!-- phoebe-unit:${kind}:${trigger} n=1 sig=no-commit-produced ref=42 at=${at} -->`,
    createdAt: at,
    authorLogin: "phoebe-bot",
  };
}

function fakeIoWithIssueActivity(
  commentsByIssue: Record<number, ReturnType<typeof markerComment>[]>,
) {
  return fakeIo({
    github: {
      ...fakeIo().github,
      issueActivity: (issueNumber: number) => ({
        updatedAt: "2026-01-01T00:00:00Z",
        comments: commentsByIssue[issueNumber] ?? [],
        labels: [],
        body: "",
      }),
    },
  });
}

describe("createIssuesKind / createResearchKind — no-pr/timed-out backoff (#137)", () => {
  test("a fresh no-pr marker holds the issue back inside its backoff window", async () => {
    const now = new Date().toISOString();
    const deps: KindDeps = {
      config,
      io: fakeIoWithIssueActivity({ 42: [markerComment("issues", "no-pr", now)] }),
    };
    const kind = createIssuesKind(deps);
    const ready = [issue({ number: 42 })];
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] } }));
    expect(data.issues).toEqual([]);
  });

  test("a no-pr marker past its backoff window is re-picked", async () => {
    const deps: KindDeps = {
      config,
      io: fakeIoWithIssueActivity({
        42: [markerComment("issues", "no-pr", "2000-01-01T00:00:00.000Z")],
      }),
    };
    const kind = createIssuesKind(deps);
    const ready = [issue({ number: 42 })];
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] } }));
    expect(data.issues.map((i) => i.number)).toEqual([42]);
  });

  test("a fresh timed-out marker holds the issue back the same as no-pr", async () => {
    const now = new Date().toISOString();
    const deps: KindDeps = {
      config,
      io: fakeIoWithIssueActivity({ 42: [markerComment("issues", "timed-out", now)] }),
    };
    const kind = createIssuesKind(deps);
    const ready = [issue({ number: 42 })];
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] } }));
    expect(data.issues).toEqual([]);
  });

  test("research tickets get the same backoff despite not leasing", async () => {
    const now = new Date().toISOString();
    const deps: KindDeps = {
      config,
      io: fakeIoWithIssueActivity({ 7: [markerComment("research", "no-pr", now)] }),
    };
    const kind = createResearchKind(deps);
    const research = [issue({ number: 7 })];
    const data = await kind.fetch(fakeCtx({ pools: { ready: [], research } }));
    expect(data.issues).toEqual([]);
  });

  test("a marker for the other kind's namespace does not apply — issues and research count separately", async () => {
    const now = new Date().toISOString();
    const deps: KindDeps = {
      config,
      // A no-pr marker recorded under "research" must not back off the same
      // issue number picked up as a plain "issues" ticket.
      io: fakeIoWithIssueActivity({ 42: [markerComment("research", "no-pr", now)] }),
    };
    const kind = createIssuesKind(deps);
    const ready = [issue({ number: 42 })];
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] } }));
    expect(data.issues.map((i) => i.number)).toEqual([42]);
  });

  test("a quarantined issue is not fetched for activity and stays excluded", async () => {
    let calls = 0;
    const deps: KindDeps = {
      config,
      io: fakeIo({
        github: {
          ...fakeIo().github,
          issueActivity: () => {
            calls++;
            return { updatedAt: "2026-01-01T00:00:00Z", comments: [], labels: [], body: "" };
          },
        },
      }),
    };
    const kind = createIssuesKind(deps);
    const ready = [issue({ number: 99, labels: [PHOEBE_QUARANTINE_LABEL] })];
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] } }));
    expect(data.issues.map((i) => i.number)).toEqual([99]);
    expect(kind.select(data, fakeCtx())).toBeNull();
    expect(calls).toBe(0);
  });
});

// --- No-op verdict suppression (#145) ----------------------------------------

function noOpMarkerComment(kind: "issues" | "research", ref: string, at: string) {
  return {
    id: `IC_${kind}_no-op`,
    body: `<!-- phoebe-unit:${kind}:no-op n=1 sig=no-op ref=${ref} at=${at} -->`,
    createdAt: at,
    authorLogin: "phoebe-bot",
  };
}

describe("createIssuesKind / createResearchKind — no-op verdict suppression (#145)", () => {
  test("a no-op verdict whose key matches the current body suppresses the issue outright", async () => {
    const body = "nothing to do here";
    const key = issueContentBaseline(body);
    const deps: KindDeps = {
      config,
      io: fakeIoWithIssueActivity({
        42: [noOpMarkerComment("issues", key, "2020-01-01T00:00:00Z")],
      }),
    };
    const kind = createIssuesKind(deps);
    const ready = [issue({ number: 42, body })];
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] } }));
    expect(data.issues).toEqual([]);
  });

  test("suppression is unconditional on time — an old verdict still holds while the body is unchanged", async () => {
    const body = "nothing to do here";
    const key = issueContentBaseline(body);
    const deps: KindDeps = {
      config,
      // Ancient timestamp — well past any backoff window (#137) — but #145's
      // suppression never expires on its own, only on a content change.
      io: fakeIoWithIssueActivity({
        355: [noOpMarkerComment("research", key, "2000-01-01T00:00:00Z")],
      }),
    };
    const kind = createResearchKind(deps);
    const research = [issue({ number: 355, body })];
    const data = await kind.fetch(fakeCtx({ pools: { ready: [], research } }));
    expect(data.issues).toEqual([]);
  });

  test("a body edit invalidates a stale no-op verdict — the issue is re-picked", async () => {
    const key = issueContentBaseline("old body");
    const deps: KindDeps = {
      config,
      io: fakeIoWithIssueActivity({
        42: [noOpMarkerComment("issues", key, "2020-01-01T00:00:00Z")],
      }),
    };
    const kind = createIssuesKind(deps);
    const ready = [issue({ number: 42, body: "new body" })];
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] } }));
    expect(data.issues.map((i) => i.number)).toEqual([42]);
  });

  test("a marker for the other kind's namespace does not suppress — issues and research count separately", async () => {
    const body = "nothing to do here";
    const key = issueContentBaseline(body);
    const deps: KindDeps = {
      config,
      io: fakeIoWithIssueActivity({
        42: [noOpMarkerComment("research", key, "2020-01-01T00:00:00Z")],
      }),
    };
    const kind = createIssuesKind(deps);
    const ready = [issue({ number: 42, body })];
    const data = await kind.fetch(fakeCtx({ pools: { ready, research: [] } }));
    expect(data.issues.map((i) => i.number)).toEqual([42]);
  });

  test("a run that cleanly finds nothing to do records a no-op verdict keyed on the issue body", async () => {
    const recordNoOpCalls: Array<{ kind: string; issueNumber: number; key: string }> = [];
    const body = "please do the thing";
    const io = fakeIo({
      quarantine: {
        record: () => {},
        resolve: () => {},
        recordNoOp: (unit, key) => {
          recordNoOpCalls.push({ kind: unit.kind, issueNumber: unit.target.number, key });
        },
        sweepUnstuck: () => {},
      },
    });
    const deps: KindDeps = { config, io };
    const kind = createIssuesKind(deps);
    const target = issue({ number: 77, body });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(recordNoOpCalls).toEqual([
      { kind: "issues", issueNumber: 77, key: issueContentBaseline(body) },
    ]);
  });

  test("an actual failure (nonzero agent exit) does not record a no-op verdict", async () => {
    const recordNoOpCalls: unknown[] = [];
    const io = fakeIo({
      agent: { run: async () => ({ exitCode: 1 }) },
      quarantine: {
        record: () => {},
        resolve: () => {},
        recordNoOp: (...args) => recordNoOpCalls.push(args),
        sweepUnstuck: () => {},
      },
    });
    const deps: KindDeps = { config, io };
    const kind = createIssuesKind(deps);
    const target = issue({ number: 78 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(recordNoOpCalls).toEqual([]);
  });

  test("producing a PR clears a stale no-op verdict alongside the no-PR counter", async () => {
    const resolveCalls: string[] = [];
    const io = fakeIo({
      git: {
        fetchOrigin: () => {},
        originBranchSha: () => "" as never,
        prepareWorktree: () => "/tmp/worktree",
        removeWorktree: () => {},
        pushBranch: () => {},
        commitCount: () => 1,
        gitInWorktree: () => "",
      },
      quarantine: {
        record: () => {},
        resolve: (_unit, trigger) => resolveCalls.push(trigger),
        recordNoOp: () => {},
        sweepUnstuck: () => {},
      },
    });
    const deps: KindDeps = { config, io };
    const kind = createIssuesKind(deps);
    const target = issue({ number: 79 });
    const unit = { issue: target, resolution: { worktreeBase: "main", stacked: false } };

    await kind.run(unit, fakeCtx());

    expect(resolveCalls).toEqual(["no-pr", "no-op"]);
  });
});
