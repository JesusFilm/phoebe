// `phoebe bench select` (#939): which merged PRs qualify as fixtures, the reason
// each one that does not is skipped, and the `baseSha` a replay checks out.
//
// GitHub is `stubGitHub` declaring only the reads selection makes, so a write
// anywhere in the path throws at its callsite. The git side runs against real
// temp repos; like src/git-model.test.ts it runs no live transport, so the
// "fetch" a hub clone needs is simulated by pointing the hub at the origin's
// object store.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  computeBaseSha,
  issueNumberFromBranch,
  issueSnapshot,
  selectSuite,
  skipReason,
  type BenchSelectConfig,
} from "./bench-select.ts";
import { asBranchRef, asPrNumber, asSha } from "./branded.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import type { BenchIssueFacts, BenchPrFacts, MergedPrRef } from "./github-client.ts";
import { stubGitHub } from "./github-stub.ts";

const CONFIG: BenchSelectConfig = {
  repoSlug: "acme/widget",
  defaultBranch: "main",
  branchPrefix: "phoebe/",
  researchLabel: "wayfinder:research",
};

const PHOEBE = { authorName: "Phoebe", authorEmail: "1+owner@users.noreply.github.com" };

function prFacts(issue: number, over: Partial<BenchPrFacts> = {}): BenchPrFacts {
  return {
    number: asPrNumber(issue + 100),
    createdAt: "2026-11-02T00:00:00Z",
    merged: true,
    baseRefName: "main",
    headRefName: `phoebe/issue-${issue}`,
    headRefOid: asSha("a".repeat(40)),
    mergeCommitOid: asSha("b".repeat(40)),
    body: `Closes #${issue}\n\nAutomated PR from Phoebe.`,
    closingIssues: [issue],
    commits: [{ oid: asSha("a".repeat(40)), ...PHOEBE }],
    commitsTruncated: false,
    commentBodies: [],
    baseRefChanged: false,
    ...over,
  };
}

function issueFacts(issue: number, over: Partial<BenchIssueFacts> = {}): BenchIssueFacts {
  return {
    number: issue,
    title: `Issue ${issue}`,
    body: `Do thing ${issue}`,
    labels: [],
    labelsEverAdded: ["ready-for-agent", "processing"],
    comments: [
      { body: "context before", createdAt: "2026-11-01T00:00:00Z", authorLogin: "maintainer" },
      { body: "Addressed by Phoebe", createdAt: "2026-11-03T00:00:00Z", authorLogin: "owner" },
    ],
    ...over,
  };
}

function reasonFor(pr: BenchPrFacts, issue: BenchIssueFacts = issueFacts(7)): string | null {
  return skipReason({ issueNumber: 7, pr, issue, config: CONFIG });
}

describe("which PRs qualify", async () => {
  test("a merged issues PR of only Phoebe's commits into the default branch is a fixture", () => {
    expect(reasonFor(prFacts(7))).toBeNull();
  });

  test("a PR into a feature branch is skipped as one", () => {
    expect(reasonFor(prFacts(7, { baseRefName: "phoebe/feature-3" }))).toBe(
      "on a feature branch: PR #107 merged into phoebe/feature-3, not main",
    );
  });

  test("a PR into another issue's branch, or retargeted off one, is stacked", () => {
    expect(reasonFor(prFacts(7, { baseRefName: "phoebe/issue-6" }))).toMatch(/^stacked: /);
    expect(reasonFor(prFacts(7, { baseRefChanged: true }))).toMatch(/^stacked: .*retargeted/);
    expect(
      reasonFor(prFacts(7, { body: "Closes #7\n\nStacked on PR #106 (blocked by #6)." })),
    ).toBe("stacked: PR #107 sat on PR #106");
    expect(
      reasonFor(prFacts(7, { commentBodies: ["⛓️ Blocked by #6 (PR #106). Do not merge"] })),
    ).toBe("stacked: PR #107 waited on #6");
  });

  test("a PR someone else pushed to after Phoebe is skipped, naming the commit", () => {
    const pr = prFacts(7, {
      commits: [
        { oid: asSha("a".repeat(40)), ...PHOEBE },
        {
          oid: asSha("c".repeat(40)),
          authorName: "Pat Maintainer",
          authorEmail: "1+owner@users.noreply.github.com",
        },
      ],
    });
    expect(reasonFor(pr)).toBe(
      "more than one author pushed to PR #107: Phoebe <1+owner@users.noreply.github.com> " +
        "(aaaaaaa) and Pat Maintainer <1+owner@users.noreply.github.com> (ccccccc)",
    );
  });

  test("Phoebe's own later commits — a fix after review, a catch-up merge — keep it", () => {
    const pr = prFacts(7, {
      commits: [
        { oid: asSha("a".repeat(40)), ...PHOEBE },
        { oid: asSha("d".repeat(40)), ...PHOEBE, authorEmail: PHOEBE.authorEmail.toUpperCase() },
      ],
    });
    expect(reasonFor(pr)).toBeNull();
  });

  test("an issue blocked mid-way is skipped, by label or by a run's blocked comment", () => {
    expect(reasonFor(prFacts(7), issueFacts(7, { labelsEverAdded: ["phoebe:blocked"] }))).toBe(
      "blocked mid-way: the issue was labelled phoebe:blocked",
    );
    const comments = [
      {
        body: "I need a decision.\n<!-- phoebe-blocked -->",
        createdAt: "2026-10-30T00:00:00Z",
        authorLogin: "owner",
      },
    ];
    expect(reasonFor(prFacts(7), issueFacts(7, { comments }))).toMatch(/^blocked mid-way: /);
  });

  test("a research ticket, a PR closing other issues, and an unmerged PR are skipped", () => {
    expect(reasonFor(prFacts(7), issueFacts(7, { labels: ["wayfinder:research"] }))).toMatch(
      /research ticket/,
    );
    expect(reasonFor(prFacts(7, { closingIssues: [7, 8] }))).toBe("PR #107 also closes #8");
    expect(reasonFor(prFacts(7, { merged: false, mergeCommitOid: null }))).toBe(
      "PR #107 did not merge",
    );
    expect(reasonFor(prFacts(7, { commitsTruncated: true }))).toMatch(/more commits/);
  });

  test("only <branchPrefix>issue-<n> names an issues unit", () => {
    expect(issueNumberFromBranch("phoebe/", "phoebe/issue-42")).toBe(42);
    expect(issueNumberFromBranch("phoebe/", "phoebe/feature-42")).toBeNull();
    expect(issueNumberFromBranch("phoebe/", "phoebe/issue-42-extra")).toBeNull();
    expect(issueNumberFromBranch("bot.", "botXissue-1")).toBeNull();
  });
});

describe("the issue snapshot", () => {
  test("keeps title and body, and only the comments posted before the PR opened", () => {
    expect(issueSnapshot(issueFacts(7), "2026-11-02T00:00:00Z")).toEqual({
      number: 7,
      title: "Issue 7",
      body: "Do thing 7",
      comments: [
        { author: "maintainer", createdAt: "2026-11-01T00:00:00Z", body: "context before" },
      ],
    });
  });
});

describe("selectSuite", () => {
  const ref = (issue: number, mergedAt: string, pr = issue + 100): MergedPrRef => ({
    number: asPrNumber(pr),
    headRefName: asBranchRef(`phoebe/issue-${issue}`),
    mergedAt,
  });
  const now = () => new Date("2026-11-25T00:00:00Z");

  test("--issues judges each named issue by its one merged PR, and lists every skip", async () => {
    const facts: Record<number, BenchPrFacts> = {
      107: prFacts(7),
      108: prFacts(8, { baseRefName: "phoebe/feature-3" }),
    };
    const merged: Record<string, MergedPrRef[]> = {
      "phoebe/issue-7": [ref(7, "2026-11-04T00:00:00Z")],
      "phoebe/issue-8": [ref(8, "2026-11-04T00:00:00Z")],
      "phoebe/issue-10": [ref(10, "2026-11-04T00:00:00Z", 200), ref(10, "2026-11-01T00:00:00Z")],
    };
    const github = stubGitHub({
      mergedPrsForBranch: (branch) => merged[branch] ?? [],
      benchPrFacts: (pr) => facts[pr]!,
      benchIssueFacts: (issue) => issueFacts(issue),
    });

    const suite = await selectSuite({
      github,
      config: CONFIG,
      request: { by: "issues", issues: [7, 8, 9, 10, 7] },
      baseShaOf: (pr) => `base-of-${pr.number}`,
      baseline: null,
      now,
    });

    expect(suite.v).toBe(1);
    expect(suite.repo).toBe("acme/widget");
    expect(suite.selectedAt).toBe("2026-11-25T00:00:00.000Z");
    expect(suite.selection).toEqual({ by: "issues", issues: [7, 8, 9, 10] });
    expect(suite.fixtures).toEqual([
      {
        issue: {
          number: 7,
          title: "Issue 7",
          body: "Do thing 7",
          comments: [
            { author: "maintainer", createdAt: "2026-11-01T00:00:00Z", body: "context before" },
          ],
        },
        pr: { number: 107, headSha: "a".repeat(40), mergeSha: "b".repeat(40) },
        baseSha: "base-of-107",
      },
    ]);
    expect(suite.skipped).toEqual([
      {
        issue: 8,
        pr: 108,
        reason: "on a feature branch: PR #108 merged into phoebe/feature-3, not main",
      },
      { issue: 9, pr: null, reason: "no merged PR came from phoebe/issue-9" },
      {
        issue: 10,
        pr: null,
        reason: "2 merged PRs came from phoebe/issue-10 (#200, #110); a fixture needs exactly one",
      },
    ]);
  });

  test("the query walks merged issue PRs newest first until --limit fixtures qualify", async () => {
    const listed: Array<{ since: string | null; limit: number }> = [];
    const github = stubGitHub({
      listMergedPrs: (opts) => {
        listed.push(opts);
        return [
          ref(5, "2026-11-06T00:00:00Z"),
          {
            number: asPrNumber(99),
            headRefName: asBranchRef("renovate/foo"),
            mergedAt: "2026-11-05T12:00:00Z",
          },
          ref(4, "2026-11-05T00:00:00Z"),
          ref(3, "2026-11-04T00:00:00Z"),
          ref(2, "2026-11-03T00:00:00Z"),
          ref(1, "2026-11-02T00:00:00Z"),
        ];
      },
      benchPrFacts: (pr) =>
        pr === 104 ? prFacts(4, { baseRefChanged: true }) : prFacts(Number(pr) - 100),
      benchIssueFacts: (issue) => issueFacts(issue),
    });

    const suite = await selectSuite({
      github,
      config: CONFIG,
      request: { by: "query", since: "2026-11-01", limit: 2 },
      baseShaOf: () => "base",
      baseline: null,
      now,
    });

    expect(listed).toEqual([{ since: "2026-11-01", limit: 1000 }]);
    expect(suite.selection).toEqual({ by: "query", since: "2026-11-01", limit: 2 });
    expect(suite.fixtures.map((fixture) => fixture.issue.number)).toEqual([5, 3]);
    expect(suite.skipped).toEqual([
      {
        issue: 4,
        pr: 104,
        reason: "stacked: PR #104 was retargeted onto main after it opened",
      },
    ]);
  });

  test("a PR that cannot be read or pinned is a skip with the reason, not a failed suite", async () => {
    const github = stubGitHub({
      mergedPrsForBranch: (branch) => [
        ref(Number(branch.split("-").at(-1)), "2026-11-04T00:00:00Z"),
      ],
      benchPrFacts: (pr) => {
        if (pr === 101) throw new Error("HTTP 502\nmore detail");
        return prFacts(Number(pr) - 100);
      },
      benchIssueFacts: (issue) => issueFacts(issue),
    });

    const suite = await selectSuite({
      github,
      config: CONFIG,
      request: { by: "issues", issues: [1, 2] },
      baseShaOf: () => {
        throw new Error("fatal: bad object");
      },
      baseline: null,
      now,
    });

    expect(suite.fixtures).toEqual([]);
    expect(suite.skipped).toEqual([
      { issue: 1, pr: 101, reason: "could not read it from GitHub: HTTP 502" },
      {
        issue: 2,
        pr: 102,
        reason: "could not compute baseSha in the hub clone: fatal: bad object",
      },
    ]);
  });

  test("a baseline that fails skips the fixture with the gate; one that passes records when", async () => {
    const github = stubGitHub({
      mergedPrsForBranch: (branch) => [
        ref(Number(branch.split("-").at(-1)), "2026-11-04T00:00:00Z"),
      ],
      benchPrFacts: (pr) => prFacts(Number(pr) - 100),
      benchIssueFacts: (issue) => issueFacts(issue),
    });
    const pass = { command: "c", exitCode: 0, durationMs: 1 };
    const checked: number[] = [];
    const suite = await selectSuite({
      github,
      config: CONFIG,
      request: { by: "issues", issues: [1, 2, 3] },
      baseShaOf: () => "base",
      baseline: (fixture) => {
        checked.push(fixture.issue.number);
        if (fixture.issue.number === 3) return Promise.reject(new Error("fatal: bad object"));
        return Promise.resolve(
          fixture.issue.number === 2
            ? { install: pass, check: pass, test: { command: "t", exitCode: 1, durationMs: 1 } }
            : { install: pass, check: pass, test: pass },
        );
      },
      now,
    });

    expect(checked).toEqual([1, 2, 3]);
    expect(suite.fixtures.map((fixture) => fixture.issue.number)).toEqual([1]);
    expect(suite.fixtures[0]!.baselinePassedAt).toBe("2026-11-25T00:00:00.000Z");
    expect(suite.skipped).toEqual([
      { issue: 2, pr: 102, reason: "its merged PR no longer passes: test exited 1" },
      { issue: 3, pr: 103, reason: "its baseline could not run: fatal: bad object" },
    ]);
  });

  test("a query keeps walking past a fixture whose baseline fails", async () => {
    const github = stubGitHub({
      listMergedPrs: () => [
        ref(3, "2026-11-04T00:00:00Z"),
        ref(2, "2026-11-03T00:00:00Z"),
        ref(1, "2026-11-02T00:00:00Z"),
      ],
      benchPrFacts: (pr) => prFacts(Number(pr) - 100),
      benchIssueFacts: (issue) => issueFacts(issue),
    });
    const pass = { command: "c", exitCode: 0, durationMs: 1 };
    const suite = await selectSuite({
      github,
      config: CONFIG,
      request: { by: "query", since: null, limit: 2 },
      baseShaOf: () => "base",
      baseline: (fixture) =>
        Promise.resolve({
          install: fixture.issue.number === 3 ? { ...pass, exitCode: 2 } : pass,
          check: null,
          test: null,
        }),
      now,
    });
    expect(suite.fixtures.map((fixture) => fixture.issue.number)).toEqual([2, 1]);
    expect(suite.skipped).toEqual([
      { issue: 3, pr: 103, reason: "its merged PR no longer passes: install exited 2" },
    ]);
  });
});

// --- baseSha against real repos ---------------------------------------------

const IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

describe("computeBaseSha", () => {
  let root: string;
  let origin: string;
  let hub: string;

  function commit(file: string): string {
    appendFileSync(join(origin, file), `${file}\n`);
    git(origin, "add", ".");
    git(origin, "commit", "-m", file);
    return git(origin, "rev-parse", "HEAD");
  }

  /** Stand in for the fetch: the hub reads the origin's objects from then on. */
  function fetchingGit(calls: string[][]): GitRunner {
    return (args, opts) => {
      if (args[0] === "fetch") {
        calls.push(args);
        mkdirSync(join(hub, ".git", "objects", "info"), { recursive: true });
        writeFileSync(
          join(hub, ".git", "objects", "info", "alternates"),
          `${join(origin, ".git", "objects")}\n`,
        );
        return "";
      }
      return defaultGit(args, opts);
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phoebe-bench-select-"));
    origin = join(root, "origin");
    hub = join(root, "hub");
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", hub]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a squash merge: baseSha is where the PR branched, fetched when the hub lacks it", () => {
    const start = commit("seed");
    git(origin, "checkout", "-q", "-b", "phoebe/issue-7");
    commit("fix-one");
    const head = commit("fix-two");
    git(origin, "checkout", "-q", "main");
    commit("someone-elses");
    git(origin, "merge", "--squash", "phoebe/issue-7");
    git(origin, "commit", "-m", "Phoebe: fix (#7)");
    const merge = git(origin, "rev-parse", "HEAD");

    const calls: string[][] = [];
    const baseSha = computeBaseSha({
      repoDir: hub,
      prNumber: 107,
      headSha: head,
      mergeSha: merge,
      defaultBranch: "main",
      git: fetchingGit(calls),
    });

    expect(baseSha).toBe(start);
    expect(calls).toEqual([
      ["fetch", "--quiet", "--no-write-fetch-head", "origin", "refs/pull/107/head", "main"],
    ]);
    // The tree the PR started from: the seed, without the branch's work or the
    // commit that landed on main beside it.
    expect(git(hub, "ls-tree", "--name-only", baseSha).split("\n")).toEqual(["seed"]);
  });

  test("a PR that caught up with main starts from the main it last merged", () => {
    commit("seed");
    git(origin, "checkout", "-q", "-b", "phoebe/issue-7");
    commit("fix-one");
    git(origin, "checkout", "-q", "main");
    const caughtUp = commit("landed-meanwhile");
    git(origin, "checkout", "-q", "phoebe/issue-7");
    git(origin, "merge", "-q", "--no-edit", "main");
    const head = commit("fix-two");
    git(origin, "checkout", "-q", "main");
    commit("landed-after");
    git(origin, "merge", "-q", "--no-ff", "--no-edit", "phoebe/issue-7");
    const merge = git(origin, "rev-parse", "HEAD");

    const calls: string[][] = [];
    const baseSha = computeBaseSha({
      repoDir: hub,
      prNumber: 107,
      headSha: head,
      mergeSha: merge,
      defaultBranch: "main",
      git: fetchingGit(calls),
    });

    expect(baseSha).toBe(caughtUp);
    expect(git(hub, "ls-tree", "--name-only", baseSha).split("\n")).toEqual([
      "landed-meanwhile",
      "seed",
    ]);
  });

  test("no fetch when the hub already holds both commits", () => {
    const start = commit("seed");
    git(origin, "checkout", "-q", "-b", "phoebe/issue-7");
    const head = commit("fix");
    git(origin, "checkout", "-q", "main");
    git(origin, "merge", "--squash", "phoebe/issue-7");
    git(origin, "commit", "-m", "squash");
    const merge = git(origin, "rev-parse", "HEAD");

    const calls: string[][] = [];
    const baseSha = computeBaseSha({
      repoDir: origin,
      prNumber: 107,
      headSha: head,
      mergeSha: merge,
      defaultBranch: "main",
      git: fetchingGit(calls),
    });

    expect(baseSha).toBe(start);
    expect(calls).toEqual([]);
  });
});
