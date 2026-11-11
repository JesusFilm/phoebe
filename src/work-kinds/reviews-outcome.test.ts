// What the reviews kind records once its agent has run (#816). The agent ends
// with a summary comment: the success heading for a clean run, the failure
// heading when it got stuck. The handled watermark is posted either way; only a
// failed run carries the visible failure note, so a stuck run that still pushed
// something must not be recorded as clean.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "../branded.ts";
import { REVIEWS_FAILURE_HEADING, resolveConfig } from "../config-schema.ts";
import { issueBranch } from "../orchestrator.ts";
import type { AgentHelpers, WorkKindRunCtx } from "./definition.ts";
import { reviewsKind } from "./reviews.ts";

const CONFIG = resolveConfig({
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  readyCommand: "npm run ready",
});

const PHOEBE = "phoebe-bot";
const RUN_START = new Date("2026-11-11T10:00:00Z");
const AFTER_START = "2026-11-11T10:05:00Z";
const BEFORE = asSha("a".padEnd(40, "0"));
const AFTER = asSha("b".padEnd(40, "0"));

function run(opts: { summaryBodies: string[]; pushedByAgent: boolean }): Promise<string[]> {
  const posted: string[] = [];
  const ctx = {
    kind: "reviews",
    config: CONFIG,
    options: undefined,
    env: {},
    cycle: {
      issueBody: () => null,
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: () => null,
    },
    clock: { now: () => RUN_START, sleep: () => Promise.resolve() },
    log: () => {},
    github: new Proxy({} as WorkKindRunCtx["github"], {
      get(_target, prop) {
        if (prop === "reviewSummaryComments") {
          return () =>
            opts.summaryBodies.map((body) => ({
              body,
              createdAt: AFTER_START,
              authorLogin: PHOEBE,
            }));
        }
        if (prop === "postPrComment") return (_pr: unknown, body: string) => posted.push(body);
        if (typeof prop !== "string" || prop === "then") return undefined;
        throw new Error(`github.${prop} was not expected in this test`);
      },
    }),
    origin: { fetch: () => {}, branchHead: () => BEFORE, commitsBehind: () => 0 },
    workspace: { mode: "worktree" as const, dir: "/tmp/test-worktree" },
    signal: new AbortController().signal,
    agent: {
      run: () => Promise.resolve(),
      issueWorkflow: () => Promise.resolve(),
      cleanMerge: () => "pushed",
      prWorkflow: async (opts2: Parameters<AgentHelpers["prWorkflow"]>[0]) => {
        await opts2.onResult({
          worktreeDir: "/tmp/test-worktree",
          branch: issueBranch(42),
          originShaBefore: BEFORE,
          originShaAfter: opts.pushedByAgent ? AFTER : BEFORE,
          localCommitCount: 0,
          push: () => {},
        });
      },
    },
  } as unknown as WorkKindRunCtx;
  const unit = {
    ref: "pr:7",
    github: { objectType: "pr", id: 7 },
    pr: {
      prNumber: asPrNumber(7),
      headRefName: asBranchRef(issueBranch(42)),
      mergeable: "MERGEABLE",
      threads: [
        {
          isResolved: false,
          isOutdated: false,
          comments: [{ createdAt: "2026-11-11T09:00:00Z", authorLogin: "reviewer" }],
        },
      ],
    },
    phoebeLogin: PHOEBE,
  };
  return reviewsKind(CONFIG)
    .run(unit as never, ctx)
    .then(() => posted);
}

const FAILURE_NOTE = "attempted to handle review feedback and failed";

describe("reviews: the handled watermark tells a stuck run from a clean one", () => {
  test("a success summary records a clean run", async () => {
    const posted = await run({
      summaryBodies: [`${CONFIG.reviewsSuccessHeading}\n\n**Fixed:** 1`],
      pushedByAgent: true,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain(FAILURE_NOTE);
  });

  test("a failure summary records a failed run, even after a push", async () => {
    const posted = await run({
      summaryBodies: [`${REVIEWS_FAILURE_HEADING}\n\nThe gate stayed red.`],
      pushedByAgent: true,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(FAILURE_NOTE);
  });

  test("no summary and no push is still a failed run", async () => {
    const posted = await run({ summaryBodies: [], pushedByAgent: false });
    expect(posted[0]).toContain(FAILURE_NOTE);
  });
});
