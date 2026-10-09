// The janitors' shared PR walk, and the one thing it asks per kind (#655).
//
// The cycle lists the union of every janitor's `prScope`, so the narrowing has
// to happen here or a kind would work the PRs another kind widened for. These
// tests drive `collectPrCandidates` directly, which is the seam all three kinds
// reach the listing through.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "../branded.ts";
import { resolveConfig, type WorkKindsField } from "../config-schema.ts";
import type { OpenPhoebePr } from "../github-client.ts";
import { collectPrCandidates } from "./pr-stack.ts";
import type { WorkKindCtx } from "./definition.ts";

const LISTED: readonly OpenPhoebePr[] = [
  { number: asPrNumber(1), headRefName: asBranchRef("phoebe/issue-1"), authorLogin: "phoebe-bot" },
  {
    number: asPrNumber(2),
    headRefName: asBranchRef("renovate/lodash-4.x"),
    authorLogin: "renovate[bot]",
  },
];

function ctxFor(opts: { kind: string; workKinds?: WorkKindsField; env?: NodeJS.ProcessEnv }): {
  ctx: WorkKindCtx;
  mergeInfoFor: number[];
} {
  const mergeInfoFor: number[] = [];
  const config = resolveConfig({
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...(opts.workKinds === undefined ? {} : { workKinds: opts.workKinds }),
  });
  const ctx = {
    kind: opts.kind,
    config,
    env: opts.env ?? {},
    github: {
      openPrs: () => LISTED,
      mergeInfo: (prNumber: number) => {
        mergeInfoFor.push(Number(prNumber));
        return Promise.resolve({
          number: prNumber,
          headRefName: asBranchRef("x"),
          headRefOid: asSha("a".padEnd(40, "0")),
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        });
      },
    },
    log: () => {},
  } as unknown as WorkKindCtx;
  return { ctx, mergeInfoFor };
}

const walk = async (ctx: WorkKindCtx): Promise<number[]> =>
  await collectPrCandidates(ctx, (_info, pr) => Number(pr.number));

describe("one kind's slice of the cycle's open PRs", () => {
  test("a kind on the tenant's default sees only the tenant's branches", async () => {
    const { ctx } = ctxFor({ kind: "checks" });
    expect(await walk(ctx)).toEqual([1]);
  });

  test("the kind that widened its own prScope is the only one that sees the widening", async () => {
    const workKinds: WorkKindsField = { checks: { prScope: ["renovate/"] } };
    expect(await walk(ctxFor({ kind: "checks", workKinds }).ctx)).toEqual([2]);
    expect(await walk(ctxFor({ kind: "conflicts", workKinds }).ctx)).toEqual([1]);
    expect(await walk(ctxFor({ kind: "reviews", workKinds }).ctx)).toEqual([1]);
  });

  test("a PR this kind does not admit costs it no merge-info read", async () => {
    const { ctx, mergeInfoFor } = ctxFor({
      kind: "checks",
      workKinds: { checks: { prScope: ["renovate/"] } },
    });
    await walk(ctx);
    expect(mergeInfoFor).toEqual([2]);
  });

  test("the per-kind env name narrows the walk too", async () => {
    const { ctx } = ctxFor({
      kind: "checks",
      workKinds: { checks: { prScope: ["renovate/"] } },
      env: { PHOEBE_CHECKS_PR_SCOPE: "all" },
    });
    expect(await walk(ctx)).toEqual([1, 2]);
  });
});
