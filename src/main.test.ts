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
// answers the two commands the selection path issues — `fetch origin` and
// `rev-parse origin/<branch>` — and records every call, so "no worktree, no
// push" is an assertion rather than a hope.

import { describe, expect, test } from "vite-plus/test";
import { asPrNumber, asSha, type PrNumber, type Sha } from "./branded.ts";
import { resolveConfig, type PhoebeUserConfig } from "./config-schema.ts";
import type { GitRunner } from "./git-model.ts";
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
import { buildQuarantineBaselineMarker, buildUnstickComment } from "./quarantine.ts";
import { createEngine, type EngineRunOptions } from "./main.ts";
import type { UnitRef } from "./unit-event.ts";
import type { AnyWorkKindDefinition } from "./work-kinds/definition.ts";
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
        headRefName: issueBranch(pr.issueNumber),
        authorLogin: pr.authorLogin === undefined ? PHOEBE_LOGIN : pr.authorLogin,
      })),
    mergeInfo: (prNumber) => {
      const pr = byNumber(prNumber);
      return Promise.resolve({
        number: asPrNumber(pr.number),
        headRefName: issueBranch(pr.issueNumber),
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
function stubGit(shas: Record<string, Sha>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push([...args]);
    if (args[0] === "fetch") return "";
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
}): Promise<CycleResult> {
  const { git, calls: gitCalls } = stubGit(opts.shas ?? {});
  const events: UnitRef[] = [];
  const config = resolveConfig({ ...minimalUser(), ...opts.config });
  const engine = createEngine({
    config,
    registry: buildRegistry(config, opts.customKinds ?? []),
    env: opts.env ?? {},
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
  return result.lines.find((line) => line.startsWith("[phoebe] Would execute:"));
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

    expect(selection(result)).toBe("[phoebe] Would execute: issue #7 — base origin/main.");
  });

  test("research: the workable research ticket wins the cycle", async () => {
    const result = await runCycle({
      config: { workOrder: ["research"] },
      github: { listResearchIssues: () => [anIssue(9)] },
    });

    expect(selection(result)).toBe(
      "[phoebe] Would execute: research ticket #9 — base origin/main.",
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
      `[phoebe] Would execute: conflict fix for PR #21 (${issueBranch(7)}).`,
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
      `[phoebe] Would execute: checks fix for PR #22 (${issueBranch(8)}).`,
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
      `[phoebe] Would execute: review feedback for PR #23 (${issueBranch(9)}).`,
    );
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
      `[phoebe] Would execute: review feedback for PR #23 (${issueBranch(9)}).`,
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
      `[phoebe] Would execute: conflict fix for PR #21 (${issueBranch(7)}).`,
    );
  });

  test("a reordered workOrder picks a different kind from the same world", async () => {
    const result = await runCycle({
      config: { workOrder: ["issues", "research", "conflicts", "checks", "reviews"] },
      shas: { main: MAIN_HEAD },
      github: contestedWorld(),
    });

    expect(selection(result)).toBe("[phoebe] Would execute: issue #30 — base origin/main.");
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
      "[phoebe] 1 needs-robot issue(s) but none workable this cycle (waiting on blockers #10).",
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
      "[phoebe] 1 conflicting PR(s) skipped (unchanged failure watermark).",
    );
    expect(result.lines).toContain("[phoebe] 1 conflicting PR(s) but none fixable this cycle.");
  });

  test("conflicts: the same PR is workable once git says main has moved", async () => {
    const result = await runCycle({
      config: { workOrder: ["conflicts"] },
      shas: { main: MAIN_HEAD_MOVED },
      github: { ...prWorld([conflictedPr]), issueBody: () => "" },
    });

    expect(selection(result)).toBe(
      `[phoebe] Would execute: conflict fix for PR #21 (${issueBranch(7)}).`,
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
      "[phoebe] 1 failing-CI PR(s) skipped (conflicting, stacked, or watermarked).",
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
      `[phoebe] Would execute: checks fix for PR #22 (${issueBranch(8)}).`,
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
      "[phoebe] 1 conflicting PR(s) skipped (stacked on open blocker).",
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
      "[phoebe] 1 failing-CI PR(s) skipped (conflicting, stacked, or watermarked).",
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
      "[phoebe] 1 conflicting PR(s) skipped (stacked on open blocker).",
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
      "[phoebe] 1 conflicting PR(s) skipped (stacked on open blocker).",
    );
    expect(result.lines).toContain("[phoebe] 1 conflicting PR(s) but none fixable this cycle.");
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
      "[phoebe] 1 ready-for-agent issue(s) but none workable this cycle (waiting on blockers #11).",
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

    expect(result.lines).toContain("[phoebe] No work this cycle — idle.");
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
    expect(result.lines).toContain("[phoebe] No work this cycle — idle.");
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
      "[phoebe] Un-quarantined issue #7 — its content advanced past the quarantine baseline.",
    );
  });

  test("a unit whose content has not moved keeps its label", async () => {
    // Every write method is unstubbed, so touching this unit at all would throw.
    const result = await sweepCycle({
      listQuarantinedIssues: () => [quarantined(7, "body:same", "body:same")],
      listQuarantinedPrs: () => [],
    });

    expect(result.lines).toContain(RUN_ONCE_NOTHING_MESSAGE);
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
      "[phoebe] Un-quarantined issue #7 — tenant is disabled; cleared so it starts fresh when re-enabled.",
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
    expect(result.lines).toContain(RUN_ONCE_NOTHING_MESSAGE);
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
      `[phoebe] Would execute: conflict fix for PR #21 (${issueBranch(7)}).`,
    );
    // No worktree, no push: discovery reads origin and nothing else. Every
    // GitHub write is unstubbed, so one attempted comment would have thrown.
    expect(result.gitCalls.map((args) => args[0])).toEqual(["fetch", "rev-parse"]);
    // Nothing was started, so nothing was observed as started.
    expect(result.events).toEqual([]);
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

    expect(selection(result)).toBe("[phoebe] Would execute: stale-PR nudge for PR #44.");
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
    expect(result.lines).toContain("[phoebe] 2 stale PR(s) skipped (already nudged).");
    expect(result.lines).toContain("[phoebe] 2 stale PR(s) but none workable this cycle.");
  });

  test("workOrder rejects a kind nobody registered", async () => {
    await expect(runCycle({ config: { workOrder: ["nudge"] }, github: {} })).rejects.toThrow(
      /Unknown work kind "nudge"/,
    );
  });
});
