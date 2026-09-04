// The engine's cycle, tested end to end: build an engine with `createEngine`,
// hand it a GitHub stub and a git stub, and assert what one `--dry-run` pass
// selects. This is the file the seam work (#279, #280) existed to make
// possible — until it, `main.ts` had no test at all and the real bugs lived in
// how it called the pure selectors, not in the selectors themselves.
//
// Everything runs under `--dry-run`: the loop selects, prints what it would
// execute, and breaks before the worktree, the agent or the push. That is what
// makes selection testable on its own, so nothing here fakes an agent spawn.
//
// Two doubles carry the tests. `stubGitHub` (src/github-stub.ts) throws for
// any method a test did not declare, so a cycle that reaches further than the
// test says fails loudly instead of quietly finding no work. `stubGit` below
// answers the three commands the selection path issues — `fetch origin`,
// `rev-parse origin/<branch>` and the `rev-list --count` behind-check — and
// records every call, so "no worktree, no push" is an assertion rather than a
// hope.

import { describe, expect, onTestFinished, test } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asBranchRef,
  asPrNumber,
  asSha,
  type BranchRef,
  type PrNumber,
  type Sha,
} from "./branded.ts";
import { resolveConfig, type PhoebeUserConfig } from "./config-schema.ts";
import type { GitRunner } from "./git-model.ts";
import { featureBranch, type IssueGraphNode } from "./feature-branch.ts";
import { CLOSES_SECTION_START } from "./feature-closes.ts";
import type { QuarantinedUnit } from "./github-client.ts";
import { stubGitHub, type GitHubStubOverrides } from "./github-stub.ts";
import {
  buildChecksFailWatermarkMarker,
  buildConflictFailWatermarkMarker,
  issueBranch,
  RUN_ONCE_NOTHING_MESSAGE,
  type Issue,
  type ReviewThread,
  type WorkflowRunItem,
} from "./orchestrator.ts";
import {
  buildQuarantineBaselineMarker,
  buildUnitTimeoutMarker,
  buildUnstickComment,
} from "./quarantine.ts";
import { createEngine, type EngineRunOptions } from "./main.ts";
import type { DrainSignal } from "./drain.ts";
import { CredentialRefreshBlockedError, type CredentialClient } from "./credential-client.ts";
import type { SlotClient } from "./slot-client.ts";
import { createEmitUnitEvent, type StatusSnapshot, type UnitRef } from "./unit-event.ts";
import type {
  AnyWorkKindDefinition,
  WorkKindRunCtx,
  WorkspaceMode,
  WorkUnitGitHubTarget,
} from "./work-kinds/definition.ts";
import { buildRegistry, type LoadedCustomKind } from "./work-kinds/registry.ts";

// ---------------------------------------------------------------------------
// The world a cycle runs against
// ---------------------------------------------------------------------------

const PHOEBE_LOGIN = "phoebe-bot";

/** A 40-hex SHA that reads back as its own label in a failure message. */
function sha(label: string): Sha {
  return asSha(label.padEnd(40, "0"));
}

const MAIN_HEAD = sha("aa");
const MAIN_HEAD_MOVED = sha("bb");

function minimalUser(): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    readyCommand: "npm run ready",
  };
}

/** The tag every line this engine writes carries (#418): slug + pipeline row. */
const TAG = "[phoebe:acme/widget:work]";

function anIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Ticket ${number}`,
    body: "",
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * One open PR as the cycle sees it. Branches are built with `issueBranch` so
 * the fixture and the parser agree on the prefix without either naming it.
 */
type PrFixture = {
  number: number;
  issueNumber: number;
  /** Overrides the derived `issueBranch` — how a feature's integration PR is declared. */
  headRefName?: BranchRef;
  /** Overrides the default branch — how a feature member's base is declared. */
  baseRefName?: BranchRef;
  authorLogin?: string | null;
  mergeable?: string;
  mergeStateStatus?: string;
  headSha?: Sha;
  /** Comment bodies, oldest first — where every watermark marker is read from. */
  comments?: string[];
  checkRuns?: WorkflowRunItem[];
  threads?: ReviewThread[];
};

function headOf(pr: PrFixture): Sha {
  return pr.headSha ?? sha(`f${pr.number}`);
}

function branchOf(pr: PrFixture): BranchRef {
  return pr.headRefName ?? issueBranch(pr.issueNumber);
}

function baseOf(pr: PrFixture): BranchRef {
  return pr.baseRefName ?? asBranchRef("main");
}

/**
 * The PR-facing half of the GitHub surface, derived from one list of PRs. The
 * issue-facing half (`listReadyIssues`, `issueBody`, `blockerPrState`) stays
 * with the test, so each test still declares what it depends on.
 */
function prWorld(prs: readonly PrFixture[]): GitHubStubOverrides {
  const byNumber = (prNumber: PrNumber): PrFixture => {
    const pr = prs.find((candidate) => candidate.number === prNumber);
    if (!pr) throw new Error(`prWorld: no PR #${prNumber} was declared`);
    return pr;
  };
  return {
    openPrs: () =>
      prs.map((pr) => ({
        number: asPrNumber(pr.number),
        headRefName: branchOf(pr),
        authorLogin: pr.authorLogin === undefined ? PHOEBE_LOGIN : pr.authorLogin,
      })),
    mergeInfo: (prNumber) => {
      const pr = byNumber(prNumber);
      return Promise.resolve({
        number: asPrNumber(pr.number),
        headRefName: branchOf(pr),
        baseRefName: baseOf(pr),
        headRefOid: headOf(pr),
        mergeable: pr.mergeable ?? "MERGEABLE",
        mergeStateStatus: pr.mergeStateStatus ?? "CLEAN",
      });
    },
    prCommentBodies: (prNumber) => byNumber(prNumber).comments ?? [],
    commitCheckItems: (headSha) => {
      const pr = prs.find((candidate) => headOf(candidate) === headSha);
      if (!pr) throw new Error(`prWorld: no PR was declared with head ${headSha}`);
      return pr.checkRuns ?? [];
    },
    reviewThreads: (prNumber) => byNumber(prNumber).threads ?? [],
    resolveLogin: () => PHOEBE_LOGIN,
  };
}

/** A CI run that has finished red — enough for the checks kind to bite. */
const RED_CI: WorkflowRunItem[] = [
  { workflowName: "CI", status: "completed", conclusion: "failure" },
];

/** An unresolved review thread carrying one comment from a human. */
function humanThread(createdAt: string): ReviewThread {
  return {
    isResolved: false,
    isOutdated: false,
    comments: [{ createdAt, authorLogin: "a-reviewer" }],
  };
}

/** The same, from a reviewer whose account has since been deleted. */
function ghostThread(createdAt: string): ReviewThread {
  return {
    isResolved: false,
    isOutdated: false,
    comments: [{ createdAt, authorLogin: null }],
  };
}

// ---------------------------------------------------------------------------
// Running one cycle
// ---------------------------------------------------------------------------

type CycleResult = {
  /** Everything the cycle printed, in order, across log/warn/error. */
  lines: string[];
  /** Every `git` argv the cycle issued — the "executes nothing" evidence. */
  gitCalls: string[][];
  /** Unit events emitted; a dry cycle must produce none. */
  events: UnitRef[];
};

/**
 * Swap the console for a recorder. The engine reports selection by printing,
 * so the printed lines are the observable behaviour of a dry cycle.
 */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  return {
    lines,
    restore: () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

/**
 * The git side of a cycle: the two commands a selection pass issues, plus a
 * record of every call. Shaped like `stubExec` in src/github-client.test.ts —
 * the double and its recording are one object, so a test can both answer git
 * and assert what git was asked to do.
 */
/** Lock reasons keyed by worktree dir, read out of a porcelain listing. */
function parseLeases(porcelain: string): Map<string, string> {
  const leases = new Map<string, string>();
  let dir: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
    else if (dir !== null && line.startsWith("locked ")) leases.set(dir, line.slice(7));
  }
  return leases;
}

/** The porcelain listing those leases would produce. */
function renderWorktrees(leases: ReadonlyMap<string, string>): string {
  return [...leases]
    .map(([dir, reason]) => `worktree ${dir}\nHEAD ${"2".repeat(40)}\nlocked ${reason}\n`)
    .join("\n");
}

function stubGit(
  shas: Record<string, Sha>,
  behind: Record<string, number> = {},
  dirtyPaths: readonly string[] = [],
  worktreeList = "",
): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const leases = parseLeases(worktreeList);
  const git: GitRunner = (args) => {
    calls.push([...args]);
    if (args[0] === "fetch") return "";
    // `rev-list --count origin/<branch>..origin/<upstream>` — how far a branch
    // has fallen behind. Undeclared branches are current, which is what every
    // test that never mentions a feature wants.
    if (args[0] === "rev-list") {
      const branch = (args[2] ?? "").split("..")[0]?.replace(/^origin\//, "") ?? "";
      return `${behind[branch] ?? 0}\n`;
    }
    // Worktree plumbing answers emptily rather than throwing: an executing
    // cycle (the workspace tests below) reaches it, and a stub that threw here
    // would send `removeWorktree` down its rmSync fallback against a real path.
    // The worktree lease (#418). `lock`/`unlock` mutate what `list` answers,
    // so a cycle that takes a lease and then tears its tree down sees the
    // lease it actually took — a static listing would let a release that never
    // unlocks pass. The rest of the worktree plumbing answers emptily rather
    // than throwing, since an executing cycle reaches it.
    if (args[0] === "worktree") {
      if (args[1] === "list") return renderWorktrees(leases);
      if (args[1] === "lock") leases.set(String(args[4]), String(args[3]));
      if (args[1] === "unlock") leases.delete(String(args[2]));
      return "";
    }
    // `status --porcelain` — what the readonly workspace's boundary check
    // (#397) asks of a tree the engine is about to delete.
    if (args[0] === "status") return dirtyPaths.map((path) => ` M ${path}`).join("\n");
    if (args[0] === "rev-parse") {
      const ref = (args[1] ?? "").replace(/^origin\//, "");
      const found = shas[ref];
      if (!found) throw new Error(`stubGit: no sha declared for \`git ${args.join(" ")}\``);
      return `${found}\n`;
    }
    throw new Error(`stubGit: unexpected \`git ${args.join(" ")}\``);
  };
  return { git, calls };
}

async function runCycle(opts: {
  github: GitHubStubOverrides;
  /** This engine's config — the whole point of #280 is that it is an argument. */
  config?: Partial<PhoebeUserConfig>;
  /** What `git rev-parse origin/<ref>` answers, keyed by ref. */
  shas?: Record<string, Sha>;
  env?: NodeJS.ProcessEnv;
  run?: Partial<EngineRunOptions>;
  /** Custom kinds to register beside the built-ins (#303). */
  customKinds?: LoadedCustomKind[];
  /** Drive an executing cycle (with `run.dryRun: false`) rather than a dry one. */
  inContainer?: boolean;
  /** How many commits the default branch is ahead of each branch, keyed by branch. */
  behind?: Record<string, number>;
  /** Root for this engine's derived tenant paths — a tmpdir when a test lets one be written. */
  dataBase?: string;
  /** Paths `git status --porcelain` reports as changed in any worktree. */
  dirtyPaths?: readonly string[];
  /** What `git worktree list --porcelain` answers — the worktree leases (#418). */
  worktreeList?: string;
  /** Which pipeline row this engine is (#418); defaults to the reserved `work`. */
  pipeline?: string;
}): Promise<CycleResult> {
  const { git, calls: gitCalls } = stubGit(
    opts.shas ?? {},
    opts.behind ?? {},
    opts.dirtyPaths ?? [],
    opts.worktreeList ?? "",
  );
  const events: UnitRef[] = [];
  const config = resolveConfig(
    { ...minimalUser(), ...opts.config },
    opts.dataBase !== undefined ? { dataBase: opts.dataBase } : {},
  );
  const engine = createEngine({
    config,
    ...(opts.pipeline !== undefined ? { pipeline: opts.pipeline } : {}),
    registry: buildRegistry(config, opts.customKinds ?? []),
    env: opts.env ?? {},
    ...(opts.inContainer !== undefined ? { inContainer: opts.inContainer } : {}),
    github: stubGitHub(opts.github),
    git,
    clock: { sleep: () => Promise.resolve(), now: () => new Date("2026-08-19T00:00:00Z") },
    drain: {
      requested: false,
      // A dry cycle breaks out of the loop rather than polling. Throwing keeps
      // a regression that reaches here a failed test instead of a hung suite.
      wait: () => Promise.reject(new Error("drain.wait: a dry cycle must not poll")),
      dispose: () => {},
    },
    slotClient: null,
    credentialClient: null,
    emitUnitEvent: (event) => {
      events.push(event.unit);
    },
    run: { runOnce: false, dryRun: true, pollIntervalMs: 1_000, ...opts.run },
  });

  const captured = captureConsole();
  try {
    await engine.runLoop();
  } finally {
    captured.restore();
  }
  return { lines: captured.lines, gitCalls, events };
}

/** The one line a dry cycle prints for the unit it picked, or undefined. */
function selection(result: CycleResult): string | undefined {
  return result.lines.find((line) => line.startsWith("[phoebe:acme/widget:work] Would execute:"));
}

// ---------------------------------------------------------------------------

// The stub holds no state and needs no suite of its own, but every test below
// leans on this one property — an undeclared call must fail rather than answer
// emptily — so it is pinned here, once.
describe("the stub's declared surface", () => {
  test("a method the test did not stub throws, naming itself", async () => {
    // The `issues` kind reaches `listReadyIssues`; nothing here supplies it.
    await expect(runCycle({ github: {}, config: { workOrder: ["issues"] } })).rejects.toThrow(
      /listReadyIssues\(\) was called, but this test did not stub it/,
    );
  });
});

describe("selecting one unit, per work kind", () => {
  test("issues: the workable ready ticket wins the cycle", async () => {
    const result = await runCycle({
      config: { workOrder: ["issues"] },
      github: { listReadyIssues: () => [anIssue(7)] },
    });

    expect(selection(result)).toBe(
      "[phoebe:acme/widget:work] Would execute: issue #7 — base origin/main.",
    );
  });

  test("research: the workable research ticket wins the cycle", async () => {
    const result = await runCycle({
      config: { workOrder: ["research"] },
      github: { listResearchIssues: () => [anIssue(9)] },
    });

    expect(selection(result)).toBe(
      "[phoebe:acme/widget:work] Would execute: research ticket #9 — base origin/main.",
    );
  });

  test("conflicts: the conflicting PR wins the cycle", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts"] },
      shas: { main: MAIN_HEAD },
      github: {
        ...prWorld([{ number: 21, issueNumber: 7, mergeable: "CONFLICTING" }]),
        issueBody: () => "",
      },
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: conflict fix for PR #21 (${issueBranch(7)}).`,
    );
  });

  test("checks: the red-CI PR wins the cycle", async () => {
    const result = await runCycle({
      config: { workOrder: ["checks"] },
      github: {
        ...prWorld([{ number: 22, issueNumber: 8, checkRuns: RED_CI }]),
        issueBody: () => "",
      },
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: checks fix for PR #22 (${issueBranch(8)}).`,
    );
  });

  test("reviews: the PR with unhandled human feedback wins the cycle", async () => {
    const result = await runCycle({
      config: { workOrder: ["reviews"] },
      github: {
        ...prWorld([
          { number: 23, issueNumber: 9, threads: [humanThread("2026-08-01T00:00:00Z")] },
        ]),
        issueBody: () => "",
      },
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: review feedback for PR #23 (${issueBranch(9)}).`,
    );
  });
});

describe("processingLabel skips", () => {
  test("issues: a ticket carrying processingLabel is invisible to selection", async () => {
    const result = await runCycle({
      config: { workOrder: ["issues"] },
      github: {
        listReadyIssues: () => [
          anIssue(7, { labels: ["ready-for-agent", "processing"] }),
          anIssue(8),
        ],
      },
    });

    expect(selection(result)).toBe(
      "[phoebe:acme/widget:work] Would execute: issue #8 — base origin/main.",
    );
  });

  test("research: a ticket carrying processingLabel is invisible to selection", async () => {
    const result = await runCycle({
      config: { workOrder: ["research"] },
      github: {
        listResearchIssues: () => [
          anIssue(9, { labels: ["wayfinder:research", "processing"] }),
          anIssue(10, { labels: ["wayfinder:research"] }),
        ],
      },
    });

    expect(selection(result)).toBe(
      "[phoebe:acme/widget:work] Would execute: research ticket #10 — base origin/main.",
    );
  });

  test("all processing: nothing selected, idle report shown", async () => {
    const result = await runCycle({
      config: { workOrder: ["issues"] },
      github: {
        listReadyIssues: () => [anIssue(7, { labels: ["ready-for-agent", "processing"] })],
      },
    });

    expect(selection(result)).toBeUndefined();
  });
});

// A deleted account has no login. Nothing else in the cycle has no login either
// — Phoebe's own is always resolved before it is compared against — so `null` is
// nobody, and the selectors must read it that way rather than as "the same
// author as whoever else is missing one".
describe("comments with no author", () => {
  test("reviews: a ghost reviewer's comment is feedback, not the PR author's own", async () => {
    const result = await runCycle({
      config: { workOrder: ["reviews"] },
      github: {
        ...prWorld([
          {
            number: 23,
            issueNumber: 9,
            authorLogin: null,
            threads: [ghostThread("2026-08-01T00:00:00Z")],
          },
        ]),
        issueBody: () => "",
      },
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: review feedback for PR #23 (${issueBranch(9)}).`,
    );
  });

  test("reviews: the PR author's own comment is still not feedback", async () => {
    const result = await runCycle({
      config: { workOrder: ["reviews"] },
      github: {
        ...prWorld([
          {
            number: 23,
            issueNumber: 9,
            authorLogin: "a-contributor",
            threads: [
              {
                isResolved: false,
                isOutdated: false,
                comments: [{ createdAt: "2026-08-01T00:00:00Z", authorLogin: "a-contributor" }],
              },
            ],
          },
        ]),
        issueBody: () => "",
      },
    });

    expect(selection(result)).toBeUndefined();
  });
});

describe("work order", () => {
  /** One world with work waiting in three kinds at once. */
  function contestedWorld(): GitHubStubOverrides {
    return {
      ...prWorld([
        { number: 21, issueNumber: 7, mergeable: "CONFLICTING" },
        { number: 22, issueNumber: 8, checkRuns: RED_CI },
      ]),
      issueBody: () => "",
      listReadyIssues: () => [anIssue(30)],
      listResearchIssues: () => [],
    };
  }

  test("the first kind in workOrder with a workable unit wins", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts", "checks", "reviews", "issues", "research"] },
      shas: { main: MAIN_HEAD },
      github: contestedWorld(),
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: conflict fix for PR #21 (${issueBranch(7)}).`,
    );
  });

  test("a reordered workOrder picks a different kind from the same world", async () => {
    const result = await runCycle({
      config: { workOrder: ["issues", "research", "conflicts", "checks", "reviews"] },
      shas: { main: MAIN_HEAD },
      github: contestedWorld(),
    });

    expect(selection(result)).toBe(
      "[phoebe:acme/widget:work] Would execute: issue #30 — base origin/main.",
    );
  });

  test("the idle report names the labels this engine was configured with", async () => {
    const result = await runCycle({
      config: { workOrder: ["issues"], readyLabel: "needs-robot" },
      github: {
        listReadyIssues: () => [anIssue(7, { body: "Blocked by #10" })],
        blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false, blockerCompleted: false }),
      },
    });

    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 needs-robot issue(s) but none workable this cycle (waiting on blockers #10).",
    );
  });
});

// The idle report is rendered from the record `selectFirstWorkUnit` returns, so
// there is one answer to "what is workable this cycle?" rather than two. These
// tests still assert twice — `selection()` for the pick, the reported line for
// the explanation — because the two are different observations of that one
// answer. The checks message names three causes at once, so the pair of tests
// below — one skipped, one workable off the same fixture — is what says *which*
// cause bit.
describe("watermark skips", () => {
  const conflictedPr: PrFixture = {
    number: 21,
    issueNumber: 7,
    mergeable: "CONFLICTING",
    headSha: sha("c1"),
    comments: [buildConflictFailWatermarkMarker({ prHead: sha("c1"), mainHead: MAIN_HEAD })],
  };

  test("conflicts: an unchanged watermark skips the PR and says so", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts"] },
      shas: { main: MAIN_HEAD },
      github: { ...prWorld([conflictedPr]), issueBody: () => "" },
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 conflicting PR(s) skipped (unchanged failure watermark).",
    );
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 conflicting PR(s) but none fixable this cycle.",
    );
  });

  test("conflicts: the same PR is workable once git says main has moved", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts"] },
      shas: { main: MAIN_HEAD_MOVED },
      github: { ...prWorld([conflictedPr]), issueBody: () => "" },
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: conflict fix for PR #21 (${issueBranch(7)}).`,
    );
  });

  test("checks: a watermark at the current head skips the PR", async () => {
    const result = await runCycle({
      config: { workOrder: ["checks"] },
      github: {
        ...prWorld([
          {
            number: 22,
            issueNumber: 8,
            headSha: sha("d1"),
            checkRuns: RED_CI,
            comments: [buildChecksFailWatermarkMarker({ prHead: sha("d1") })],
          },
        ]),
        issueBody: () => "",
      },
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 failing-CI PR(s) skipped (conflicting, stacked, or watermarked).",
    );
  });

  test("checks: a watermark from an earlier head leaves the PR workable", async () => {
    const result = await runCycle({
      config: { workOrder: ["checks"] },
      github: {
        ...prWorld([
          {
            number: 22,
            issueNumber: 8,
            headSha: sha("d2"),
            checkRuns: RED_CI,
            comments: [buildChecksFailWatermarkMarker({ prHead: sha("d1") })],
          },
        ]),
        issueBody: () => "",
      },
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: checks fix for PR #22 (${issueBranch(8)}).`,
    );
  });
});

describe("stacked-blocker skips", () => {
  test("issues: a ticket whose blocker has no PR yet is left alone", async () => {
    const result = await runCycle({
      config: { workOrder: ["issues"] },
      github: {
        listReadyIssues: () => [anIssue(7, { body: "Blocked by #10" })],
        blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false, blockerCompleted: false }),
      },
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines.join("\n")).toContain("waiting on blockers #10");
  });

  test("conflicts: a PR stacked on an open blocker PR is skipped", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts"] },
      shas: { main: MAIN_HEAD },
      github: {
        ...prWorld([{ number: 21, issueNumber: 7, mergeable: "CONFLICTING" }]),
        issueBody: () => "Blocked by #10",
        blockerPrState: () => ({
          hasOpenPr: true,
          openPrNumber: asPrNumber(20),
          hasMergedPr: false,
        }),
      },
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 conflicting PR(s) skipped (stacked on open blocker).",
    );
  });
});

// One cycle's issue bodies are gathered per work kind and merged into a single
// map, and the stack selectors read that map to tell a real conflict from an
// expected divergence. `conflicts` *assigned* the map where `checks` and
// `reviews` merged into it, so any workOrder fetching conflicts second threw
// away every body gathered before it — and a body the selectors cannot find
// reads as "not stacked" (orchestrator.ts:609 coerces a miss to ""). The
// default order hides it: conflicts fetches first, into a map that is empty
// anyway.
describe("issue bodies survive every work order", () => {
  /**
   * Two PRs, both stacked on the same blocker and neither workable for it: #21
   * conflicts, #22 fails CI. Fetching conflicts last must not cost #22 the body
   * that makes it stacked.
   */
  function stackedWorld(): GitHubStubOverrides {
    return {
      ...prWorld([
        { number: 21, issueNumber: 7, mergeable: "CONFLICTING" },
        { number: 22, issueNumber: 8, headSha: sha("d1"), checkRuns: RED_CI },
      ]),
      issueBody: () => "Blocked by #10",
      blockerPrState: () => ({
        hasOpenPr: true,
        openPrNumber: asPrNumber(20),
        hasMergedPr: false,
      }),
    };
  }

  test("checks before conflicts: the checks PR is still seen as stacked", async () => {
    const result = await runCycle({
      config: { workOrder: ["checks", "conflicts"] },
      shas: { main: MAIN_HEAD },
      github: stackedWorld(),
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 failing-CI PR(s) skipped (conflicting, stacked, or watermarked).",
    );
  });

  test("conflicts before checks: the same world reaches the same verdict", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts", "checks"] },
      shas: { main: MAIN_HEAD },
      github: stackedWorld(),
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 conflicting PR(s) skipped (stacked on open blocker).",
    );
  });
});

// The idle report walks this engine's `workOrder`, not an order of its own. The
// two used to be separate walks and could name different kinds — the report
// reaching a kind the loop would never have got to, or stopping before the kind
// it actually chose (docs/research/engine-runtime-seam.md, ticket D).
describe("the idle report follows workOrder", () => {
  /**
   * Two kinds with work waiting and neither workable, for opposite reasons: the
   * conflicting PR is stacked on a blocker that has an open PR, and the ready
   * ticket waits on a blocker nobody has started.
   */
  function blockedWorld(): GitHubStubOverrides {
    return {
      ...prWorld([{ number: 21, issueNumber: 7, mergeable: "CONFLICTING" }]),
      issueBody: () => "Blocked by #10",
      listReadyIssues: () => [anIssue(30, { body: "Blocked by #11" })],
      blockerPrState: (blocker) =>
        blocker === 10
          ? { hasOpenPr: true, openPrNumber: asPrNumber(20), hasMergedPr: false }
          : { hasOpenPr: false, hasMergedPr: false, blockerCompleted: false },
    };
  }

  test("conflicts first: the conflicts skip is what the operator is told", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts", "issues"] },
      shas: { main: MAIN_HEAD },
      github: blockedWorld(),
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 conflicting PR(s) skipped (stacked on open blocker).",
    );
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 conflicting PR(s) but none fixable this cycle.",
    );
    expect(result.lines.join("\n")).not.toContain("issue(s) but none workable");
  });

  test("issues first: the same world reports the issues skip instead", async () => {
    const result = await runCycle({
      config: { workOrder: ["issues", "conflicts"] },
      shas: { main: MAIN_HEAD },
      github: blockedWorld(),
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 ready-for-agent issue(s) but none workable this cycle (waiting on blockers #11).",
    );
    expect(result.lines.join("\n")).not.toContain("conflicting PR(s)");
  });

  test("a kind left out of workOrder is never reported on", async () => {
    const result = await runCycle({
      config: { workOrder: ["issues"] },
      github: {
        listReadyIssues: () => [],
        // `conflicts` is absent from workOrder, so nothing may reach the PR
        // surface at all — every method here is unstubbed and would throw.
      },
    });

    expect(result.lines).toContain("[phoebe:acme/widget:work] No work this cycle — idle.");
  });
});

describe("an empty cycle", () => {
  test("nothing is selected and the idle report is rendered", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts", "checks", "reviews", "issues", "research"] },
      shas: { main: MAIN_HEAD },
      github: {
        ...prWorld([]),
        listReadyIssues: () => [],
        listResearchIssues: () => [],
      },
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines).toContain("[phoebe:acme/widget:work] No work this cycle — idle.");
    expect(result.events).toEqual([]);
  });
});

// The un-stick sweep is the one part of a cycle a dry run must not reach, so
// these run wet: `--run-once` with no work waiting, which sweeps, finds nothing
// to do, and exits before any execution gate. The two callers of the sweep — a
// live tenant and a disabled one — differ only in which units they clear and
// what they say, so both are pinned here.
describe("the un-stick sweep", () => {
  /** A wet `--run-once` cycle: it sweeps, finds no work, and exits. */
  function sweepCycle(github: GitHubStubOverrides, config?: Partial<PhoebeUserConfig>) {
    return runCycle({
      // A PAT arm, so the cycle does not try to mint an App token on its way in.
      env: { GH_TOKEN: "a-token" },
      config: { workOrder: ["issues"], ...config },
      github: { listReadyIssues: () => [], ...github },
      run: { runOnce: true, dryRun: false },
    });
  }

  /** One quarantined unit, with the escalation comment that recorded `baseline`. */
  function quarantined(id: number, baseline: string, currentBaseline: string): QuarantinedUnit {
    return {
      target: { objectType: "issue", id },
      currentBaseline,
      comments: [{ body: buildQuarantineBaselineMarker(baseline) }],
    };
  }

  /** Records the writes the sweep makes; anything it does not stub still throws. */
  function writeRecorder(): { writes: string[]; overrides: GitHubStubOverrides } {
    const writes: string[] = [];
    return {
      writes,
      overrides: {
        removeQuarantineLabel: (target) => {
          writes.push(`remove-label ${target.objectType} #${target.id}`);
        },
        postUnitComment: (target, body) => {
          writes.push(`comment ${target.objectType} #${target.id} ${body.split("\n")[0]}`);
        },
      },
    };
  }

  test("a unit whose content advanced loses the label and is told why", async () => {
    const { writes, overrides } = writeRecorder();
    const result = await sweepCycle({
      ...overrides,
      listQuarantinedIssues: () => [quarantined(7, "body:old", "body:new")],
      listQuarantinedPrs: () => [],
    });

    expect(writes).toEqual([
      "remove-label issue #7",
      `comment issue #7 ${buildUnstickComment().split("\n")[0]}`,
    ]);
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] Un-quarantined issue #7 — its content advanced past the quarantine baseline.",
    );
  });

  test("a unit whose content has not moved keeps its label", async () => {
    // Every write method is unstubbed, so touching this unit at all would throw.
    const result = await sweepCycle({
      listQuarantinedIssues: () => [quarantined(7, "body:same", "body:same")],
      listQuarantinedPrs: () => [],
    });

    expect(result.lines).toContain(`${TAG} ${RUN_ONCE_NOTHING_MESSAGE}`);
  });

  test("a disabled tenant clears the same unit the live sweep would leave", async () => {
    const { writes, overrides } = writeRecorder();
    const result = await sweepCycle(
      {
        ...overrides,
        listQuarantinedIssues: () => [quarantined(7, "body:same", "body:same")],
        listQuarantinedPrs: () => [],
      },
      { disabled: true },
    );

    expect(writes).toEqual([
      "remove-label issue #7",
      `comment issue #7 ${buildUnstickComment().split("\n")[0]}`,
    ]);
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] Un-quarantined issue #7 — tenant is disabled; cleared so it starts fresh when re-enabled.",
    );
  });

  test("a failed listing is reported and the cycle carries on", async () => {
    const result = await sweepCycle({
      listQuarantinedIssues: () => {
        throw new Error("gh exploded");
      },
      listQuarantinedPrs: () => [],
    });

    expect(result.lines.join("\n")).toContain("gh exploded");
    expect(result.lines).toContain(`${TAG} ${RUN_ONCE_NOTHING_MESSAGE}`);
  });
});

describe("the stale-stack sweep", () => {
  /** An issue belonging to no feature — what the sweep reads to place a PR. */
  function unaffiliated(issueNumber: number): IssueGraphNode {
    return {
      number: issueNumber,
      title: `Ticket ${issueNumber}`,
      labels: [],
      body: "",
      closed: false,
      parentNumber: null,
    };
  }

  /** A wet `--run-once` cycle: it sweeps, finds no work, and exits. */
  function sweepCycle(github: GitHubStubOverrides) {
    return runCycle({
      env: { GH_TOKEN: "a-token" },
      config: { workOrder: ["issues"] },
      github: {
        listReadyIssues: () => [],
        issueGraphNode: unaffiliated,
        ...github,
      },
      run: { runOnce: true, dryRun: false },
    });
  }

  test("a natively stacked PR whose blocker completed is unstacked and retargeted", async () => {
    const writes: string[] = [];
    const result = await sweepCycle({
      listNativelyStackedPrs: () => [
        {
          number: asPrNumber(22),
          headRefName: issueBranch(8),
          baseRefName: issueBranch(5),
        },
      ],
      blockerPrState: (n) =>
        n === 5
          ? { hasOpenPr: false, hasMergedPr: false, blockerCompleted: true }
          : { hasOpenPr: false, hasMergedPr: false, blockerCompleted: false },
      unstackPr: (prNumber) => {
        writes.push(`unstack ${prNumber}`);
        return { unstacked: true, stackNumber: 3 };
      },
      retargetPr: (prNumber, base) => {
        writes.push(`retarget ${prNumber} ${base}`);
      },
    });

    expect(writes).toEqual(["unstack 22", "retarget 22 main"]);
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] PR #22 removed from stack #3 — blocker #5 completed without merging its PR.",
    );
    expect(result.lines).toContain("[phoebe:acme/widget:work] PR #22 retargeted onto main.");
  });

  test("a member's PR goes back onto its feature branch, not the default branch", async () => {
    const writes: string[] = [];
    const result = await sweepCycle({
      listNativelyStackedPrs: () => [
        {
          number: asPrNumber(22),
          headRefName: issueBranch(8),
          baseRefName: issueBranch(5),
        },
      ],
      issueGraphNode: (n) =>
        n === 8
          ? { ...unaffiliated(8), parentNumber: 1 }
          : n === 1
            ? { ...unaffiliated(1), labels: ["phoebe:feature"] }
            : unaffiliated(n),
      featureIntegrationPr: () => ({ number: asPrNumber(50), state: "OPEN" }),
      blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false, blockerCompleted: true }),
      unstackPr: () => ({ unstacked: true, stackNumber: 3 }),
      retargetPr: (prNumber, base) => {
        writes.push(`retarget ${prNumber} ${base}`);
      },
    });

    expect(writes).toEqual([`retarget 22 ${featureBranch(1)}`]);
    expect(result.lines).toContain(
      `[phoebe:acme/widget:work] PR #22 retargeted onto ${featureBranch(1)}.`,
    );
  });

  test("an unreadable feature graph leaves the PR's base unchanged", async () => {
    const writes: string[] = [];
    const result = await sweepCycle({
      listNativelyStackedPrs: () => [
        {
          number: asPrNumber(22),
          headRefName: issueBranch(8),
          baseRefName: issueBranch(5),
        },
      ],
      issueGraphNode: (n) => {
        if (n === 8) throw new Error("gh exploded");
        return unaffiliated(n);
      },
      blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false, blockerCompleted: true }),
      unstackPr: () => ({ unstacked: true, stackNumber: 3 }),
      retargetPr: (prNumber, base) => {
        writes.push(`retarget ${prNumber} ${base}`);
      },
    });

    expect(writes).toEqual([]);
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] Could not determine feature membership for PR #22 — " +
        "leaving its base unchanged until the next sweep.",
    );
  });

  test("a stacked PR whose blocker still has an open PR is left alone", async () => {
    // unstackPr and retargetPr not stubbed — any call would throw.
    await sweepCycle({
      listNativelyStackedPrs: () => [
        {
          number: asPrNumber(22),
          headRefName: issueBranch(8),
          baseRefName: issueBranch(5),
        },
      ],
      blockerPrState: () => ({
        hasOpenPr: true,
        openPrNumber: asPrNumber(21),
        hasMergedPr: false,
      }),
    });
  });

  test("a stacked PR whose blocker completed but is not in a stack is still retargeted", async () => {
    const writes: string[] = [];
    const result = await sweepCycle({
      listNativelyStackedPrs: () => [
        {
          number: asPrNumber(22),
          headRefName: issueBranch(8),
          baseRefName: issueBranch(5),
        },
      ],
      blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false, blockerCompleted: true }),
      unstackPr: () => ({ unstacked: false, reason: "not-in-stack" }),
      retargetPr: (prNumber, base) => {
        writes.push(`retarget ${prNumber} ${base}`);
      },
    });

    expect(writes).toEqual(["retarget 22 main"]);
    expect(result.lines).toContain("[phoebe:acme/widget:work] PR #22 retargeted onto main.");
  });

  test("dissolving one stack retargets all members whose blocker completed in the same sweep", async () => {
    // Two PRs in the same stack: PR #23 (deeper, base = issue-8) and PR #22
    // (above it, base = issue-5). Both blockers completed. The stack is dissolved
    // when PR #22 is processed first; PR #23 comes back not-in-stack and must
    // still be retargeted.
    const writes: string[] = [];
    await sweepCycle({
      listNativelyStackedPrs: () => [
        {
          number: asPrNumber(22),
          headRefName: issueBranch(8),
          baseRefName: issueBranch(5),
        },
        {
          number: asPrNumber(23),
          headRefName: issueBranch(9),
          baseRefName: issueBranch(8),
        },
      ],
      blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false, blockerCompleted: true }),
      unstackPr: (prNumber) => {
        if (prNumber === 22) {
          writes.push(`unstack ${prNumber}`);
          return { unstacked: true, stackNumber: 3 };
        }
        // Stack already dissolved when PR #23 is processed.
        return { unstacked: false, reason: "not-in-stack" };
      },
      retargetPr: (prNumber, base) => {
        writes.push(`retarget ${prNumber} ${base}`);
      },
    });

    expect(writes).toEqual(["unstack 22", "retarget 22 main", "retarget 23 main"]);
  });

  test("a failed listing is reported and the cycle carries on", async () => {
    const result = await sweepCycle({
      listNativelyStackedPrs: () => {
        throw new Error("stacks API exploded");
      },
    });

    expect(result.lines.join("\n")).toContain("stacks API exploded");
    expect(result.lines).toContain(`${TAG} ${RUN_ONCE_NOTHING_MESSAGE}`);
  });
});

// A feature branch is long-lived by construction, so `main` moves under it and
// nothing about GitHub's mergeability read says so until the drift has already
// become a conflict pile. `conflicts` therefore selects the integration PR on
// distance from the default branch, and `reviews` stands off it entirely (#382).
describe("keeping the feature branch current with the default branch", () => {
  /** The integration PR for feature #341, as the janitors' listing returns it. */
  const integrationPr: PrFixture = {
    number: 99,
    issueNumber: 341,
    headRefName: featureBranch(341),
    headSha: sha("e1"),
  };

  test("a default branch that has moved ahead makes the integration PR the unit", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts"] },
      shas: { main: MAIN_HEAD },
      behind: { [featureBranch(341)]: 3 },
      github: prWorld([integrationPr]),
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: feature-branch catch-up for PR #99 (${featureBranch(341)}).`,
    );
  });

  test("a branch already level with the default branch is not a unit at all", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts"] },
      shas: { main: MAIN_HEAD },
      github: prWorld([integrationPr]),
    });

    expect(selection(result)).toBeUndefined();
    // Zero candidates, so the kind reports nothing rather than reporting a skip:
    // a caught-up feature is not news.
    expect(result.lines.join("\n")).not.toContain("conflicting PR(s)");
  });

  test("`featureBranchCatchUp: false` leaves the branch untouched", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts"], featureBranchCatchUp: false },
      shas: { main: MAIN_HEAD },
      behind: { [featureBranch(341)]: 3 },
      github: prWorld([integrationPr]),
    });

    expect(selection(result)).toBeUndefined();
    // The knob is read before git is: a tenant that switched the catch-up off
    // does not pay for the distance question either.
    expect(result.gitCalls.map((args) => args[0])).not.toContain("rev-list");
  });

  test("a failed catch-up watermarks rather than looping", async () => {
    const world = {
      ...integrationPr,
      comments: [buildConflictFailWatermarkMarker({ prHead: sha("e1"), mainHead: MAIN_HEAD })],
    };
    const skipped = await runCycle({
      config: { workOrder: ["conflicts"] },
      shas: { main: MAIN_HEAD },
      behind: { [featureBranch(341)]: 3 },
      github: prWorld([world]),
    });

    expect(selection(skipped)).toBeUndefined();
    expect(skipped.lines).toContain(
      "[phoebe:acme/widget:work] 1 conflicting PR(s) skipped (unchanged failure watermark).",
    );

    // The same branch is workable again the moment the default branch moves.
    const retried = await runCycle({
      config: { workOrder: ["conflicts"] },
      shas: { main: MAIN_HEAD_MOVED },
      behind: { [featureBranch(341)]: 3 },
      github: prWorld([world]),
    });

    expect(selection(retried)).toBe(
      `[phoebe:acme/widget:work] Would execute: feature-branch catch-up for PR #99 (${featureBranch(341)}).`,
    );
  });

  test("the integration PR is never a reviews unit", async () => {
    const result = await runCycle({
      config: { workOrder: ["reviews"] },
      github: prWorld([{ ...integrationPr, threads: [humanThread("2026-08-18T00:00:00Z")] }]),
    });

    expect(selection(result)).toBeUndefined();
    // Not "skipped" either: reviewing the human's review of the feature is not
    // work Phoebe declines this cycle, it is work that is never hers.
    expect(result.lines.join("\n")).not.toContain("review-feedback PR(s)");
  });

  test("`checks` still works the integration PR", async () => {
    const result = await runCycle({
      config: { workOrder: ["checks"] },
      github: prWorld([{ ...integrationPr, checkRuns: RED_CI }]),
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: checks fix for PR #99 (${featureBranch(341)}).`,
    );
  });
});

// The feature-closes sweep runs wet, before selection, and keeps each live
// feature's integration PR body listing one `Closes #N` per member PR that has
// merged into the feature branch — the only way merging that PR into the
// default branch closes the whole set (#380).
describe("the feature-closes sweep", () => {
  /** A wet `--run-once` cycle: it sweeps, finds no work, and exits. */
  function sweepCycle(github: GitHubStubOverrides) {
    return runCycle({
      env: { GH_TOKEN: "a-token" },
      config: { workOrder: ["issues"] },
      github: { listReadyIssues: () => [], ...github },
      run: { runOnce: true, dryRun: false },
    });
  }

  /** One live feature: integration PR #99 on the branch for feature #341. */
  function featureWorld(opts: {
    body: string;
    mergedMembers: readonly number[];
    bodies: string[];
  }): GitHubStubOverrides {
    return {
      listFeatureIntegrationPrs: () => [
        { number: asPrNumber(99), featureIssueNumber: 341, body: opts.body, labels: [] },
      ],
      listMergedMemberPrs: (featureIssueNumber) =>
        featureIssueNumber === 341
          ? opts.mergedMembers.map((issueNumber) => ({
              number: asPrNumber(400 + issueNumber),
              headRefName: issueBranch(issueNumber),
            }))
          : [],
      updatePrBody: (prNumber, body) => {
        expect(prNumber).toBe(99);
        opts.bodies.push(body);
      },
    };
  }

  test("a merged member PR earns a Closes line on the integration PR", async () => {
    const bodies: string[] = [];
    const result = await sweepCycle(
      featureWorld({ body: "Part of #341.", mergedMembers: [381], bodies }),
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(CLOSES_SECTION_START);
    expect(bodies[0]).toContain("Closes #381");
    expect(bodies[0]).toContain("Part of #341.");
    expect(result.lines).toContain(
      `[phoebe:acme/widget:work] Integration PR #99 now closes #381 — merged into ${featureBranch(341)}.`,
    );
  });

  test("a second cycle over the same merged member writes nothing", async () => {
    const bodies: string[] = [];
    await sweepCycle(featureWorld({ body: "Part of #341.", mergedMembers: [381], bodies }));
    await sweepCycle(featureWorld({ body: bodies[0]!, mergedMembers: [381], bodies }));

    expect(bodies).toHaveLength(1);
  });

  test("a feature whose members have not merged is left alone", async () => {
    // updatePrBody is stubbed to fail the test if it is reached.
    await sweepCycle({
      listFeatureIntegrationPrs: () => [
        { number: asPrNumber(99), featureIssueNumber: 341, body: "Part of #341.", labels: [] },
      ],
      listMergedMemberPrs: () => [],
    });
  });

  test("a merged PR Phoebe did not branch earns no line", async () => {
    await sweepCycle({
      listFeatureIntegrationPrs: () => [
        { number: asPrNumber(99), featureIssueNumber: 341, body: "Part of #341.", labels: [] },
      ],
      listMergedMemberPrs: () => [
        { number: asPrNumber(22), headRefName: asBranchRef("contributor/typo-fix") },
      ],
    });
  });

  test("one feature's failed read does not stop the next feature", async () => {
    const bodies: string[] = [];
    const result = await sweepCycle({
      listFeatureIntegrationPrs: () => [
        { number: asPrNumber(98), featureIssueNumber: 7, body: "", labels: [] },
        { number: asPrNumber(99), featureIssueNumber: 341, body: "Part of #341.", labels: [] },
      ],
      listMergedMemberPrs: (featureIssueNumber) => {
        if (featureIssueNumber === 7) throw new Error("gh exploded");
        return [{ number: asPrNumber(22), headRefName: issueBranch(381) }];
      },
      updatePrBody: (prNumber, body) => {
        bodies.push(`${prNumber}:${body}`);
      },
    });

    expect(result.lines.join("\n")).toContain("gh exploded");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("99:");
  });

  test("a failed listing is reported and the cycle carries on", async () => {
    const result = await sweepCycle({
      listFeatureIntegrationPrs: () => {
        throw new Error("pr list exploded");
      },
    });

    expect(result.lines.join("\n")).toContain("pr list exploded");
    expect(result.lines).toContain(`${TAG} ${RUN_ONCE_NOTHING_MESSAGE}`);
  });
});

describe("--dry-run", () => {
  test("prints the selection and executes nothing", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts", "checks", "reviews", "issues", "research"] },
      shas: { main: MAIN_HEAD },
      github: {
        ...prWorld([{ number: 21, issueNumber: 7, mergeable: "CONFLICTING" }]),
        issueBody: () => "",
        listReadyIssues: () => [anIssue(30)],
        listResearchIssues: () => [],
      },
    });

    expect(selection(result)).toBe(
      `[phoebe:acme/widget:work] Would execute: conflict fix for PR #21 (${issueBranch(7)}).`,
    );
    // No worktree, no push: discovery reads origin and nothing else. Every
    // GitHub write is unstubbed, so one attempted comment would have thrown.
    expect(result.gitCalls.map((args) => args[0])).toEqual(["fetch", "rev-parse"]);
    // Nothing was started, so nothing was observed as started.
    expect(result.events).toEqual([]);
  });
});

// The stranded-unit sweep runs wet, before selection, and re-arms any issue
// that carries processingLabel but has no open or merged Phoebe PR — issues
// whose run ended without producing one (crash, kill, timeout). Like the
// un-stick and stale-stack sweeps, the other two sweeps are allowed to fail
// silently when their methods go unstubbed.
describe("the stranded-unit sweep", () => {
  /** A wet `--run-once` cycle: sweeps, finds no work to select, then exits. */
  function sweepCycle(github: GitHubStubOverrides, config?: Partial<PhoebeUserConfig>) {
    return runCycle({
      env: { GH_TOKEN: "a-token" },
      config: { workOrder: ["issues"], ...config },
      github: { listReadyIssues: () => [], ...github },
      run: { runOnce: true, dryRun: false },
    });
  }

  /** A claimed issue carrying processingLabel (and optionally readyLabel). */
  function claimed(number: number, extraLabels: string[] = []): Issue {
    return anIssue(number, { labels: ["processing", ...extraLabels] });
  }

  /** Records the writes the sweep makes; any un-declared method still throws. */
  function writeRecorder(): { writes: string[]; overrides: GitHubStubOverrides } {
    const writes: string[] = [];
    return {
      writes,
      overrides: {
        resolveLogin: () => PHOEBE_LOGIN,
        removeIssueLabel: (issueNumber, label) => {
          writes.push(`remove-label issue #${issueNumber} ${label}`);
        },
        addIssueLabel: (issueNumber, label) => {
          writes.push(`add-label issue #${issueNumber} ${label}`);
        },
        addQuarantineLabel: (target) => {
          writes.push(`quarantine-label ${target.objectType} #${target.id}`);
        },
        issueTimeoutInputs: () => ({
          comments: [],
          extraActivityAt: null,
          baseline: "body:aabbcc",
        }),
        postUnitComment: (target, body) => {
          writes.push(`comment issue #${target.id} ${body}`);
        },
      },
    };
  }

  test("a claimed issue with no PR is re-armed and logged", async () => {
    const { writes, overrides } = writeRecorder();
    const result = await sweepCycle({
      ...overrides,
      listLabeledIssues: () => [claimed(7)],
      blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false }),
    });

    expect(writes).toEqual([
      "remove-label issue #7 processing",
      "add-label issue #7 ready-for-agent",
      `comment issue #7 ${buildUnitTimeoutMarker(1)}`,
    ]);
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] Re-armed issue #7 — stranded with no PR.",
    );
  });

  test("the counter increments from the last recorded value", async () => {
    const { writes, overrides } = writeRecorder();
    overrides.issueTimeoutInputs = () => ({
      comments: [
        {
          body: buildUnitTimeoutMarker(2),
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: PHOEBE_LOGIN,
        },
      ],
      extraActivityAt: null,
      baseline: "body:aabbcc",
    });
    await sweepCycle({
      ...overrides,
      listLabeledIssues: () => [claimed(7)],
      blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false }),
    });

    expect(writes).toContain(`comment issue #7 ${buildUnitTimeoutMarker(3)}`);
  });

  test("at K runs the issue is quarantined with an unproductive-runs comment", async () => {
    const { writes, overrides } = writeRecorder();
    overrides.issueTimeoutInputs = () => ({
      comments: [
        {
          body: buildUnitTimeoutMarker(2),
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: PHOEBE_LOGIN,
        },
      ],
      extraActivityAt: null,
      baseline: "body:aabbcc",
    });
    await sweepCycle(
      {
        ...overrides,
        listLabeledIssues: () => [claimed(7)],
        blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false }),
      },
      { maxUnproductiveRuns: 3 },
    );

    expect(writes).toContain(`quarantine-label issue #7`);
    const quarantineComment = writes.find((w) => w.includes("produced no PR"));
    expect(quarantineComment).toBeDefined();
    expect(quarantineComment).not.toContain("timed out");
  });

  test("a foreign comment resets the counter via decideTimeoutRecord", async () => {
    const { writes, overrides } = writeRecorder();
    overrides.issueTimeoutInputs = () => ({
      comments: [
        {
          body: buildUnitTimeoutMarker(2),
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: PHOEBE_LOGIN,
        },
        {
          body: "looks broken",
          createdAt: "2026-06-01T00:00:00Z",
          authorLogin: "human",
        },
      ],
      extraActivityAt: null,
      baseline: "body:aabbcc",
    });
    await sweepCycle({
      ...overrides,
      listLabeledIssues: () => [claimed(7)],
      blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false }),
    });

    // Count resets to 1 — newer foreign activity is treated as fresh start
    expect(writes).toContain(`comment issue #7 ${buildUnitTimeoutMarker(1)}`);
    expect(writes).not.toContain("quarantine-label issue #7");
  });

  test("readyLabel already present: not added again", async () => {
    const { writes, overrides } = writeRecorder();
    await sweepCycle({
      ...overrides,
      listLabeledIssues: () => [claimed(7, ["ready-for-agent"])],
      blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false }),
    });

    expect(writes).not.toContain("add-label issue #7 ready-for-agent");
    expect(writes).toContain("remove-label issue #7 processing");
  });

  test("a claimed issue whose run opened a PR is left alone", async () => {
    // removeIssueLabel not stubbed — any call would throw.
    await sweepCycle({
      listLabeledIssues: () => [claimed(7)],
      blockerPrState: () => ({ hasOpenPr: true, openPrNumber: asPrNumber(99), hasMergedPr: false }),
    });
  });

  test("a claimed issue whose run merged a PR is left alone", async () => {
    await sweepCycle({
      listLabeledIssues: () => [claimed(7)],
      blockerPrState: () => ({
        hasOpenPr: false,
        hasMergedPr: true,
        mergedPrNumber: asPrNumber(99),
      }),
    });
  });

  test("a failed listing is reported and the cycle carries on", async () => {
    const result = await sweepCycle({
      listLabeledIssues: () => {
        throw new Error("gh listing exploded");
      },
    });

    expect(result.lines.join("\n")).toContain("gh listing exploded");
    expect(result.lines).toContain(`${TAG} ${RUN_ONCE_NOTHING_MESSAGE}`);
  });

  test("a failed PR check is reported and the sweep continues with other issues", async () => {
    const { overrides } = writeRecorder();
    const result = await sweepCycle({
      ...overrides,
      listLabeledIssues: () => [claimed(7), claimed(8)],
      blockerPrState: (n) => {
        if (n === 7) throw new Error("PR check failed");
        return { hasOpenPr: false, hasMergedPr: false };
      },
    });

    expect(result.lines.join("\n")).toContain("PR check failed");
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] Re-armed issue #8 — stranded with no PR.",
    );
  });

  test("a quarantined claimed issue is re-armed unconditionally", async () => {
    const { writes, overrides } = writeRecorder();
    const result = await sweepCycle({
      ...overrides,
      listLabeledIssues: () => [claimed(7, ["phoebe:quarantined"])],
      blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false }),
    });

    expect(writes).toContain("remove-label issue #7 processing");
    expect(writes).toContain("add-label issue #7 ready-for-agent");
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] Re-armed issue #7 — stranded with no PR.",
    );
  });
});

// The map's invariant (#303): after boot-time registration, the engine cannot
// tell built-in from custom. These cycles drive a tenant-authored kind through
// the same walk the built-ins use — same selection line, same idle report,
// same free-string skip rendering — with nothing in the engine special-cased.
describe("a custom kind in the walk", () => {
  /** A stale-PR nudger: selects the oldest open PR, or reports why not. */
  function nudgeKind(opts: { workable: boolean }): LoadedCustomKind {
    const definition: AnyWorkKindDefinition = {
      name: "nudge",
      oneShotEligible: false,
      promptFile: "prompts/nudge.md",
      workspace: "worktree",
      report: {
        noun: "stale PR(s)",
        describe: (unit: { prNumber: number }) => `stale-PR nudge for PR #${unit.prNumber}`,
      },
      fetch: (ctx) => Promise.resolve({ prs: ctx.github.openPrs() }),
      select: (gathered: { prs: { number: number }[] }) => {
        if (!opts.workable) {
          return {
            unit: null,
            skipped:
              gathered.prs.length > 0
                ? [{ reason: "already nudged", count: gathered.prs.length }]
                : [],
            total: gathered.prs.length,
          };
        }
        const pick = gathered.prs[0] ?? null;
        return {
          unit: pick
            ? {
                ref: `pr:${pick.number}`,
                github: { objectType: "pr" as const, id: Number(pick.number) },
                prNumber: Number(pick.number),
              }
            : null,
          skipped: [],
          total: gathered.prs.length,
        };
      },
      run: () => Promise.resolve(),
    };
    return { name: "nudge", definition, options: undefined };
  }

  test("a workable custom unit wins the cycle through the one walk", async () => {
    const result = await runCycle({
      config: { workOrder: ["nudge", "issues"] },
      customKinds: [nudgeKind({ workable: true })],
      github: { ...prWorld([{ number: 44, issueNumber: 4 }]), listReadyIssues: () => [] },
    });

    expect(selection(result)).toBe(
      "[phoebe:acme/widget:work] Would execute: stale-PR nudge for PR #44.",
    );
  });

  test("its free-string skip reason and noun render in the idle report", async () => {
    const result = await runCycle({
      config: { workOrder: ["nudge"] },
      customKinds: [nudgeKind({ workable: false })],
      github: {
        ...prWorld([
          { number: 44, issueNumber: 4 },
          { number: 45, issueNumber: 5 },
        ]),
      },
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 2 stale PR(s) skipped (already nudged).",
    );
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 2 stale PR(s) but none workable this cycle.",
    );
  });

  test("a kind whose declared key the row cannot read stays off, and the cycle goes on", async () => {
    const declaring = nudgeKind({ workable: true });
    declaring.definition.requiredEnv = ["SLACK_BOT_TOKEN"];

    const result = await runCycle({
      config: { workOrder: ["nudge"] },
      customKinds: [declaring],
      env: {},
      github: { ...prWorld([{ number: 44, issueNumber: 4 }]) },
    });

    expect(selection(result)).toBeUndefined();
    expect(result.lines.join("\n")).toContain(
      'Work kind "nudge" declares SLACK_BOT_TOKEN, which this pipeline\'s env does not hold',
    );
  });

  test("the same kind works its unit once the key is set", async () => {
    const declaring = nudgeKind({ workable: true });
    declaring.definition.requiredEnv = ["SLACK_BOT_TOKEN"];

    const result = await runCycle({
      config: { workOrder: ["nudge"] },
      customKinds: [declaring],
      env: { SLACK_BOT_TOKEN: "xoxb-1" },
      github: { ...prWorld([{ number: 44, issueNumber: 4 }]) },
    });

    expect(selection(result)).toBe(
      "[phoebe:acme/widget:work] Would execute: stale-PR nudge for PR #44.",
    );
  });

  test("workOrder rejects a kind nobody registered", async () => {
    await expect(runCycle({ config: { workOrder: ["nudge"] }, github: {} })).rejects.toThrow(
      /Unknown work kind "nudge"/,
    );
  });

  // Reporting is outside the failure contract that makes `fetch` and `run`
  // cycle-fatal: a custom kind is authored code, and words it failed to produce
  // must not take the engine down.
  test("a report.idle that throws falls back to the engine's wording", async () => {
    const kind = nudgeKind({ workable: false });
    kind.definition.report.idle = () => {
      throw new Error("idle reporter exploded");
    };

    const result = await runCycle({
      config: { workOrder: ["nudge"] },
      customKinds: [kind],
      github: { ...prWorld([{ number: 44, issueNumber: 4 }]) },
    });

    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] 1 stale PR(s) but none workable this cycle.",
    );
    expect(result.lines.join("\n")).toContain("idle reporter exploded");
  });

  test("a report.describe that throws falls back to the unit's (kind, ref)", async () => {
    const kind = nudgeKind({ workable: true });
    kind.definition.report.describe = () => {
      throw new Error("describe exploded");
    };

    const result = await runCycle({
      config: { workOrder: ["nudge"] },
      customKinds: [kind],
      github: { ...prWorld([{ number: 44, issueNumber: 4 }]), listReadyIssues: () => [] },
    });

    expect(selection(result)).toBe("[phoebe:acme/widget:work] Would execute: nudge pr:44.");
  });
});

// The engine-prepared workspace, in all three declared modes. It is prepared on
// first read of `ctx.workspace.dir`, not up front (#356); `scratch` is a plain
// directory with no clone and no git state (#358), and `readonly` is a worktree
// detached at the default branch, with no branch to push (#397). These are the only
// tests that let a unit actually execute — the container marker is injected
// rather than read — because "what did the engine build?" is a question about
// the run path, not the selection path.
/** A tenant data root a test may actually write to, removed afterwards. */
function tenantRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "phoebe-workspace-test-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("the run workspace", () => {
  /** What a run saw when it read `ctx.workspace.dir` and `ctx.workspace.scratch`. */
  type WorkspaceSighting = {
    mode: string;
    dir: string;
    exists: boolean;
    entries: string[];
    scratch?: string;
    scratchEntries?: string[];
  };

  /** A custom kind that executes, recording whether and what it read. */
  function workspaceKind(opts: {
    readsDir: boolean;
    mode?: WorkspaceMode;
    /** Also read the handle's scratch dir, and leave a draft in it (#423). */
    writesScratch?: boolean;
    /** Override the unit ref, for the paths a kind-owned ref has to survive. */
    ref?: string;
  }): {
    kind: LoadedCustomKind;
    seen: WorkspaceSighting[];
  } {
    const seen: WorkspaceSighting[] = [];
    const definition: AnyWorkKindDefinition = {
      name: "nudge",
      oneShotEligible: true,
      promptFile: "prompts/nudge.md",
      workspace: opts.mode ?? "worktree",
      report: {
        noun: "stale PR(s)",
        describe: (unit: { prNumber: number }) => `stale-PR nudge for PR #${unit.prNumber}`,
      },
      fetch: (ctx) => Promise.resolve({ prs: ctx.github.openPrs() }),
      select: (gathered: { prs: { number: number }[] }) => {
        const pick = gathered.prs[0] ?? null;
        return {
          unit: pick
            ? { ref: opts.ref ?? `pr:${pick.number}`, prNumber: Number(pick.number) }
            : null,
          skipped: [],
          total: gathered.prs.length,
        };
      },
      run: (_unit, ctx) => {
        if (opts.readsDir) {
          const dir = ctx.workspace.dir;
          const exists = existsSync(dir);
          const sighting: WorkspaceSighting = {
            mode: ctx.workspace.mode,
            dir,
            exists,
            entries: exists ? readdirSync(dir) : [],
          };
          if (opts.writesScratch) {
            const scratch = ctx.workspace.scratch;
            writeFileSync(join(scratch, "draft.md"), "what the kind produced");
            sighting.scratch = scratch;
            sighting.scratchEntries = readdirSync(scratch);
          }
          seen.push(sighting);
        }
        return Promise.resolve();
      },
    };
    return { kind: { name: "nudge", definition, options: undefined }, seen };
  }

  async function executeNudge(opts: {
    readsDir: boolean;
    mode?: WorkspaceMode;
    writesScratch?: boolean;
    ref?: string;
    dataBase?: string;
    dirtyPaths?: readonly string[];
  }): Promise<{ result: CycleResult; seen: WorkspaceSighting[] }> {
    const { kind, seen } = workspaceKind(opts);
    const result = await runCycle({
      config: { workOrder: ["nudge"] },
      customKinds: [kind],
      ...(opts.dataBase !== undefined ? { dataBase: opts.dataBase } : {}),
      ...(opts.dirtyPaths !== undefined ? { dirtyPaths: opts.dirtyPaths } : {}),
      github: {
        ...prWorld([{ number: 44, issueNumber: 4 }]),
        // The boot-time login cross-check (#346) runs on an executing cycle.
        resolveLogin: () => PHOEBE_LOGIN,
        newestUnitMarkerAuthor: () => PHOEBE_LOGIN,
      },
      // A token puts the engine on the PAT arm; without one it takes the app
      // arm and refuses the cycle for want of GH_APP_ID.
      env: { GH_TOKEN: "t" },
      inContainer: true,
      run: { runOnce: true, dryRun: false },
    });
    return { result, seen };
  }

  /** Worktree calls that build or tear one down — not the boot-time lease read (#418). */
  const worktreeMutations = (calls: readonly string[][]): string[][] =>
    calls.filter((args) => args[0] === "worktree" && args[1] !== "list");

  test("a run that never reads the dir builds no worktree", async () => {
    const { result, seen } = await executeNudge({ readsDir: false });

    expect(result.events).toEqual([
      { kind: "nudge", id: "pr:44" },
      { kind: "nudge", id: "pr:44" },
    ]);
    expect(seen).toEqual([]);
    // The unit ran to completion without a single worktree command — the churn
    // the eager workspace used to cost every unit, built-ins included.
    expect(worktreeMutations(result.gitCalls)).toEqual([]);
  });

  test("reading the dir materializes the worktree, and it is removed after", async () => {
    const { seen } = await executeNudge({ readsDir: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.mode).toBe("worktree");
    expect(seen[0]?.dir).toContain("phoebe-workspace");
  });

  test("the materialized worktree is added off the default branch and removed", async () => {
    const { result } = await executeNudge({ readsDir: true });
    const worktreeCalls = worktreeMutations(result.gitCalls);

    expect(worktreeCalls.some((args) => args[1] === "add")).toBe(true);
    expect(worktreeCalls.some((args) => args[1] === "remove")).toBe(true);
    expect(worktreeCalls.find((args) => args[1] === "add")?.at(-1)).toBe("origin/main");
  });

  test("a scratch kind gets a real, empty directory and no git at all", async () => {
    const dataBase = tenantRoot();
    const { result, seen } = await executeNudge({ readsDir: true, mode: "scratch", dataBase });

    expect(seen[0]?.mode).toBe("scratch");
    expect(seen[0]?.exists).toBe(true);
    expect(seen[0]?.entries).toEqual([]);
    expect(seen[0]?.dir).toBe(join(dataBase, "acme/widget/scratch/nudge/pr%3A44"));
    // No clone, no branch, no worktree plumbing: that is the whole point of the
    // mode, and the assertion that separates it from a worktree that happens to
    // look empty under the git stub.
    expect(worktreeMutations(result.gitCalls)).toEqual([]);
  });

  test("the scratch directory is removed when the unit finishes", async () => {
    const dataBase = tenantRoot();
    const { seen } = await executeNudge({ readsDir: true, mode: "scratch", dataBase });

    expect(seen[0]?.exists).toBe(true);
    expect(existsSync(seen[0]?.dir ?? "")).toBe(false);
  });

  test("a scratch run that never reads the dir creates nothing", async () => {
    const dataBase = tenantRoot();
    await executeNudge({ readsDir: false, mode: "scratch", dataBase });

    expect(existsSync(join(dataBase, "acme/widget/scratch"))).toBe(false);
  });

  test("a directory left behind by a killed run is cleared, not inherited", async () => {
    const dataBase = tenantRoot();
    const stale = join(dataBase, "acme/widget/scratch/nudge");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "half-written-draft.md"), "from the run that died");

    const { seen } = await executeNudge({ readsDir: true, mode: "scratch", dataBase });

    expect(seen[0]?.entries).toEqual([]);
  });

  // `readonly` (#397): the same worktree the `worktree` arm prepares, detached
  // at the default branch. The mode's whole claim is what it does *not* build —
  // no branch to commit onto, none created in the clone — so the assertions are
  // about the argv, plus the one thing the engine does check.
  test("a readonly kind gets a detached worktree of the default branch, per unit", async () => {
    const { result, seen } = await executeNudge({ readsDir: true, mode: "readonly" });

    expect(seen[0]?.mode).toBe("readonly");
    expect(seen[0]?.dir).toBe(
      join("/data/repos/acme/widget/worktrees", "readonly", "nudge", "pr%3A44"),
    );
    const add = result.gitCalls.find((args) => args[0] === "worktree" && args[1] === "add");
    expect(add).toEqual(["worktree", "add", "--detach", seen[0]?.dir, "origin/main"]);
    expect(result.gitCalls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(
      true,
    );
  });

  test("a readonly run that never reads the dir builds no worktree", async () => {
    const { result } = await executeNudge({ readsDir: false, mode: "readonly" });

    expect(worktreeMutations(result.gitCalls)).toEqual([]);
  });

  test("a clean readonly tree is discarded without a word", async () => {
    const { result } = await executeNudge({ readsDir: true, mode: "readonly" });

    expect(result.lines.filter((line) => line.includes("readonly workspace"))).toEqual([]);
  });

  test("a readonly tree the kind wrote into is warned about as it is discarded", async () => {
    const { result } = await executeNudge({
      readsDir: true,
      mode: "readonly",
      dirtyPaths: ["src/index.ts", "README.md"],
    });

    expect(result.lines).toContainEqual(
      expect.stringContaining(
        "nudge pr:44: the readonly workspace was modified (2 changed file(s)",
      ),
    );
    // Warned, not blocked: the unit still completed.
    expect(result.events).toHaveLength(2);
  });

  // The scratch every handle carries (#423). The mode still names the git
  // shape; where a kind may write is no longer part of that choice.
  test("a readonly kind gets somewhere to write beside its reading room", async () => {
    const dataBase = tenantRoot();
    const { seen } = await executeNudge({
      readsDir: true,
      writesScratch: true,
      mode: "readonly",
      dataBase,
    });

    expect(seen[0]?.scratch).toBe(join(dataBase, "acme/widget/scratch/nudge/pr%3A44"));
    expect(seen[0]?.scratchEntries).toEqual(["draft.md"]);
    // The two are different places: the reading room is the detached tree.
    expect(seen[0]?.scratch).not.toBe(seen[0]?.dir);
  });

  test("the scratch a readonly unit wrote goes with the unit", async () => {
    const dataBase = tenantRoot();
    const { seen } = await executeNudge({
      readsDir: true,
      writesScratch: true,
      mode: "readonly",
      dataBase,
    });

    expect(existsSync(seen[0]?.scratch ?? "")).toBe(false);
  });

  test("a scratch kind reads one directory under both names", async () => {
    const dataBase = tenantRoot();
    const { seen } = await executeNudge({
      readsDir: true,
      writesScratch: true,
      mode: "scratch",
      dataBase,
    });

    expect(seen[0]?.scratch).toBe(seen[0]?.dir);
  });

  // A ref is a kind's own string: nothing in the engine parses one, so nothing
  // in the engine may assume it is path-shaped either.
  test("a ref carrying / and % lands on one directory of its own", async () => {
    const dataBase = tenantRoot();
    const { seen } = await executeNudge({
      readsDir: true,
      mode: "scratch",
      ref: "feed/2026%mix",
      dataBase,
    });

    expect(seen[0]?.dir).toBe(join(dataBase, "acme/widget/scratch/nudge/feed%2F2026%25mix"));
    expect(seen[0]?.exists).toBe(true);
  });
});

// The whole-unit run deadline (#359): the budget now races against the whole
// `definition.run`, not just the agent spawn. `ctx.signal` carries the
// AbortSignal so cooperative kinds can stop early; the engine races regardless.
describe("the run deadline signal", () => {
  /** A custom kind that records whatever signal it received on `ctx`. */
  function signalCapturingKind(): { kind: LoadedCustomKind; signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    const definition: AnyWorkKindDefinition = {
      name: "nudge",
      oneShotEligible: true,
      promptFile: "prompts/nudge.md",
      workspace: "worktree",
      report: {
        noun: "stale PR(s)",
        describe: (unit: { prNumber: number }) => `stale-PR nudge for PR #${unit.prNumber}`,
      },
      fetch: (ctx) => Promise.resolve({ prs: ctx.github.openPrs() }),
      select: (gathered: { prs: { number: number }[] }) => {
        const pick = gathered.prs[0] ?? null;
        return {
          unit: pick ? { ref: `pr:${pick.number}`, prNumber: Number(pick.number) } : null,
          skipped: [],
          total: gathered.prs.length,
        };
      },
      run: (_unit, ctx) => {
        signals.push(ctx.signal);
        return Promise.resolve();
      },
    };
    return { kind: { name: "nudge", definition, options: undefined }, signals };
  }

  test("ctx.signal is an AbortSignal and is not yet aborted during normal execution", async () => {
    const { kind, signals } = signalCapturingKind();
    await runCycle({
      config: { workOrder: ["nudge"] },
      customKinds: [kind],
      github: {
        ...prWorld([{ number: 44, issueNumber: 4 }]),
        resolveLogin: () => PHOEBE_LOGIN,
        newestUnitMarkerAuthor: () => PHOEBE_LOGIN,
      },
      env: { GH_TOKEN: "t" },
      inContainer: true,
      run: { runOnce: true, dryRun: false },
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What a pipeline owns on disk (#418)
// ---------------------------------------------------------------------------

describe("the stdout tag", () => {
  test("every line an engine writes carries slug and pipeline", async () => {
    const result = await runCycle({
      github: { listReadyIssues: () => [], listResearchIssues: () => [] },
      config: { workOrder: ["issues", "research"] },
    });

    expect(result.lines).not.toEqual([]);
    for (const line of result.lines) {
      expect(line.startsWith("[phoebe:acme/widget:work]")).toBe(true);
    }
  });

  test("a second row on the same tenant tags itself apart", async () => {
    const result = await runCycle({
      github: { listReadyIssues: () => [] },
      config: { workOrder: ["issues"] },
      pipeline: "intake",
    });

    expect(result.lines).not.toEqual([]);
    for (const line of result.lines) {
      expect(line.startsWith("[phoebe:acme/widget:intake]")).toBe(true);
    }
  });
});

describe("sweeps scoped to the pipeline's kinds", () => {
  /** A wet `--run-once` cycle that selects nothing, so only the sweeps run. */
  function sweepCycle(opts: {
    github: GitHubStubOverrides;
    config?: Partial<PhoebeUserConfig>;
    customKinds?: LoadedCustomKind[];
  }) {
    return runCycle({
      env: { GH_TOKEN: "a-token" },
      github: opts.github,
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.customKinds !== undefined ? { customKinds: opts.customKinds } : {}),
      run: { runOnce: true, dryRun: false },
    });
  }

  /** A kind that gathers nothing, so a row can schedule work without units. */
  function idleKind(name: string): LoadedCustomKind {
    return {
      name,
      options: undefined,
      definition: {
        name,
        oneShotEligible: true,
        promptFile: "prompts/nudge.md",
        workspace: "scratch",
        report: { noun: `${name}(s)`, describe: () => name },
        fetch: () => Promise.resolve({}),
        select: () => ({ unit: null, skipped: [], total: 0 }),
        run: () => Promise.resolve(),
      } as AnyWorkKindDefinition,
    };
  }

  // The acceptance case: the sweep that re-arms issues must not run at all from
  // a row that works no issues, or it hands a sibling's in-flight ticket back
  // to the queue.
  test("a row that schedules no issue kind lists no claimed issue", async () => {
    const result = await sweepCycle({
      config: { workOrder: ["conflicts"] },
      github: {
        openPrs: () => [],
        // Every listing the issue-side sweeps would reach is left unstubbed:
        // the stub throws on an undeclared call, so reaching one fails here.
        resolveLogin: () => PHOEBE_LOGIN,
        newestUnitMarkerAuthor: () => PHOEBE_LOGIN,
        listQuarantinedPrs: () => [],
        listNativelyStackedPrs: () => [],
      },
    });

    expect(result.lines.some((line) => line.includes("Re-armed"))).toBe(false);
  });

  test("a row of custom kinds alone sweeps nothing at all", async () => {
    const result = await sweepCycle({
      config: { workOrder: ["digest"] },
      customKinds: [idleKind("digest")],
      github: { resolveLogin: () => PHOEBE_LOGIN, newestUnitMarkerAuthor: () => PHOEBE_LOGIN },
    });

    expect(result.lines).toContain(`[phoebe:acme/widget:work] ${RUN_ONCE_NOTHING_MESSAGE}`);
  });

  test("an issue row re-arms its own tickets and leaves the research row's alone", async () => {
    const rearmed: number[] = [];
    const result = await sweepCycle({
      config: { workOrder: ["issues"] },
      github: {
        listReadyIssues: () => [],
        resolveLogin: () => PHOEBE_LOGIN,
        newestUnitMarkerAuthor: () => PHOEBE_LOGIN,
        listQuarantinedIssues: () => [],
        listNativelyStackedPrs: () => [],
        listFeatureIntegrationPrs: () => [],
        listLabeledIssues: () => [
          anIssue(7, { labels: ["processing"] }),
          anIssue(8, { labels: ["processing", "wayfinder:research"] }),
        ],
        blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false }),
        issueTimeoutInputs: () => ({ comments: [], extraActivityAt: null, baseline: "body:aa" }),
        removeIssueLabel: (issueNumber) => {
          rearmed.push(issueNumber);
        },
        addIssueLabel: () => {},
        postUnitComment: () => {},
      },
    });

    expect(rearmed).toEqual([7]);
    expect(result.lines).toContain(
      "[phoebe:acme/widget:work] Re-armed issue #7 — stranded with no PR.",
    );
  });

  test("a research row re-arms the research ticket and nothing else", async () => {
    const rearmed: number[] = [];
    await sweepCycle({
      config: { workOrder: ["research"] },
      github: {
        listResearchIssues: () => [],
        resolveLogin: () => PHOEBE_LOGIN,
        newestUnitMarkerAuthor: () => PHOEBE_LOGIN,
        listQuarantinedIssues: () => [],
        listNativelyStackedPrs: () => [],
        listFeatureIntegrationPrs: () => [],
        listLabeledIssues: () => [
          anIssue(7, { labels: ["processing"] }),
          anIssue(8, { labels: ["processing", "wayfinder:research"] }),
        ],
        blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false }),
        issueTimeoutInputs: () => ({ comments: [], extraActivityAt: null, baseline: "body:aa" }),
        removeIssueLabel: (issueNumber) => {
          rearmed.push(issueNumber);
        },
        addIssueLabel: () => {},
        postUnitComment: () => {},
      },
    });

    expect(rearmed).toEqual([8]);
  });
});

describe("the worktree lease at the unit boundary", () => {
  const WORKSPACE_DIR = "/data/repos/acme/widget/worktrees/phoebe-workspace";

  /** A `git worktree list --porcelain` answer with one leased workspace tree. */
  const leasedBy = (reason: string): string =>
    [
      "worktree /data/repos/acme/widget/repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${WORKSPACE_DIR}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/phoebe/workspace",
      `locked ${reason}`,
      "",
    ].join("\n");

  /** A kind that reads its workspace, so the engine has to build the worktree. */
  function workspaceReader(): LoadedCustomKind {
    return {
      name: "nudge",
      options: undefined,
      definition: {
        name: "nudge",
        oneShotEligible: true,
        promptFile: "prompts/nudge.md",
        workspace: "worktree",
        report: {
          noun: "stale PR(s)",
          describe: (unit: { prNumber: number }) => `stale-PR nudge for PR #${unit.prNumber}`,
        },
        fetch: (ctx) => Promise.resolve({ prs: ctx.github.openPrs() }),
        select: (gathered: { prs: { number: number }[] }) => {
          const pick = gathered.prs[0] ?? null;
          return {
            unit: pick ? { ref: `pr:${pick.number}`, prNumber: Number(pick.number) } : null,
            skipped: [],
            total: gathered.prs.length,
          };
        },
        run: (_unit, ctx) => {
          void ctx.workspace.dir;
          return Promise.resolve();
        },
      } as AnyWorkKindDefinition,
    };
  }

  function leaseCycle(worktreeList: string, pipeline?: string) {
    return runCycle({
      config: { workOrder: ["nudge"] },
      customKinds: [workspaceReader()],
      github: {
        ...prWorld([{ number: 44, issueNumber: 4 }]),
        resolveLogin: () => PHOEBE_LOGIN,
        newestUnitMarkerAuthor: () => PHOEBE_LOGIN,
      },
      env: { GH_TOKEN: "t" },
      inContainer: true,
      worktreeList,
      ...(pipeline !== undefined ? { pipeline } : {}),
      run: { runOnce: true, dryRun: false },
    });
  }

  test("a boot of the owning pipeline breaks its own stale lease", async () => {
    const result = await leaseCycle(leasedBy("pipeline=work pid=999"));

    expect(result.gitCalls).toContainEqual(["worktree", "unlock", WORKSPACE_DIR]);
    expect(result.lines).toContain(
      `[phoebe:acme/widget:work] Broke a stale worktree lease on ${WORKSPACE_DIR} — it was this pipeline's own.`,
    );
  });

  test("a boot of a different pipeline leaves the lease alone and says so", async () => {
    const result = await leaseCycle(leasedBy("pipeline=work pid=999"), "intake");

    expect(result.gitCalls).not.toContainEqual(["worktree", "unlock", WORKSPACE_DIR]);
    expect(result.lines).toContain(
      `[phoebe:acme/widget:intake] Worktree ${WORKSPACE_DIR} is leased by pipeline work — leaving it alone.`,
    );
  });

  // The whole point: the sibling's tree survives. The old teardown would have
  // fallen through to a recursive delete on git's refusal.
  test("a unit whose tree another pipeline leases is skipped, not failed", async () => {
    const result = await leaseCycle(leasedBy("pipeline=work pid=999"), "intake");

    expect(
      result.lines.some(
        (line) =>
          line.includes("Skipped stale-PR nudge for PR #44") && line.includes("leased by work"),
      ),
    ).toBe(true);
    expect(result.gitCalls).not.toContainEqual(["worktree", "remove", "--force", WORKSPACE_DIR]);
    expect(result.lines.some((line) => line.includes("Failed executing"))).toBe(false);
  });

  test("an unleased tree is claimed, built, leased, and released", async () => {
    const result = await leaseCycle("");
    const worktreeArgv = result.gitCalls.filter((args) => args[0] === "worktree");

    expect(worktreeArgv).toContainEqual([
      "worktree",
      "lock",
      "--reason",
      `pipeline=work#nudge:pr%3A44 pid=${process.pid}`,
      WORKSPACE_DIR,
    ]);
    expect(worktreeArgv).toContainEqual(["worktree", "unlock", WORKSPACE_DIR]);
    expect(worktreeArgv).toContainEqual(["worktree", "remove", "--force", WORKSPACE_DIR]);
  });
});

// ---------------------------------------------------------------------------
// Rolling top-up: several units in flight inside one pipeline (#422)
// ---------------------------------------------------------------------------

/**
 * A drain latch the test drives by hand. `wait` never times out on its own, so
 * the loop only moves when the test says so — `tick()` wakes an idle poll,
 * `request()` drains — and a pass that neither settles a unit nor is ticked is
 * a hung test rather than a flaky one.
 */
function manualDrain(): DrainSignal & { request(): void; tick(): void } {
  let requested = false;
  const wakers = new Set<() => void>();
  const wakeAll = (): void => {
    for (const wake of wakers) wake();
  };
  return {
    get requested() {
      return requested;
    },
    wait: () =>
      requested
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const wake = (): void => {
              wakers.delete(wake);
              resolve();
            };
            wakers.add(wake);
          }),
    dispose: () => {},
    request: () => {
      requested = true;
      wakeAll();
    },
    tick: wakeAll,
  };
}

/** One work kind whose units block in `run` until the test releases them. */
type GatedKind = {
  kind: LoadedCustomKind;
  /** Refs whose `run` has been entered, in admission order. */
  started: string[];
  /** Let one running unit finish; `error` makes it finish by throwing. */
  release(ref: string, error?: Error): Promise<void>;
  /** Put one more unit on the kind's list, for the next gather to see. */
  offer(id: number): void;
};

/**
 * A kind offering one unit per entry of `refs`, each blocking in `run`. It is
 * the instrument every test below uses: the engine's concurrency is observable
 * as which units are inside `run` at the same moment.
 *
 * `ignoresInFlight` models the careless kind the contract has to survive — its
 * `select` always offers its first ref, whatever is already running.
 */
function gatedKind(opts: {
  refs: readonly number[];
  ignoresInFlight?: boolean;
  /** The GitHub object each unit declares; omitted ⇒ the unit declares none. */
  target?: (id: number) => WorkUnitGitHubTarget;
  name?: string;
  /** Which workspace the kind declares; a plain directory, and no git, by default. */
  workspace?: WorkspaceMode;
  /** Run inside `run` before the unit blocks — where a test touches its workspace. */
  onRun?: (ref: string, ctx: WorkKindRunCtx) => void;
}): GatedKind {
  const name = opts.name ?? "gated";
  const refs = [...opts.refs];
  const started: string[] = [];
  const gates = new Map<string, (error?: Error) => void>();
  const settled = new Map<string, Promise<void>>();
  return {
    started,
    async release(ref, error) {
      gates.get(ref)?.(error);
      await settled.get(ref);
    },
    offer: (id) => refs.push(id),
    kind: {
      name,
      options: undefined,
      definition: {
        name,
        oneShotEligible: true,
        promptFile: `prompts/${name}.md`,
        workspace: opts.workspace ?? "scratch",
        report: {
          noun: `${name} unit(s)`,
          describe: (unit: { ref: string }) => `${name} ${unit.ref}`,
        },
        fetch: () => Promise.resolve({ refs: [...refs] }),
        select: (gathered: { refs: readonly number[] }, ctx) => {
          const free = opts.ignoresInFlight
            ? gathered.refs
            : gathered.refs.filter((id) => !ctx.inFlight.has(`u:${id}`));
          const pick = free[0];
          return {
            unit:
              pick === undefined
                ? null
                : {
                    ref: `u:${pick}`,
                    ...(opts.target ? { github: opts.target(pick) } : {}),
                  },
            skipped: [],
            total: gathered.refs.length,
          };
        },
        run: (unit: { ref: string }, ctx: WorkKindRunCtx) => {
          started.push(unit.ref);
          // Handed out once: a real kind stops offering a unit it has worked,
          // and without that the gate would re-offer the same ref forever.
          // Before `onRun`, which is allowed to throw.
          const at = refs.indexOf(Number(unit.ref.slice(2)));
          if (at !== -1) refs.splice(at, 1);
          opts.onRun?.(unit.ref, ctx);
          const promise = new Promise<void>((resolve, reject) => {
            gates.set(unit.ref, (error) => (error ? reject(error) : resolve()));
          });
          settled.set(
            unit.ref,
            promise.catch(() => {}),
          );
          return promise;
        },
      } as AnyWorkKindDefinition,
    },
  };
}

/** An engine running `kinds` for real, with the drain latch the test drives. */
function concurrentEngine(opts: {
  /** Anything that carries a loaded kind — the gated one, or #424's hanging one. */
  kinds: readonly { kind: LoadedCustomKind }[];
  concurrency: number;
  workOrder?: readonly string[];
  github?: GitHubStubOverrides;
  credentialClient?: CredentialClient;
  slotClient?: SlotClient;
  /** Root for the derived tenant paths — a tmpdir when a test lets one be written. */
  dataBase?: string;
  /** Wrap the git stub, to see what the engine asked of it (#423). */
  git?: (base: GitRunner) => GitRunner;
  /** Extra environment, over the token every engine here starts with. */
  env?: NodeJS.ProcessEnv;
}): {
  drain: ReturnType<typeof manualDrain>;
  lines: string[];
  status: () => StatusSnapshot | null;
  env: NodeJS.ProcessEnv;
  loop: () => Promise<void>;
} {
  const drain = manualDrain();
  const config = resolveConfig(
    {
      ...minimalUser(),
      workOrder: opts.workOrder ?? opts.kinds.map((gated) => gated.kind.name),
    },
    opts.dataBase !== undefined ? { dataBase: opts.dataBase } : {},
  );
  const env: NodeJS.ProcessEnv = { GH_TOKEN: "t0", ...opts.env };
  let snapshot: StatusSnapshot | null = null;
  const lines: string[] = [];
  const engine = createEngine({
    config,
    registry: buildRegistry(
      config,
      opts.kinds.map((gated) => gated.kind),
    ),
    env,
    inContainer: true,
    github: stubGitHub({
      resolveLogin: () => PHOEBE_LOGIN,
      newestUnitMarkerAuthor: () => PHOEBE_LOGIN,
      ...opts.github,
    }),
    git: opts.git ? opts.git(stubGit({}).git) : stubGit({}).git,
    clock: { sleep: () => Promise.resolve(), now: () => new Date("2026-08-19T00:00:00Z") },
    drain,
    slotClient: opts.slotClient ?? null,
    credentialClient: opts.credentialClient ?? null,
    emitUnitEvent: createEmitUnitEvent({
      tenant: config.repoSlug,
      pipeline: "work",
      statusPath: "status.json",
      log: (line) => lines.push(line),
      read: () => snapshot,
      write: (_path, next) => {
        snapshot = next;
      },
    }),
    run: {
      runOnce: false,
      dryRun: false,
      pollIntervalMs: 1_000,
      concurrency: opts.concurrency,
    },
  });
  return {
    drain,
    lines,
    env,
    status: () => snapshot,
    loop: async () => {
      const original = { log: console.log, warn: console.warn, error: console.error };
      const restore = (): void => {
        Object.assign(console, original);
      };
      const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => String(arg)).join(" "));
      };
      console.log = record;
      console.warn = record;
      console.error = record;
      // Also on the way out of a test that threw mid-loop, so one failure does
      // not silence the rest of the file.
      onTestFinished(restore);
      try {
        await engine.runLoop();
      } finally {
        restore();
      }
    },
  };
}

/** Give the loop room to run its passes up to its next await on the test. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("rolling top-up inside one pipeline", () => {
  test("concurrency 2 has both units running before either finishes", async () => {
    const gated = gatedKind({ refs: [1, 2] });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 2 });
    const loop = engine.loop();
    await settle();

    // Both entered `run`, and the snapshot says so with a start time each.
    expect(gated.started).toEqual(["u:1", "u:2"]);
    const running = engine.status()?.currentUnits ?? [];
    expect(running.map((current) => current.unit.id)).toEqual(["u:1", "u:2"]);
    expect(running.every((current) => current.startedAt.length > 0)).toBe(true);
    expect(running.every((current) => current.runBudgetMs !== null)).toBe(true);

    engine.drain.request();
    await gated.release("u:1");
    await gated.release("u:2");
    await loop;
    expect(engine.status()?.currentUnits).toEqual([]);
  });

  test("concurrency 1 admits the second unit only once the first has settled", async () => {
    const gated = gatedKind({ refs: [1, 2] });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 1 });
    const loop = engine.loop();
    await settle();

    expect(gated.started).toEqual(["u:1"]);
    await gated.release("u:1");
    await settle();
    expect(gated.started).toEqual(["u:1", "u:2"]);

    engine.drain.request();
    await gated.release("u:2");
    await loop;
  });

  test("a settled failure is reconsidered immediately, with no poll sleep", async () => {
    const gated = gatedKind({ refs: [1, 2] });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 1 });
    const loop = engine.loop();
    await settle();

    // No `tick()` between the two: the settle is what wakes the pass.
    await gated.release("u:1", new Error("push rejected"));
    await settle();
    expect(gated.started).toEqual(["u:1", "u:2"]);
    expect(engine.status()?.lastError).toBe("push rejected");

    engine.drain.request();
    await gated.release("u:2");
    await loop;
  });

  test("a kind ignoring ctx.inFlight runs one unit at a time, and the drop is logged", async () => {
    const gated = gatedKind({ refs: [1, 2], ignoresInFlight: true });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 2 });
    const loop = engine.loop();
    await settle();

    expect(gated.started).toEqual(["u:1"]);
    expect(
      engine.lines.some(
        (line) => line.includes("gated offered u:1") && line.includes("already running"),
      ),
    ).toBe(true);

    engine.drain.request();
    await gated.release("u:1");
    await loop;
  });

  test("two units on the same GitHub object are never in flight together", async () => {
    const gated = gatedKind({
      refs: [1, 2],
      // Distinct refs, one shared PR — exactly what admission must refuse.
      target: () => ({ objectType: "pr", id: 7 }),
    });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 2 });
    const loop = engine.loop();
    await settle();

    expect(gated.started).toEqual(["u:1"]);
    expect(
      engine.lines.some(
        (line) => line.includes("Not admitting gated u:2") && line.includes("PR #7"),
      ),
    ).toBe(true);

    engine.drain.request();
    await gated.release("u:1");
    await loop;
  });

  test("a unit with no GitHub target is admitted, and the absent exclusion is logged", async () => {
    const gated = gatedKind({ refs: [1] });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 2 });
    const loop = engine.loop();
    await settle();

    expect(gated.started).toEqual(["u:1"]);
    expect(engine.lines.some((line) => line.includes("gated u:1 declares no GitHub target"))).toBe(
      true,
    );

    engine.drain.request();
    await gated.release("u:1");
    await loop;
  });

  test("draining with two units in flight waits for both, then exits", async () => {
    const gated = gatedKind({ refs: [1, 2] });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 2 });
    const loop = engine.loop();
    await settle();
    expect(gated.started).toEqual(["u:1", "u:2"]);

    engine.drain.request();
    let exited = false;
    void loop.then(() => {
      exited = true;
    });
    await settle();
    // Neither unit has finished, so neither has the loop.
    expect(exited).toBe(false);

    await gated.release("u:1");
    await settle();
    expect(exited).toBe(false);

    await gated.release("u:2");
    await loop;
    expect(exited).toBe(true);
    expect(engine.lines.some((line) => line.includes("awaiting 2 in flight"))).toBe(true);
  });

  test("priority still means priority: the first kind fills both slots", async () => {
    const first = gatedKind({ refs: [1, 2], name: "first" });
    const second = gatedKind({ refs: [3], name: "second" });
    const engine = concurrentEngine({ kinds: [first, second], concurrency: 2 });
    const loop = engine.loop();
    await settle();

    expect(first.started).toEqual(["u:1", "u:2"]);
    expect(second.started).toEqual([]);

    engine.drain.request();
    await first.release("u:1");
    await first.release("u:2");
    await loop;
  });

  test("the stranded-unit sweep leaves an issue this pipeline is running alone", async () => {
    const gated = gatedKind({
      refs: [88],
      target: (id) => ({ objectType: "issue", id }),
    });
    const rearmed: number[] = [];
    const engine = concurrentEngine({
      kinds: [gated],
      concurrency: 2,
      // `issues` is in the order so the row owns issue-shaped objects and the
      // stranded sweep actually runs; it offers nothing itself.
      workOrder: ["gated", "issues"],
      github: {
        listReadyIssues: () => [],
        // Claimed only once its unit is running: the first pass sweeps before
        // it admits anything, and an issue nobody holds is fair game.
        listLabeledIssues: () =>
          gated.started.length > 0 ? [anIssue(88, { labels: ["processing"] })] : [],
        blockerPrState: () => ({ hasOpenPr: false, hasMergedPr: false }),
        removeIssueLabel: (issueNumber) => rearmed.push(issueNumber),
      },
    });
    const loop = engine.loop();
    await settle();
    expect(gated.started).toEqual(["u:88"]);

    // A second pass, with the unit still between its claim and its first push.
    engine.drain.tick();
    await settle();
    expect(rearmed).toEqual([]);

    engine.drain.request();
    await gated.release("u:88");
    await loop;
  });

  test("a blocked credential refresh admits nothing while the running unit finishes", async () => {
    const gated = gatedKind({ refs: [1] });
    let leases = 0;
    const slots = { acquired: 0, released: 0 };
    const engine = concurrentEngine({
      kinds: [gated],
      concurrency: 2,
      slotClient: {
        acquire: () => {
          slots.acquired += 1;
          return Promise.resolve();
        },
        release: () => {
          slots.released += 1;
        },
      },
      credentialClient: {
        requestLease: () => {
          leases += 1;
          // 1 and 2 are the first pass's top-of-poll and its admission; 3 is
          // the second pass's top-of-poll; 4 is the admission that fails.
          if (leases >= 4) return Promise.reject(new CredentialRefreshBlockedError());
          return Promise.resolve(`t${leases}`);
        },
      },
    });
    const loop = engine.loop();
    await settle();
    expect(gated.started).toEqual(["u:1"]);

    // A second unit appears, and the lease that would admit it fails.
    gated.offer(2);
    engine.drain.tick();
    await settle();

    expect(gated.started).toEqual(["u:1"]);
    // The cell was not cleared, so the running unit still has a token — and no
    // slot was taken for the unit that was never admitted, so none was given
    // back either.
    expect(engine.env["GH_TOKEN"]).toBe("t3");
    expect(slots).toEqual({ acquired: 1, released: 0 });

    engine.drain.request();
    await gated.release("u:1");
    await loop;
    expect(slots).toEqual({ acquired: 1, released: 1 });
  });
});

// ---------------------------------------------------------------------------
// Per-unit isolation under concurrency (#423)
// ---------------------------------------------------------------------------
//
// #422 put several units in flight inside one row and left them sharing
// everything below the row: one lease owner, one directory per kind, one
// inherited stdout. These are the tests that they no longer do.

describe("per-unit isolation under concurrency", () => {
  test("two units of one row never both hold a worktree; the second is skipped", async () => {
    // Both declare `worktree`, so both want the one engine-named workspace
    // tree — the collision the row's `concurrency` used to make possible.
    const gated = gatedKind({
      refs: [1, 2],
      workspace: "worktree",
      onRun: (_ref, ctx) => void ctx.workspace.dir,
    });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 2 });
    const loop = engine.loop();
    await settle();

    expect(gated.started).toEqual(["u:1", "u:2"]);
    // The second says whose tree it is, so an operator reading the log knows
    // what it is waiting for rather than just that something went wrong.
    expect(
      engine.lines.some(
        (line) => line.includes("Skipped gated u:2") && line.includes("work#gated:u%3A1"),
      ),
    ).toBe(true);
    // Skipped, not failed: the unit comes back next cycle.
    expect(engine.lines.some((line) => line.includes("Failed executing"))).toBe(false);

    engine.drain.request();
    await gated.release("u:1");
    await loop;
  });

  test("the surviving unit keeps its tree: nobody removed it out from under it", async () => {
    const worktreeCalls: string[][] = [];
    const gated = gatedKind({
      refs: [1, 2],
      workspace: "worktree",
      onRun: (_ref, ctx) => void ctx.workspace.dir,
    });
    const engine = concurrentEngine({
      kinds: [gated],
      concurrency: 2,
      git: (base) => (args, opts) => {
        if (args[0] === "worktree") worktreeCalls.push([...args]);
        return base(args, opts);
      },
    });
    const loop = engine.loop();
    await settle();

    // u:1's own preparation clears whatever a killed predecessor left, then
    // takes the lease. What must not happen is anything after that, which is
    // where the old teardown's recursive delete would have taken the tree apart.
    const afterLease = worktreeCalls.slice(
      worktreeCalls.findIndex((args) => args[1] === "lock") + 1,
    );
    expect(afterLease.filter((args) => args[1] === "remove" || args[1] === "unlock")).toEqual([]);

    engine.drain.request();
    await gated.release("u:1");
    await loop;
    // And the release happened once u:1 was done with it.
    expect(worktreeCalls.filter((args) => args[1] === "remove").length).toBeGreaterThan(1);
  });

  test("two units of one kind write into scratch directories of their own", async () => {
    const dataBase = tenantRoot();
    const dirs = new Map<string, string>();
    const gated = gatedKind({
      refs: [1, 2],
      onRun: (ref, ctx) => {
        dirs.set(ref, ctx.workspace.dir);
        writeFileSync(join(ctx.workspace.dir, "draft.md"), ref);
      },
    });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 2, dataBase });
    const loop = engine.loop();
    await settle();

    expect(dirs.get("u:1")).toBe(join(dataBase, "acme/widget/scratch/gated/u%3A1"));
    expect(dirs.get("u:2")).toBe(join(dataBase, "acme/widget/scratch/gated/u%3A2"));
    // The claim in full: the second unit's preparation did not clear the first
    // unit's work, which one kind-keyed directory would have.
    expect(readdirSync(dirs.get("u:1") ?? "")).toEqual(["draft.md"]);
    expect(readdirSync(dirs.get("u:2") ?? "")).toEqual(["draft.md"]);

    engine.drain.request();
    await gated.release("u:1");
    await gated.release("u:2");
    await loop;
    expect(existsSync(dirs.get("u:1") ?? "")).toBe(false);
    expect(existsSync(dirs.get("u:2") ?? "")).toBe(false);
  });

  test("two units of one kind get read-only trees of their own", async () => {
    const dirs: string[] = [];
    const gated = gatedKind({
      refs: [1, 2],
      workspace: "readonly",
      onRun: (_ref, ctx) => dirs.push(ctx.workspace.dir),
    });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 2 });
    const loop = engine.loop();
    await settle();

    expect(dirs).toEqual([
      "/data/repos/acme/widget/worktrees/readonly/gated/u%3A1",
      "/data/repos/acme/widget/worktrees/readonly/gated/u%3A2",
    ]);

    engine.drain.request();
    await gated.release("u:1");
    await gated.release("u:2");
    await loop;
  });

  // The output half of the same problem: with two units running, a line that
  // says nothing about which unit produced it is a line an operator cannot use.
  test("every git line carries the unit that caused it, and none goes unstamped", async () => {
    const printed: string[] = [];
    const gated = gatedKind({
      refs: [1, 2],
      workspace: "worktree",
      onRun: (_ref, ctx) => void ctx.workspace.dir,
    });
    const engine = concurrentEngine({
      kinds: [gated],
      concurrency: 2,
      // Every unit fetches the clone before it prepares its tree, so both units
      // reach an inheriting git call even though only one gets the tree.
      git: (base) => (args, opts) => {
        if (args[0] === "fetch") opts?.echo?.("remote: Counting objects: 12, done.");
        return base(args, opts);
      },
    });
    const loop = engine.loop();
    await settle();

    const gitLines = engine.lines.filter((line) => line.includes("Counting objects"));
    expect(gitLines).toContain(
      "[phoebe:acme/widget:work][gated u:1] remote: Counting objects: 12, done.",
    );
    expect(gitLines).toContain(
      "[phoebe:acme/widget:work][gated u:2] remote: Counting objects: 12, done.",
    );
    expect(gitLines.every((line) => line.startsWith("[phoebe:acme/widget:work][gated u:"))).toBe(
      true,
    );

    engine.drain.request();
    await gated.release("u:1");
    await loop;
  });
});

// ---------------------------------------------------------------------------
// Units the engine cannot see: the in-memory quarantine (#424)
// ---------------------------------------------------------------------------

/**
 * A kind whose one unit always hangs, so every pass that admits it ends in a
 * whole-unit timeout. It is the shape #424 exists for: no `github` target, so
 * the label path has nowhere to write and the count lives in the engine's
 * memory instead.
 *
 * `state` is what a test moves — the unit's `revision`, and for the mid-count
 * hand-over the `github` target it gains. `honoursQuarantine` picks between the
 * two kinds the engine has to survive: one that filters `ctx.quarantined` in
 * `select`, and the careless one that does not.
 */
function hangingKind(opts: { name?: string; ref?: string; honoursQuarantine?: boolean } = {}): {
  kind: LoadedCustomKind;
  /** Refs handed to `run`, in admission order — one entry per timed-out pass. */
  started: string[];
  /** What `ctx.quarantined` held at each `select`, oldest first. */
  seen: string[][];
  state: { revision: string | undefined; target: WorkUnitGitHubTarget | undefined };
} {
  const name = opts.name ?? "opaque";
  const ref = opts.ref ?? "thread:1";
  const started: string[] = [];
  const seen: string[][] = [];
  const state: { revision: string | undefined; target: WorkUnitGitHubTarget | undefined } = {
    revision: undefined,
    target: undefined,
  };
  return {
    started,
    seen,
    state,
    kind: {
      name,
      options: undefined,
      definition: {
        name,
        oneShotEligible: true,
        promptFile: `prompts/${name}.md`,
        workspace: "scratch",
        report: {
          noun: `${name} thread(s)`,
          describe: (unit: { ref: string }) => `${name} ${unit.ref}`,
        },
        fetch: () => Promise.resolve({}),
        select: (_gathered: unknown, ctx) => {
          seen.push([...ctx.quarantined]);
          const held = opts.honoursQuarantine === true && ctx.quarantined.has(ref);
          const offer = !held && !ctx.inFlight.has(ref);
          return {
            unit: offer
              ? {
                  ref,
                  ...(state.target ? { github: state.target } : {}),
                  ...(state.revision !== undefined ? { revision: state.revision } : {}),
                }
              : null,
            skipped: held ? [{ reason: "quarantined", count: 1 }] : [],
            total: 1,
          };
        },
        // Never settles: the unit's wall-clock budget is what ends the run.
        run: (unit: { ref: string }) => {
          started.push(unit.ref);
          return new Promise<void>(() => {});
        },
      } as AnyWorkKindDefinition,
    },
  };
}

/**
 * Wait, in real time, until `check` holds. The timeout path races a real timer,
 * so these tests cannot drive it by flushing microtasks the way the rolling
 * top-up ones do.
 */
async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A one-millisecond run budget, and the threshold this suite counts against. */
function quarantineEnv(k: number): NodeJS.ProcessEnv {
  return { PHOEBE_RUN_TIMEOUT_MS: "1", PHOEBE_MAX_UNPRODUCTIVE_RUNS: String(k) };
}

describe("the in-memory quarantine for units with no GitHub target", () => {
  test("K timeouts put the ref in ctx.quarantined, and the next pick is dropped", async () => {
    const hanging = hangingKind();
    const engine = concurrentEngine({ kinds: [hanging], concurrency: 1, env: quarantineEnv(2) });
    const loop = engine.loop();

    await waitUntil(
      () => engine.lines.some((line) => line.includes("quarantined in memory — dropped")),
      "the quarantined pick to be dropped",
    );

    // Two timeouts, and the third pass never reached `run`.
    expect(hanging.started).toEqual(["thread:1", "thread:1"]);
    // The kind was told, on the very pass where it offered the unit anyway.
    expect(hanging.seen.at(-1)).toEqual(["thread:1"]);
    // And the operator is told twice: at the drop, and in the idle report.
    expect(
      engine.lines.some((line) =>
        line.includes("1 opaque thread(s) skipped (quarantined in memory)."),
      ),
    ).toBe(true);

    engine.drain.request();
    await loop;
  });

  test("a kind honouring ctx.quarantined stops offering the unit itself", async () => {
    const hanging = hangingKind({ honoursQuarantine: true });
    const engine = concurrentEngine({ kinds: [hanging], concurrency: 1, env: quarantineEnv(2) });
    const loop = engine.loop();

    await waitUntil(
      () => engine.lines.some((line) => line.includes("1 opaque thread(s) skipped (quarantined).")),
      "the kind's own skip reason",
    );

    expect(hanging.started).toEqual(["thread:1", "thread:1"]);
    // Nothing was dropped at admission: the kind never offered the unit again.
    expect(engine.lines.some((line) => line.includes("quarantined in memory — dropped"))).toBe(
      false,
    );

    engine.drain.request();
    await loop;
  });

  test("the same ref with a different revision is admitted, and its count restarts", async () => {
    const hanging = hangingKind();
    hanging.state.revision = "ts:1";
    const engine = concurrentEngine({ kinds: [hanging], concurrency: 1, env: quarantineEnv(2) });
    const loop = engine.loop();

    const drops = (): number =>
      engine.lines.filter((line) => line.includes("quarantined in memory — dropped")).length;
    await waitUntil(() => drops() === 1, "the quarantined pick to be dropped");
    expect(hanging.started).toHaveLength(2);

    // The thread has a new message: the content advanced, so the count is void.
    hanging.state.revision = "ts:2";
    engine.drain.tick();
    await waitUntil(() => drops() === 2, "the re-admitted unit to reach K again");

    // Two more timeouts before the second quarantine, and the first of them
    // counted as a first: the count started over rather than carrying.
    expect(hanging.started).toHaveLength(4);
    expect(engine.lines.filter((line) => line.includes("timed out 1×"))).toHaveLength(2);

    engine.drain.request();
    await loop;
  });

  test("a ref that gains a GitHub target hands over to the label path at one", async () => {
    const hanging = hangingKind();
    const posted: { id: number; body: string }[] = [];
    const engine = concurrentEngine({
      kinds: [hanging],
      concurrency: 1,
      env: quarantineEnv(5),
      github: {
        prTimeoutInputs: () => ({ comments: [], extraActivityAt: null, baseline: "sha:abc" }),
        postUnitComment: (target, body) => posted.push({ id: target.id, body }),
      },
    });
    const loop = engine.loop();

    await waitUntil(() => hanging.started.length >= 2, "the timeouts with no target");

    // The unit's PR now exists, so the label path owns the write half from here.
    hanging.state.target = { objectType: "pr", id: 7 };
    engine.drain.tick();
    await waitUntil(() => posted.length > 0, "the first timeout marker");

    expect(posted[0]).toEqual({ id: 7, body: buildUnitTimeoutMarker(1) });
    // The in-memory entry went with it: nothing carried over, and the ref never
    // reached the threshold, so `ctx.quarantined` stayed empty throughout.
    expect(hanging.seen.every((refs) => refs.length === 0)).toBe(true);

    engine.drain.request();
    await loop;
  });
});

describe("the idle report prints only on change", () => {
  test("the first idle pass after activity prints; an unchanged one stays silent", async () => {
    const gated = gatedKind({ refs: [1] });
    const engine = concurrentEngine({ kinds: [gated], concurrency: 1 });
    const loop = engine.loop();
    await settle();
    expect(gated.started).toEqual(["u:1"]);

    const idleLines = (): string[] =>
      engine.lines.filter((line) => line.includes("No work this cycle — idle."));

    // The unit finishes, and the pass that finds nothing left says so.
    await gated.release("u:1");
    await settle();
    expect(idleLines()).toHaveLength(1);

    // Two more quiet passes say nothing: the state has not changed.
    engine.drain.tick();
    await settle();
    engine.drain.tick();
    await settle();
    expect(idleLines()).toHaveLength(1);

    // Work, then quiet again — and the same report is due once more.
    gated.offer(2);
    engine.drain.tick();
    await settle();
    expect(gated.started).toEqual(["u:1", "u:2"]);
    await gated.release("u:2");
    await settle();
    expect(idleLines()).toHaveLength(2);

    engine.drain.request();
    await loop;
  });

  test("a changed skip set prints again", async () => {
    const reason = { text: "waiting on the reporter" };
    const kind: LoadedCustomKind = {
      name: "digest",
      options: undefined,
      definition: {
        name: "digest",
        oneShotEligible: true,
        promptFile: "prompts/digest.md",
        workspace: "scratch",
        report: { noun: "digest(s)", describe: () => "digest" },
        fetch: () => Promise.resolve({}),
        select: () => ({ unit: null, skipped: [{ reason: reason.text, count: 1 }], total: 0 }),
        run: () => Promise.resolve(),
      } as AnyWorkKindDefinition,
    };
    const engine = concurrentEngine({ kinds: [{ kind }], concurrency: 1 });
    const loop = engine.loop();
    await settle();

    const skips = (): string[] => engine.lines.filter((line) => line.includes("digest(s) skipped"));
    expect(skips()).toHaveLength(1);

    engine.drain.tick();
    await settle();
    expect(skips()).toHaveLength(1);

    // The kind's own words changed, so the report is worth printing again.
    reason.text = "the reporter answered";
    engine.drain.tick();
    await settle();
    expect(skips()).toHaveLength(2);
    expect(skips().at(-1)).toContain("1 digest(s) skipped (the reporter answered).");

    engine.drain.request();
    await loop;
  });
});
