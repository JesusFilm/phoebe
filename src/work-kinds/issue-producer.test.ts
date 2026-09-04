// Unit tests for the engine-owned claim write in issueProducerKind (#365).
// Focus: the `claimIssue` path — addIssueLabel call, label-not-found self-heal,
// and abort on any other failure. The selection-side processingLabel filter is
// tested in src/orchestrator.test.ts (selectIssue, unresolvedBlockerNumbers).

import { describe, expect, test } from "vite-plus/test";
import { asPrNumber } from "../branded.ts";
import { resolveConfig } from "../config-schema.ts";
import { featureBranch, type Feature } from "../feature-branch.ts";
import { isLabelNotFoundError } from "../gh-error.ts";
import { issueProducerKind, type IssueProducerUnit } from "./issue-producer.ts";
import type { WorkKindCtx, WorkKindRunCtx } from "./definition.ts";
import { issueBranch, type Issue } from "../orchestrator.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = resolveConfig({
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  readyCommand: "npm run ready",
});

function anIssueUnit(number: number): IssueProducerUnit {
  return {
    ref: `issue:${number}`,
    github: { objectType: "issue", id: number },
    issue: {
      number,
      title: `Issue ${number}`,
      body: "",
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
    },
    resolution: { worktreeBase: "origin/main", stacked: false },
  };
}

/** Minimal WorkKindRunCtx for testing the claim path. */
function makeCtx(overrides: {
  issueLabels?: (issueNumber: number) => string[];
  addIssueLabel?: (issueNumber: number, label: string) => void;
  createLabel?: (name: string) => void;
  issueWorkflow?: () => Promise<void>;
}): WorkKindRunCtx {
  const { issueLabels, addIssueLabel, createLabel, issueWorkflow } = overrides;
  return {
    kind: "issues",
    config: BASE_CONFIG,
    options: undefined,
    env: {},
    cycle: {
      issueBody: () => null,
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: () => null,
    },
    clock: {
      now: () => new Date(),
      sleep: () => Promise.resolve(),
    },
    inFlight: new Set<string>(),
    log: () => {},
    // WorkKindGitHub — we only need issueLabels, addIssueLabel, and createLabel
    github: new Proxy({} as WorkKindRunCtx["github"], {
      get(_target, prop) {
        if (prop === "issueLabels") return issueLabels ?? (() => []);
        if (prop === "addIssueLabel") return addIssueLabel ?? (() => {});
        if (prop === "createLabel") return createLabel ?? (() => {});
        if (typeof prop !== "string" || prop === "then") return undefined;
        throw new Error(`github.${prop} was not expected to be called in this test`);
      },
    }),
    origin: {
      fetch: () => {},
      branchHead: () => "abc".padEnd(40, "0") as ReturnType<WorkKindRunCtx["origin"]["branchHead"]>,
      commitsBehind: () => 0,
    },
    workspace: {
      mode: "worktree",
      dir: "/tmp/test-worktree",
    },
    signal: new AbortController().signal,
    agent: {
      run: () => Promise.resolve(),
      prWorkflow: () => Promise.resolve(),
      issueWorkflow: issueWorkflow ?? (() => Promise.resolve()),
      cleanMerge: () => "pushed",
    },
  };
}

/** Build the kind and return its `run` method for direct testing. */
function buildRun(
  listIssues: () => never[],
): (unit: IssueProducerUnit, ctx: WorkKindRunCtx) => Promise<void> {
  const kind = issueProducerKind({
    name: "issues",
    promptFile: "prompts/issues-prompt.md",
    noun: "issue(s)",
    unitNoun: "issue",
    verb: "Working",
    listIssues,
  });
  return (unit, ctx) => kind.run(unit, ctx);
}

// Construct the label-not-found error that isLabelNotFoundError expects:
// a SpawnSyncReturns-style object with stderr carrying the GitHub message.
function labelNotFoundError(): Error {
  const err = new Error('gh: Label not found: "processing"') as Error & {
    stderr: string;
  };
  err.stderr = 'GraphQL: Label not found: "processing" (addLabelsToLabelable)';
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isLabelNotFoundError", () => {
  test("matches the GitHub GraphQL error text", () => {
    expect(isLabelNotFoundError(labelNotFoundError())).toBe(true);
  });

  test("does not match an unrelated error", () => {
    const err = new Error("network failure") as Error & { stderr: string };
    err.stderr = "connection reset by peer";
    expect(isLabelNotFoundError(err)).toBe(false);
  });

  test("returns false when stderr is absent (inherited-stdio writes)", () => {
    expect(isLabelNotFoundError(new Error("gh: exit status 1"))).toBe(false);
  });
});

describe("claim write in issueProducerKind.run", () => {
  test("addIssueLabel is called with the issue number and processingLabel", async () => {
    const calls: Array<{ issueNumber: number; label: string }> = [];
    const run = buildRun(() => []);
    const unit = anIssueUnit(42);
    const ctx = makeCtx({
      addIssueLabel: (issueNumber, label) => {
        calls.push({ issueNumber, label });
      },
    });

    await run(unit, ctx);

    expect(calls).toEqual([{ issueNumber: 42, label: BASE_CONFIG.processingLabel }]);
  });

  test("label-not-found triggers createLabel + retry", async () => {
    const writes: string[] = [];
    const run = buildRun(() => []);
    const unit = anIssueUnit(7);
    let callCount = 0;
    const ctx = makeCtx({
      addIssueLabel: (_issueNumber, _label) => {
        callCount++;
        if (callCount === 1) throw labelNotFoundError();
        // second call succeeds
      },
      createLabel: (name) => {
        writes.push(`create:${name}`);
      },
    });

    await run(unit, ctx);

    expect(writes).toEqual([`create:${BASE_CONFIG.processingLabel}`]);
    expect(callCount).toBe(2);
  });

  test("a non-label-not-found error aborts the unit without running the agent", async () => {
    const run = buildRun(() => []);
    const unit = anIssueUnit(7);
    let agentRan = false;
    const ctx = makeCtx({
      addIssueLabel: () => {
        throw new Error("GitHub 403: permission not granted");
      },
      issueWorkflow: async () => {
        agentRan = true;
      },
    });

    await expect(run(unit, ctx)).rejects.toThrow("GitHub 403");
    expect(agentRan).toBe(false);
  });

  test("a failed retry (after create) propagates and aborts the unit", async () => {
    const run = buildRun(() => []);
    const unit = anIssueUnit(7);
    let agentRan = false;
    const ctx = makeCtx({
      addIssueLabel: () => {
        throw labelNotFoundError();
      },
      createLabel: () => {},
      issueWorkflow: async () => {
        agentRan = true;
      },
    });

    await expect(run(unit, ctx)).rejects.toSatisfy(isLabelNotFoundError);
    expect(agentRan).toBe(false);
  });

  test("agent runs only after a successful claim", async () => {
    const run = buildRun(() => []);
    const unit = anIssueUnit(15);
    const order: string[] = [];
    const ctx = makeCtx({
      addIssueLabel: () => {
        order.push("claim");
      },
      issueWorkflow: async () => {
        order.push("agent");
      },
    });

    await run(unit, ctx);

    expect(order).toEqual(["claim", "agent"]);
  });

  test("overlapping invocation: issue already carries processingLabel — workflow is skipped", async () => {
    const run = buildRun(() => []);
    const unit = anIssueUnit(22);
    let agentRan = false;
    let addLabelCalled = false;
    const ctx = makeCtx({
      // Simulate: another run already claimed the issue before we enter run()
      issueLabels: () => [BASE_CONFIG.processingLabel],
      addIssueLabel: () => {
        addLabelCalled = true;
      },
      issueWorkflow: async () => {
        agentRan = true;
      },
    });

    await run(unit, ctx);

    expect(agentRan).toBe(false);
    expect(addLabelCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Feature arm: select() routing and run() branch/PR lifecycle (#379)
// ---------------------------------------------------------------------------

function anIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function liveFeature(issueNumber: number, title = "My feature"): Feature {
  return { issueNumber, title, branch: featureBranch(issueNumber) };
}

/** Minimal WorkKindCtx for select() testing. */
function makeSelectCtx(featureFor: (n: number) => Feature | null): WorkKindCtx {
  return {
    kind: "issues",
    config: BASE_CONFIG,
    options: undefined,
    env: {},
    cycle: {
      issueBody: () => null,
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: featureFor,
    },
    clock: {
      now: () => new Date(),
      sleep: () => Promise.resolve(),
    },
    inFlight: new Set<string>(),
    log: () => {},
    github: new Proxy({} as WorkKindCtx["github"], {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        throw new Error(`github.${prop} should not be called in select()`);
      },
    }),
    origin: {
      fetch: () => {},
      branchHead: () => "abc".padEnd(40, "0") as ReturnType<WorkKindCtx["origin"]["branchHead"]>,
      commitsBehind: () => 0,
    },
  };
}

function buildKind(issues: Issue[]) {
  return issueProducerKind({
    name: "issues",
    promptFile: "prompts/issues-prompt.md",
    noun: "issue(s)",
    unitNoun: "issue",
    verb: "Working",
    listIssues: () => issues,
  });
}

describe("issueProducerKind.select — feature arm routing", () => {
  test("non-member routes to origin/main as before", () => {
    const kind = buildKind([anIssue(10)]);
    const ctx = makeSelectCtx(() => null);
    const result = kind.select({ issues: [anIssue(10)] }, ctx);
    expect(result.unit?.resolution.worktreeBase).toBe("origin/main");
    expect(result.unit?.resolution.featureIssueNumber).toBeUndefined();
  });

  test("member of a live feature routes to the feature branch", () => {
    const kind = buildKind([anIssue(10)]);
    const ctx = makeSelectCtx(() => liveFeature(1, "The feature"));
    const result = kind.select({ issues: [anIssue(10)] }, ctx);
    expect(result.unit?.resolution.worktreeBase).toBe(`origin/${featureBranch(1)}`);
    expect(result.unit?.resolution.featureIssueNumber).toBe(1);
    expect(result.unit?.resolution.featureIssueTitle).toBe("The feature");
  });

  test("PHOEBE_BASE wins over the feature arm", () => {
    const kind = buildKind([anIssue(10)]);
    const ctx: WorkKindCtx = {
      ...makeSelectCtx(() => liveFeature(1)),
      env: { PHOEBE_BASE: "custom/base" },
    };
    const result = kind.select({ issues: [anIssue(10)] }, ctx);
    expect(result.unit?.resolution.worktreeBase).toBe("custom/base");
    expect(result.unit?.resolution.featureIssueNumber).toBeUndefined();
  });

  test("member blocked by a member of the same feature stacks and keeps the feature", () => {
    const blockedIssue = anIssue(10, { body: "Blocked by #5" });
    const kind = buildKind([blockedIssue]);
    const ctx: WorkKindCtx = {
      ...makeSelectCtx(() => liveFeature(1)),
      cycle: {
        issueBody: () => null,
        registerIssues: () => {},
        blockerStates: () =>
          new Map([[5, { hasOpenPr: true, openPrNumber: asPrNumber(99), hasMergedPr: false }]]),
        feature: () => liveFeature(1),
      },
    };
    const result = kind.select({ issues: [blockedIssue] }, ctx);
    expect(result.unit?.resolution.stacked).toBe(true);
    expect(result.unit?.resolution.worktreeBase).toBe(`origin/${issueBranch(5)}`);
    expect(result.unit?.resolution.featureIssueNumber).toBe(1);
  });

  test("member blocked by a non-member is skipped", () => {
    const blockedIssue = anIssue(10, { body: "Blocked by #5" });
    const kind = buildKind([blockedIssue]);
    const ctx: WorkKindCtx = {
      ...makeSelectCtx(() => null),
      cycle: {
        issueBody: () => null,
        registerIssues: () => {},
        blockerStates: () =>
          new Map([[5, { hasOpenPr: true, openPrNumber: asPrNumber(99), hasMergedPr: false }]]),
        feature: (n) => (n === 10 ? liveFeature(1) : null),
      },
    };
    expect(kind.select({ issues: [blockedIssue] }, ctx).unit).toBeNull();
  });

  test("integration PR number is carried through when the feature already has one", () => {
    const feature: Feature = {
      issueNumber: 1,
      title: "F",
      branch: featureBranch(1),
      integrationPrNumber: asPrNumber(42),
    };
    const kind = buildKind([anIssue(10)]);
    const ctx = makeSelectCtx(() => feature);
    const result = kind.select({ issues: [anIssue(10)] }, ctx);
    expect(result.unit?.resolution.featureIssueNumber).toBe(1);
  });
});

describe("issueProducerKind.run — feature branch and draft PR creation", () => {
  function makeRunCtxWithFeature(
    opts: {
      createFeatureBranch?: (n: number) => void;
      ensureDraftIntegrationPr?: (n: number, title: string) => void;
    } = {},
  ): WorkKindRunCtx {
    const { createFeatureBranch, ensureDraftIntegrationPr } = opts;
    return {
      kind: "issues",
      config: BASE_CONFIG,
      options: undefined,
      env: {},
      cycle: {
        issueBody: () => null,
        registerIssues: () => {},
        blockerStates: () => new Map(),
        feature: () => null,
      },
      clock: { now: () => new Date(), sleep: () => Promise.resolve() },
      inFlight: new Set<string>(),
      log: () => {},
      github: new Proxy({} as WorkKindRunCtx["github"], {
        get(_target, prop) {
          if (prop === "issueLabels") return () => [];
          if (prop === "addIssueLabel") return () => {};
          if (prop === "createFeatureBranch") return createFeatureBranch ?? (() => {});
          if (prop === "ensureDraftIntegrationPr") return ensureDraftIntegrationPr ?? (() => {});
          if (typeof prop !== "string" || prop === "then") return undefined;
          throw new Error(`github.${prop} was not expected in this test`);
        },
      }),
      origin: {
        fetch: () => {},
        branchHead: () =>
          "abc".padEnd(40, "0") as ReturnType<WorkKindRunCtx["origin"]["branchHead"]>,
        commitsBehind: () => 0,
      },
      workspace: { mode: "worktree", dir: "/tmp/test-worktree" },
      signal: new AbortController().signal,
      agent: {
        run: () => Promise.resolve(),
        prWorkflow: () => Promise.resolve(),
        issueWorkflow: () => Promise.resolve(),
        cleanMerge: () => "pushed",
      },
    };
  }

  function featureUnit(
    issueNumber: number,
    featureIssueNumber: number,
    featureIssueTitle: string,
  ): IssueProducerUnit {
    return {
      ref: `issue:${issueNumber}`,
      github: { objectType: "issue", id: issueNumber },
      issue: anIssue(issueNumber),
      resolution: {
        worktreeBase: `origin/${featureBranch(featureIssueNumber)}`,
        stacked: false,
        featureIssueNumber,
        featureIssueTitle,
      },
    };
  }

  test("createFeatureBranch is called before the agent for feature members", async () => {
    const calls: number[] = [];
    const kind = buildKind([]);
    const unit = featureUnit(10, 1, "My feature");
    const ctx = makeRunCtxWithFeature({
      createFeatureBranch: (n) => {
        calls.push(n);
      },
    });
    await kind.run(unit, ctx);
    expect(calls).toEqual([1]);
  });

  test("ensureDraftIntegrationPr is called with feature number and title", async () => {
    const calls: Array<{ n: number; title: string }> = [];
    const kind = buildKind([]);
    const unit = featureUnit(10, 1, "My feature");
    const ctx = makeRunCtxWithFeature({
      ensureDraftIntegrationPr: (n, title) => {
        calls.push({ n, title });
      },
    });
    await kind.run(unit, ctx);
    expect(calls).toEqual([{ n: 1, title: "My feature" }]);
  });

  test("non-member: createFeatureBranch and ensureDraftIntegrationPr are not called", async () => {
    let branchCalled = false;
    let prCalled = false;
    const unit = anIssueUnit(42);
    const kind = buildKind([]);
    const ctx = makeRunCtxWithFeature({
      createFeatureBranch: () => {
        branchCalled = true;
      },
      ensureDraftIntegrationPr: () => {
        prCalled = true;
      },
    });
    await kind.run(unit, ctx);
    expect(branchCalled).toBe(false);
    expect(prCalled).toBe(false);
  });

  test("featureIssueNumber is threaded through to issueWorkflow", async () => {
    let capturedFeatureNumber: number | undefined = undefined;
    const kind = buildKind([]);
    const unit = featureUnit(10, 1, "My feature");
    const ctx = makeRunCtxWithFeature({});
    const ctxWithCapture: WorkKindRunCtx = {
      ...ctx,
      agent: {
        ...ctx.agent,
        issueWorkflow: async (opts) => {
          capturedFeatureNumber = opts.featureIssueNumber;
        },
      },
    };
    await kind.run(unit, ctxWithCapture);
    expect(capturedFeatureNumber).toBe(1);
  });
});
