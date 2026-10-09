// Per-kind PR scope, through the three janitors themselves (#656).
//
// The point of the field is that the kinds disagree: one listing, holding a
// Phoebe PR and a `renovate/` one, and a tenant that admits the bot's branches
// to `checks` alone. So each kind's `fetch` is driven over the same stub listing
// and asked which PRs it came back with — the narrowing is in the fetch plumbing
// all three share (pr-stack.ts), and this is what pins that each one applies its
// own scope rather than the tenant's.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha, type BranchRef } from "../branded.ts";
import { resolveConfig, type PhoebeUserConfig, type WorkKindsField } from "../config-schema.ts";
import { checksKind } from "./checks.ts";
import { conflictsKind } from "./conflicts.ts";
import { reviewsKind } from "./reviews.ts";
import type { AnyWorkKindDefinition, WorkKindCtx } from "./definition.ts";

const PHOEBE_BRANCH = asBranchRef("phoebe/issue-7");
const RENOVATE_BRANCH = asBranchRef("renovate/npm-vite");

function configWith(over: Partial<PhoebeUserConfig>) {
  return resolveConfig({
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...over,
  });
}

/**
 * One listing, two PRs, and a world each kind would want to work: red CI and an
 * unresolved review thread on both, and a merge state that conflicts for the
 * `conflicts` kind and is clean for the two that refuse a conflicting PR. So
 * whether a kind gathers a PR turns on scope and nothing else.
 */
function ctxFor(
  kind: string,
  opts: { workKinds?: WorkKindsField; prScope?: PhoebeUserConfig["prScope"] },
) {
  const prs = [
    { number: asPrNumber(7), headRefName: PHOEBE_BRANCH, authorLogin: "human" },
    { number: asPrNumber(8), headRefName: RENOVATE_BRANCH, authorLogin: "renovate[bot]" },
  ];
  const mergeInfo = (prNumber: number) => ({
    number: asPrNumber(prNumber),
    headRefName: prs.find((pr) => Number(pr.number) === prNumber)!.headRefName,
    baseRefName: asBranchRef("main"),
    headRefOid: asSha(String(prNumber).padEnd(40, "0")),
    mergeable: kind === "conflicts" ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: kind === "conflicts" ? "DIRTY" : "CLEAN",
  });
  return {
    kind,
    config: configWith({
      ...(opts.prScope !== undefined ? { prScope: opts.prScope } : {}),
      ...(opts.workKinds !== undefined ? { workKinds: opts.workKinds } : {}),
    }),
    options: undefined,
    env: { PHOEBE_GH_LOGIN: "phoebe-bot" },
    cycle: {
      issueBody: () => "",
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: () => null,
    },
    clock: { now: () => new Date(), sleep: () => Promise.resolve() },
    log: () => {},
    inFlight: new Set<string>(),
    quarantined: new Set<string>(),
    github: {
      openPrs: () => prs,
      mergeInfo: (prNumber: number) => Promise.resolve(mergeInfo(prNumber)),
      commitCheckItems: () => [{ workflowName: "ci", status: "completed", conclusion: "failure" }],
      prCommentBodies: () => [],
      reviewThreads: () => [{ id: "t1", isResolved: false, comments: [] }],
      resolveLogin: (login: string | undefined) => login ?? null,
    },
    origin: {
      fetch: () => {},
      branchHead: () => asSha("a".padEnd(40, "0")),
      commitsBehind: () => 0,
    },
  } as unknown as WorkKindCtx;
}

/** The PR numbers a kind's fetch came back with. */
async function gathered(
  kindFor: (config: ReturnType<typeof configWith>) => AnyWorkKindDefinition,
  kind: string,
  opts: { workKinds?: WorkKindsField; prScope?: PhoebeUserConfig["prScope"] } = {},
): Promise<number[]> {
  const ctx = ctxFor(kind, opts);
  const result = (await kindFor(ctx.config).fetch(ctx)) as {
    candidates: readonly { prNumber: number; headRefName: BranchRef }[];
  };
  return result.candidates.map((candidate) => Number(candidate.prNumber));
}

describe("each janitor scans the PRs its own scope admits", () => {
  const CHECKS_ON_RENOVATE: WorkKindsField = { checks: { prScope: ["renovate/"] } };

  test("the kind that names the prefix picks the bot's PR up", async () => {
    expect(await gathered(checksKind, "checks", { workKinds: CHECKS_ON_RENOVATE })).toEqual([8]);
  });

  test("the other two never see it", async () => {
    expect(await gathered(conflictsKind, "conflicts", { workKinds: CHECKS_ON_RENOVATE })).toEqual([
      7,
    ]);
    expect(await gathered(reviewsKind, "reviews", { workKinds: CHECKS_ON_RENOVATE })).toEqual([7]);
  });

  test("a tenant-level list admits the bot's PR to all three", async () => {
    expect(await gathered(checksKind, "checks", { prScope: ["renovate/"] })).toEqual([8]);
    expect(await gathered(conflictsKind, "conflicts", { prScope: ["renovate/"] })).toEqual([8]);
    expect(await gathered(reviewsKind, "reviews", { prScope: ["renovate/"] })).toEqual([8]);
  });

  test("the empty list admits none", async () => {
    expect(await gathered(checksKind, "checks", { prScope: [] })).toEqual([]);
    expect(await gathered(conflictsKind, "conflicts", { prScope: [] })).toEqual([]);
    expect(await gathered(reviewsKind, "reviews", { prScope: [] })).toEqual([]);
  });

  test('the default tenant scope is still "Phoebe\'s branches, and nothing else"', async () => {
    expect(await gathered(checksKind, "checks")).toEqual([7]);
    expect(await gathered(conflictsKind, "conflicts")).toEqual([7]);
    expect(await gathered(reviewsKind, "reviews")).toEqual([7]);
  });

  test("a per-kind env var widens one kind to every same-repo PR", async () => {
    const ctx = ctxFor("reviews", {});
    (ctx.env as Record<string, string>)["PHOEBE_REVIEWS_PR_SCOPE"] = "all";
    const result = (await reviewsKind(ctx.config).fetch(ctx)) as {
      candidates: readonly { prNumber: number }[];
    };
    expect(result.candidates.map((candidate) => Number(candidate.prNumber))).toEqual([7, 8]);
  });
});
