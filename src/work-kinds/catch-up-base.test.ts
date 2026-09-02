// The catch-up base (#392): every merge the janitors run against a PR targets
// that PR's own base, not the default branch.
//
// The distinction only exists since the feature arm (#341). A feature member is
// based on `<branchPrefix>feature-<M>`, so when GitHub calls it conflicting it
// is reporting a conflict against the feature branch; merging the default
// branch instead resolves a different merge and lands every commit `main` has
// moved by in a diff the member's reviewer never asked for. Ordinary PRs and a
// feature's integration PR are still based on the default branch, and this file
// pins that they are treated exactly as before.
//
// Both kinds are here because both merge: `conflicts` on every unit, `checks`
// on the BEHIND catch-up ahead of its agent.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha, type BranchRef, type PrNumber } from "../branded.ts";
import { resolveConfig } from "../config-schema.ts";
import { featureBranch } from "../feature-branch.ts";
import { issueBranch } from "../orchestrator.ts";
import { checksKind } from "./checks.ts";
import { conflictsKind } from "./conflicts.ts";
import type { AgentHelpers, WorkKindRunCtx } from "./definition.ts";

const CONFIG = resolveConfig({
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  readyCommand: "npm run ready",
});

const MEMBER_BRANCH = issueBranch(42);
const FEATURE_BRANCH = featureBranch(9);

/** What a run did to the world, as far as these tests care. */
type Recorded = {
  cleanMerge: { branch: BranchRef; base: string | undefined }[];
  prWorkflow: { baseBranch: string | undefined; promptArgs: Record<string, string> }[];
  logs: string[];
};

function makeCtx(cleanMergeOutcome: ReturnType<AgentHelpers["cleanMerge"]>): {
  ctx: WorkKindRunCtx;
  recorded: Recorded;
} {
  const recorded: Recorded = { cleanMerge: [], prWorkflow: [], logs: [] };
  const ctx = {
    kind: "conflicts",
    config: CONFIG,
    options: undefined,
    env: {},
    cycle: {
      issueBody: () => null,
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: () => null,
    },
    clock: { now: () => new Date(), sleep: () => Promise.resolve() },
    log: (line: string) => recorded.logs.push(line),
    github: new Proxy({} as WorkKindRunCtx["github"], {
      get(_target, prop) {
        // The agent path re-reads mergeability before deciding it failed; a
        // MERGEABLE answer with commits pushed is the success branch.
        if (prop === "currentMergeInfo") {
          return () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
        }
        if (prop === "postPrComment") return () => {};
        if (typeof prop !== "string" || prop === "then") return undefined;
        throw new Error(`github.${prop} was not expected in this test`);
      },
    }),
    origin: {
      fetch: () => {},
      branchHead: () => asSha("a".padEnd(40, "0")),
      commitsBehind: () => 0,
    },
    workspace: { mode: "worktree" as const, dir: "/tmp/test-worktree" },
    signal: new AbortController().signal,
    agent: {
      run: () => Promise.resolve(),
      prWorkflow: (opts: Parameters<AgentHelpers["prWorkflow"]>[0]) => {
        recorded.prWorkflow.push({
          baseBranch: opts.baseBranch,
          promptArgs: opts.promptArgs,
        });
        return Promise.resolve();
      },
      issueWorkflow: () => Promise.resolve(),
      cleanMerge: (branch: BranchRef, _blockers?: readonly PrNumber[], base?: string) => {
        recorded.cleanMerge.push({ branch, base });
        return cleanMergeOutcome;
      },
    },
  } as unknown as WorkKindRunCtx;
  return { ctx, recorded };
}

function conflictsUnit(opts: { headRefName: BranchRef; baseRefName?: BranchRef }): unknown {
  return {
    ref: "pr:7",
    github: { objectType: "pr", id: 7 },
    pr: {
      prNumber: asPrNumber(7),
      headRefName: opts.headRefName,
      ...(opts.baseRefName !== undefined ? { baseRefName: opts.baseRefName } : {}),
      headSha: asSha("f7".padEnd(40, "0")),
    },
    mergedBlockerPrNumbers: [],
  };
}

function checksUnit(opts: { headRefName: BranchRef; baseRefName?: BranchRef }): unknown {
  return {
    ref: "pr:7",
    github: { objectType: "pr", id: 7 },
    pr: {
      prNumber: asPrNumber(7),
      headRefName: opts.headRefName,
      ...(opts.baseRefName !== undefined ? { baseRefName: opts.baseRefName } : {}),
      headSha: asSha("f7".padEnd(40, "0")),
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
      failingChecks: [{ name: "ci", conclusion: "failure" }],
    },
    mergedBlockerPrNumbers: [],
  };
}

describe("conflicts: the catch-up merges the PR's own base", () => {
  test("a feature member is caught up with its feature branch", async () => {
    const { ctx, recorded } = makeCtx("pushed");
    await conflictsKind(CONFIG).run(
      conflictsUnit({ headRefName: MEMBER_BRANCH, baseRefName: FEATURE_BRANCH }),
      ctx,
    );
    expect(recorded.cleanMerge).toEqual([{ branch: MEMBER_BRANCH, base: FEATURE_BRANCH }]);
  });

  test("an ordinary PR is caught up with the default branch", async () => {
    const { ctx, recorded } = makeCtx("pushed");
    await conflictsKind(CONFIG).run(
      conflictsUnit({ headRefName: MEMBER_BRANCH, baseRefName: asBranchRef("main") }),
      ctx,
    );
    expect(recorded.cleanMerge).toEqual([{ branch: MEMBER_BRANCH, base: "main" }]);
  });

  test("a feature's integration PR is caught up with the default branch", async () => {
    const { ctx, recorded } = makeCtx("pushed");
    await conflictsKind(CONFIG).run(
      conflictsUnit({ headRefName: FEATURE_BRANCH, baseRefName: asBranchRef("main") }),
      ctx,
    );
    expect(recorded.cleanMerge).toEqual([{ branch: FEATURE_BRANCH, base: "main" }]);
  });

  test("a candidate carrying no base falls back to the default branch", async () => {
    const { ctx, recorded } = makeCtx("pushed");
    await conflictsKind(CONFIG).run(conflictsUnit({ headRefName: MEMBER_BRANCH }), ctx);
    expect(recorded.cleanMerge).toEqual([{ branch: MEMBER_BRANCH, base: "main" }]);
  });

  test("the agent pass primes and names the same base", async () => {
    const { ctx, recorded } = makeCtx("conflicted");
    await conflictsKind(CONFIG).run(
      conflictsUnit({ headRefName: MEMBER_BRANCH, baseRefName: FEATURE_BRANCH }),
      ctx,
    );
    expect(recorded.prWorkflow).toHaveLength(1);
    expect(recorded.prWorkflow[0]?.baseBranch).toBe(FEATURE_BRANCH);
    expect(recorded.prWorkflow[0]?.promptArgs.BASE_BRANCH).toBe(FEATURE_BRANCH);
  });
});

describe("checks: the BEHIND catch-up merges the PR's own base", () => {
  test("a feature member is caught up with its feature branch", async () => {
    const { ctx, recorded } = makeCtx("pushed");
    await checksKind(CONFIG).run(
      checksUnit({ headRefName: MEMBER_BRANCH, baseRefName: FEATURE_BRANCH }),
      ctx,
    );
    expect(recorded.cleanMerge).toEqual([{ branch: MEMBER_BRANCH, base: FEATURE_BRANCH }]);
    expect(recorded.prWorkflow).toEqual([]);
  });

  test("an ordinary PR is caught up with the default branch", async () => {
    const { ctx, recorded } = makeCtx("pushed");
    await checksKind(CONFIG).run(
      checksUnit({ headRefName: MEMBER_BRANCH, baseRefName: asBranchRef("main") }),
      ctx,
    );
    expect(recorded.cleanMerge).toEqual([{ branch: MEMBER_BRANCH, base: "main" }]);
  });
});
