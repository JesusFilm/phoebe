import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber } from "./branded.ts";
import {
  findBlockedDependents,
  getMergedBlockerPrNumbers,
  ghStackExtensionInstallArgs,
  issueBlockers,
  issueBranch,
  mergeBlockerNumbers,
  nativeStackGitConfig,
  parseBlockedBy,
  resolveStackedPrPlan,
  resolveWorktreeBase,
  selectStackRetargetCandidates,
  shouldSkipStackedFix,
  stackedCatchUpRetractionComment,
  stackedPrComment,
  stackRetargetedComment,
  type BlockerConfig,
  type BlockerPrState,
  type Issue,
  type StackConfig,
} from "./stack.ts";

function issue(overrides: Partial<Issue> & Pick<Issue, "number">): Issue {
  return {
    title: `Issue ${overrides.number}`,
    body: "",
    labels: ["ready-for-agent"],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const defaultBlockerConfig: BlockerConfig = {
  blockedByPattern: String.raw`Blocked by\s+#(\d+)`,
  blockerSource: "body",
};

const defaultStackConfig: StackConfig = {
  ...defaultBlockerConfig,
  branchPrefix: "phoebe/",
  stackMode: "banner",
};

describe("parseBlockedBy", () => {
  const pattern = defaultBlockerConfig.blockedByPattern;

  test("parses Blocked by #N from body", () => {
    expect(parseBlockedBy(pattern, "Blocked by #98\n\n## Summary")).toEqual([98]);
  });

  test("deduplicates multiple refs", () => {
    expect(parseBlockedBy(pattern, "Blocked by #98\nBlocked by #98")).toEqual([98]);
  });

  test("returns empty when no blockers", () => {
    expect(parseBlockedBy(pattern, "No blockers here")).toEqual([]);
  });
});

describe("mergeBlockerNumbers", () => {
  test("body mode ignores native blockers (reproduces today's behavior)", () => {
    expect(mergeBlockerNumbers([98], [42], "body")).toEqual([98]);
    expect(mergeBlockerNumbers([], [42], "body")).toEqual([]);
  });

  test("native mode ignores body blockers", () => {
    expect(mergeBlockerNumbers([98], [42], "native")).toEqual([42]);
  });

  test("both mode unions and deduplicates, body refs first", () => {
    expect(mergeBlockerNumbers([98, 7], [7, 42], "both")).toEqual([98, 7, 42]);
  });

  test("empty native result leaves body blockers untouched under both", () => {
    expect(mergeBlockerNumbers([98], [], "both")).toEqual([98]);
  });

  test("empty native result yields nothing under native", () => {
    expect(mergeBlockerNumbers([98], [], "native")).toEqual([]);
  });
});

describe("issueBlockers", () => {
  test("body source ignores native", () => {
    expect(
      issueBlockers(
        issue({ number: 1, body: "Blocked by #98" }),
        { ...defaultBlockerConfig, blockerSource: "body" },
        [42],
      ),
    ).toEqual([98]);
  });

  test("native source uses native blockers, not the body regex", () => {
    expect(
      issueBlockers(
        issue({ number: 1, body: "Blocked by #98" }),
        { ...defaultBlockerConfig, blockerSource: "native" },
        [42],
      ),
    ).toEqual([42]);
  });

  test("both source unions body and native, deduplicated", () => {
    expect(
      issueBlockers(
        issue({ number: 1, body: "Blocked by #98" }),
        { ...defaultBlockerConfig, blockerSource: "both" },
        [98, 42],
      ),
    ).toEqual([98, 42]);
  });
});

describe("resolveWorktreeBase", () => {
  const emptyStates = new Map<number, BlockerPrState>();

  test("PHOEBE_BASE overrides everything", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    expect(
      resolveWorktreeBase(blocked, emptyStates, "feature/custom", [], defaultStackConfig),
    ).toEqual({
      worktreeBase: "feature/custom",
      stacked: false,
    });
  });

  test("unblocked issues base off origin/main", () => {
    expect(
      resolveWorktreeBase(issue({ number: 108 }), emptyStates, undefined, [], defaultStackConfig),
    ).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
  });

  test("stacks on blocker remote tip when blocker PR is open", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states, undefined, [], defaultStackConfig)).toEqual({
      worktreeBase: `origin/${issueBranch("phoebe/", 98)}`,
      stacked: true,
      blockerIssueNumber: 98,
      blockerPrNumber: 104,
    });
  });

  test("uses origin/main when blocker PR merged", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([[98, { hasOpenPr: false, hasMergedPr: true }]]);
    expect(resolveWorktreeBase(blocked, states, undefined, [], defaultStackConfig)).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
  });

  test("skips when blocked with no open or merged blocker PR", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states, undefined, [], defaultStackConfig)).toBeNull();
  });

  test("skips when blocker state is unknown", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    expect(resolveWorktreeBase(blocked, emptyStates, undefined, [], defaultStackConfig)).toBeNull();
  });

  test("stacks on a native blocker (no body ref) under native source", () => {
    const blocked = issue({ number: 102, body: "## Blocked by\n\n- #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    expect(
      resolveWorktreeBase(blocked, states, undefined, [98], {
        ...defaultStackConfig,
        blockerSource: "native",
      }),
    ).toEqual({
      worktreeBase: `origin/${issueBranch("phoebe/", 98)}`,
      stacked: true,
      blockerIssueNumber: 98,
      blockerPrNumber: 104,
    });
  });

  test("native blockers are ignored under the default body source", () => {
    // Body has no ref, so a native-only blocker must not gate the base in body mode.
    const blocked = issue({ number: 102, body: "no body ref here" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states, undefined, [98], defaultStackConfig)).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
  });

  test("stackMode 'off' honors the blocker for the skip decision but never stacks", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const offConfig: StackConfig = { ...defaultStackConfig, stackMode: "off" };
    const open = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    // Open blocker PR: base off main, not the blocker branch — and not skipped.
    expect(resolveWorktreeBase(blocked, open, undefined, [], offConfig)).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
    // No blocker PR at all: still skipped, exactly as the other modes.
    const none = new Map<number, BlockerPrState>([[98, { hasOpenPr: false, hasMergedPr: false }]]);
    expect(resolveWorktreeBase(blocked, none, undefined, [], offConfig)).toBeNull();
  });

  test("stackMode 'native' cuts the branch off the blocker tip, same as banner", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    expect(
      resolveWorktreeBase(blocked, states, undefined, [], {
        ...defaultStackConfig,
        stackMode: "native",
      }),
    ).toEqual({
      worktreeBase: `origin/${issueBranch("phoebe/", 98)}`,
      stacked: true,
      blockerIssueNumber: 98,
      blockerPrNumber: 104,
    });
  });

  describe("multi-blocker (#13)", () => {
    test("skips when any blocker has no PR at all yet, even if others are open", () => {
      const blocked = issue({ number: 102, body: "Blocked by #98\nBlocked by #99" });
      const states = new Map<number, BlockerPrState>([
        [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
        [99, { hasOpenPr: false, hasMergedPr: false }],
      ]);
      expect(resolveWorktreeBase(blocked, states, undefined, [], defaultStackConfig)).toBeNull();
    });

    test("bases off main once every blocker has merged", () => {
      const blocked = issue({ number: 102, body: "Blocked by #98\nBlocked by #99" });
      const states = new Map<number, BlockerPrState>([
        [98, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(104) }],
        [99, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(105) }],
      ]);
      expect(resolveWorktreeBase(blocked, states, undefined, [], defaultStackConfig)).toEqual({
        worktreeBase: "origin/main",
        stacked: false,
      });
    });

    test("stacks on the still-unmerged blocker when one of two has merged", () => {
      const blocked = issue({ number: 102, body: "Blocked by #98\nBlocked by #99" });
      const states = new Map<number, BlockerPrState>([
        [98, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(104) }],
        [99, { hasOpenPr: true, openPrNumber: asPrNumber(107), hasMergedPr: false }],
      ]);
      expect(resolveWorktreeBase(blocked, states, undefined, [], defaultStackConfig)).toEqual({
        worktreeBase: `origin/${issueBranch("phoebe/", 99)}`,
        stacked: true,
        blockerIssueNumber: 99,
        blockerPrNumber: 107,
      });
    });

    test("stacks on the last-listed unmerged blocker when several are still open", () => {
      const blocked = issue({ number: 102, body: "Blocked by #98\nBlocked by #99" });
      const states = new Map<number, BlockerPrState>([
        [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
        [99, { hasOpenPr: true, openPrNumber: asPrNumber(107), hasMergedPr: false }],
      ]);
      expect(resolveWorktreeBase(blocked, states, undefined, [], defaultStackConfig)).toEqual({
        worktreeBase: `origin/${issueBranch("phoebe/", 99)}`,
        stacked: true,
        blockerIssueNumber: 99,
        blockerPrNumber: 107,
      });
    });

    test("skips when one blocker's state is entirely unknown", () => {
      const blocked = issue({ number: 102, body: "Blocked by #98\nBlocked by #99" });
      const states = new Map<number, BlockerPrState>([
        [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
      ]);
      expect(resolveWorktreeBase(blocked, states, undefined, [], defaultStackConfig)).toBeNull();
    });
  });
});

describe("resolveStackedPrPlan", () => {
  const stacked = { stacked: true as const, blockerIssueNumber: 98 };
  const unstacked = { stacked: false as const };

  test("banner: base=main, banner on, no stack link (today's behavior)", () => {
    expect(
      resolveStackedPrPlan({
        issueNumber: 102,
        resolution: stacked,
        stackMode: "banner",
        defaultBranch: "main",
        branchPrefix: "phoebe/",
      }),
    ).toEqual({ prBase: "main", includeBanner: true, stackLink: null });
  });

  test("native: base=blocker branch, no banner, bottom-to-top stack link pair", () => {
    expect(
      resolveStackedPrPlan({
        issueNumber: 102,
        resolution: stacked,
        stackMode: "native",
        defaultBranch: "main",
        branchPrefix: "phoebe/",
      }),
    ).toEqual({
      prBase: issueBranch("phoebe/", 98),
      includeBanner: false,
      stackLink: {
        predecessor: issueBranch("phoebe/", 98),
        successor: issueBranch("phoebe/", 102),
      },
    });
  });

  test("unstacked resolution (off / unblocked / PHOEBE_BASE): base=main, no banner, no link", () => {
    for (const stackMode of ["banner", "native", "off"] as const) {
      expect(
        resolveStackedPrPlan({
          issueNumber: 102,
          resolution: unstacked,
          stackMode,
          defaultBranch: "main",
          branchPrefix: "phoebe/",
        }),
      ).toEqual({ prBase: "main", includeBanner: false, stackLink: null });
    }
  });

  test("honors a non-default defaultBranch for the base", () => {
    expect(
      resolveStackedPrPlan({
        issueNumber: 102,
        resolution: unstacked,
        stackMode: "banner",
        defaultBranch: "trunk",
        branchPrefix: "phoebe/",
      }).prBase,
    ).toBe("trunk");
  });
});

describe("native-stack tooling argv builders", () => {
  test("git config presets remote.pushDefault and rerere.enabled", () => {
    expect(nativeStackGitConfig()).toEqual([
      ["config", "remote.pushDefault", "origin"],
      ["config", "rerere.enabled", "true"],
    ]);
  });

  test("extension install targets github/gh-stack", () => {
    expect(ghStackExtensionInstallArgs()).toEqual(["extension", "install", "github/gh-stack"]);
  });
});

describe("stackedPrComment", () => {
  test("names blocker issue and PR with do-not-merge warning", () => {
    const comment = stackedPrComment(98, asPrNumber(104));
    expect(comment).toContain("#98");
    expect(comment).toContain("PR #104");
    expect(comment).toContain("Do not merge");
  });
});

describe("shouldSkipStackedFix", () => {
  test("skips when blocker PR is still open", () => {
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(
      shouldSkipStackedFix("Blocked by #108", states, defaultBlockerConfig.blockedByPattern),
    ).toBe(true);
  });

  test("does not skip when blocker PR merged", () => {
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
    ]);
    expect(
      shouldSkipStackedFix("Blocked by #108", states, defaultBlockerConfig.blockedByPattern),
    ).toBe(false);
  });
});

describe("getMergedBlockerPrNumbers", () => {
  test("returns every merged blocker PR number in stack order", () => {
    const states = new Map<number, BlockerPrState>([
      [100, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(110) }],
      [101, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(111) }],
      [102, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(
      getMergedBlockerPrNumbers(
        "Blocked by #100\nBlocked by #101\nBlocked by #102",
        states,
        defaultBlockerConfig.blockedByPattern,
      ),
    ).toEqual([110, 111]);
  });

  test("returns empty when no blockers merged", () => {
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(
      getMergedBlockerPrNumbers("Blocked by #108", states, defaultBlockerConfig.blockedByPattern),
    ).toEqual([]);
  });
});

describe("stackedCatchUpRetractionComment", () => {
  test("retracts single-blocker banner", () => {
    const comment = stackedCatchUpRetractionComment([asPrNumber(112)]);
    expect(comment).toContain("#112");
    expect(comment).toContain("independently mergeable");
  });

  test("names all blockers for multi-blocker stacks", () => {
    const comment = stackedCatchUpRetractionComment([asPrNumber(110), asPrNumber(111)]);
    expect(comment).toContain("#110");
    expect(comment).toContain("#111");
  });
});

describe("selectStackRetargetCandidates", () => {
  test("selects a PR based on a blocker branch whose PR has merged", () => {
    const prs = [{ prNumber: asPrNumber(200), baseRefName: issueBranch("phoebe/", 98) }];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(104) }],
    ]);
    expect(selectStackRetargetCandidates(prs, states, "phoebe/")).toEqual(prs);
  });

  test("ignores a PR based on a blocker branch whose PR is still open", () => {
    const prs = [{ prNumber: asPrNumber(200), baseRefName: issueBranch("phoebe/", 98) }];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    expect(selectStackRetargetCandidates(prs, states, "phoebe/")).toEqual([]);
  });

  test("ignores a PR already based on defaultBranch (not a stack branch)", () => {
    const prs = [{ prNumber: asPrNumber(200), baseRefName: asBranchRef("main") }];
    const states = new Map<number, BlockerPrState>();
    expect(selectStackRetargetCandidates(prs, states, "phoebe/")).toEqual([]);
  });

  test("ignores a PR whose base blocker has no known state", () => {
    const prs = [{ prNumber: asPrNumber(200), baseRefName: issueBranch("phoebe/", 98) }];
    expect(selectStackRetargetCandidates(prs, new Map(), "phoebe/")).toEqual([]);
  });
});

describe("stackRetargetedComment", () => {
  test("names the default branch", () => {
    const comment = stackRetargetedComment("main");
    expect(comment).toContain("`main`");
    expect(comment).toContain("retargeted");
  });
});

describe("findBlockedDependents (#22)", () => {
  test("finds open issues that name the quarantined issue as a body blocker", () => {
    const issues = [
      issue({ number: 763, body: "Blocked by #784" }),
      issue({ number: 700, body: "Blocked by #784\nAlso relates to #1" }),
      issue({ number: 900, body: "unrelated" }),
    ];
    expect(findBlockedDependents(784, issues, defaultBlockerConfig)).toEqual([763, 700]);
  });

  test("finds dependents via native blockers", () => {
    const issues = [issue({ number: 50, body: "no body refs" })];
    const nativeBlockersByIssue = new Map([[50, [784]]]);
    expect(
      findBlockedDependents(
        784,
        issues,
        { ...defaultBlockerConfig, blockerSource: "native" },
        nativeBlockersByIssue,
      ),
    ).toEqual([50]);
  });

  test("excludes the issue itself even if self-referential", () => {
    const issues = [issue({ number: 784, body: "Blocked by #784" })];
    expect(findBlockedDependents(784, issues, defaultBlockerConfig)).toEqual([]);
  });

  test("empty when nothing depends on it", () => {
    const issues = [issue({ number: 1, body: "" })];
    expect(findBlockedDependents(784, issues, defaultBlockerConfig)).toEqual([]);
  });
});
