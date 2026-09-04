import { describe, expect, test } from "vite-plus/test";
import { config as sampleUserConfig } from "../phoebe.config.ts";
import { asBranchRef, asPrNumber, asSha, type Sha } from "./branded.ts";
import { resolveConfig } from "./config-schema.ts";
import { config as installedConfig, setResolvedConfig } from "./resolved-config.ts";
import {
  buildChecksFailWatermarkMarker,
  buildConflictFailWatermarkMarker,
  buildInitialPrBody,
  buildReviewsHandledComment,
  buildReviewsHandledMarker,
  checksFixFailureComment,
  classifyPriority,
  compareIssues,
  conflictFixFailureComment,
  followUpPrComment,
  formatFailingChecksForPrompt,
  hasNewNonPhoebeReviewActivity,
  isPhoebeHeadBranch,
  isPrInScope,
  isPrMergeConflicting,
  isReviewSummaryComment,
  issueBranch,
  listFailingChecks,
  newestReviewThreadCommentCreatedAt,
  parseBlockedBy,
  parseChecksFailWatermark,
  parseConflictFailWatermark,
  parseLatestMarker,
  parseReviewsHandledWatermark,
  parseIssueNumberFromBranch,
  resolveWorktreeBase,
  isCompletedBlockerIssue,
  unresolvedBlockerNumbers,
  getMergedBlockerPrNumbers,
  selectConflictFixCandidates,
  selectIssue,
  shouldPostChecksFixFailure,
  statusCheckRollupState,
  validateWorkOrder,
  workflowRunsToCheckItems,
  WORK_KIND_NAMES,
  shouldPostConflictFixFailure,
  shouldSkipStackedChecksFix,
  shouldSkipStackedConflictFix,
  shouldSkipStackedReviewsFix,
  shouldSkipWatermarkChecksFix,
  shouldSkipWatermarkConflictFix,
  stackedCatchUpRetractionComment,
  stackedPrComment,
  type BlockerPrState,
  type ChecksCandidate,
  type ConflictingPrCandidate,
  type Issue,
  type ReviewThread,
  type ReviewsCandidate,
  type StackContext,
  type StatusCheckItem,
  type FeatureLookup,
} from "./orchestrator.ts";
import type { WorkKindCtx } from "./work-kinds/definition.ts";
import { buildRegistry } from "./work-kinds/registry.ts";
import { featureBranch, type Feature } from "./feature-branch.ts";
import { oneShotWorkKinds, selectWorkUnits, type WorkUnitSkip } from "./work-kinds/walk.ts";

function issue(overrides: Partial<Issue> & Pick<Issue, "number">): Issue {
  return {
    title: `Issue ${overrides.number}`,
    body: "",
    labels: ["ready-for-agent"],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("parseBlockedBy", () => {
  test("parses Blocked by #N from body", () => {
    expect(parseBlockedBy("Blocked by #98\n\n## Summary")).toEqual([98]);
  });

  test("deduplicates multiple refs", () => {
    expect(parseBlockedBy("Blocked by #98\nBlocked by #98")).toEqual([98]);
  });

  test("returns empty when no blockers", () => {
    expect(parseBlockedBy("No blockers here")).toEqual([]);
  });
});

describe("classifyPriority", () => {
  test("classifies bug-fix issues highest", () => {
    expect(classifyPriority(issue({ number: 1, title: "Fix crash on startup" }))).toBe("bug");
  });

  test("classifies tracer bullets", () => {
    expect(classifyPriority(issue({ number: 2, title: "Wire API-mode discovery POC" }))).toBe(
      "tracer",
    );
  });

  test("defaults to polish", () => {
    expect(classifyPriority(issue({ number: 3, title: "Add quota resilience" }))).toBe("polish");
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
    expect(compareIssues(bug, polish)).toBeLessThan(0);
    expect(compareIssues(polish, bug)).toBeGreaterThan(0);
  });
});

describe("resolveWorktreeBase", () => {
  const emptyStates = new Map<number, BlockerPrState>();

  test("PHOEBE_BASE overrides everything", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    expect(resolveWorktreeBase(blocked, emptyStates, "feature/custom")).toEqual({
      worktreeBase: "feature/custom",
      stacked: false,
    });
  });

  test("unblocked issues base off origin/main", () => {
    expect(resolveWorktreeBase(issue({ number: 108 }), emptyStates)).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
  });

  test("stacks on blocker remote tip when blocker PR is open", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states)).toEqual({
      worktreeBase: `origin/${issueBranch(98)}`,
      stacked: true,
      blockerIssueNumber: 98,
      blockerPrNumber: 104,
    });
  });

  test("uses origin/main when blocker PR merged", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([[98, { hasOpenPr: false, hasMergedPr: true }]]);
    expect(resolveWorktreeBase(blocked, states)).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
  });

  test("skips when blocked with no open or merged blocker PR", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states)).toBeNull();
  });

  test("skips when blocker state is unknown", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    expect(resolveWorktreeBase(blocked, emptyStates)).toBeNull();
  });

  test("uses origin/main when the blocker issue is closed as completed", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false, blockerCompleted: true }],
    ]);
    expect(resolveWorktreeBase(blocked, states)).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
  });

  test("skips when the blocker issue is closed as not planned", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false, blockerCompleted: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states)).toBeNull();
  });

  test("an open blocker PR still wins over blocker issue closure", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [
        98,
        {
          hasOpenPr: true,
          openPrNumber: asPrNumber(104),
          hasMergedPr: false,
          blockerCompleted: true,
        },
      ],
    ]);
    expect(resolveWorktreeBase(blocked, states)).toEqual({
      worktreeBase: `origin/${issueBranch(98)}`,
      stacked: true,
      blockerIssueNumber: 98,
      blockerPrNumber: 104,
    });
  });

  test("a merged blocker PR still resolves to origin/main and reports its PR number", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(104) }],
    ]);
    expect(resolveWorktreeBase(blocked, states)).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
    expect(getMergedBlockerPrNumbers(blocked.body, states)).toEqual([104]);
  });

  describe("feature arm", () => {
    function liveFeature(issueNumber: number, title = "Feature"): Feature {
      return { issueNumber, title, branch: featureBranch(issueNumber) };
    }

    /** A lookup putting every listed issue in feature #1 and nobody else. */
    function membersOf(feature: Feature, ...memberNumbers: number[]): FeatureLookup {
      const members = new Set(memberNumbers);
      return (issueNumber) => (members.has(issueNumber) ? feature : null);
    }

    const inFeatureOne = (...memberNumbers: number[]): FeatureLookup =>
      membersOf(liveFeature(1), ...memberNumbers);

    test("unblocked member routes onto the feature branch", () => {
      expect(
        resolveWorktreeBase(issue({ number: 10 }), emptyStates, undefined, inFeatureOne(10)),
      ).toEqual({
        worktreeBase: `origin/${featureBranch(1)}`,
        stacked: false,
        featureIssueNumber: 1,
        featureIssueTitle: "Feature",
      });
    });

    test("PHOEBE_BASE wins over the feature arm", () => {
      expect(
        resolveWorktreeBase(issue({ number: 10 }), emptyStates, "custom/base", inFeatureOne(10)),
      ).toEqual({ worktreeBase: "custom/base", stacked: false });
    });

    test("non-member (feature=null) is unaffected — default branch as before", () => {
      expect(
        resolveWorktreeBase(issue({ number: 10 }), emptyStates, undefined, () => null),
      ).toEqual({
        worktreeBase: "origin/main",
        stacked: false,
      });
    });

    describe("blockers across and inside the boundary (#383)", () => {
      const blocked = issue({ number: 10, body: "Blocked by #5" });
      const openBlocker = new Map<number, BlockerPrState>([
        [5, { hasOpenPr: true, openPrNumber: asPrNumber(99), hasMergedPr: false }],
      ]);
      const mergedBlocker = new Map<number, BlockerPrState>([
        [5, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(99) }],
      ]);
      const completedBlocker = new Map<number, BlockerPrState>([
        [5, { hasOpenPr: false, hasMergedPr: false, blockerCompleted: true }],
      ]);

      test("member blocked by a member of the same feature stacks, carrying the feature", () => {
        expect(resolveWorktreeBase(blocked, openBlocker, undefined, inFeatureOne(10, 5))).toEqual({
          worktreeBase: `origin/${issueBranch(5)}`,
          stacked: true,
          blockerIssueNumber: 5,
          blockerPrNumber: 99,
          featureIssueNumber: 1,
          featureIssueTitle: "Feature",
        });
      });

      test("member whose in-feature blocker merged lands on the feature branch", () => {
        expect(resolveWorktreeBase(blocked, mergedBlocker, undefined, inFeatureOne(10, 5))).toEqual(
          {
            worktreeBase: `origin/${featureBranch(1)}`,
            stacked: false,
            featureIssueNumber: 1,
            featureIssueTitle: "Feature",
          },
        );
      });

      test("member whose in-feature blocker closed as completed lands on the feature branch", () => {
        expect(
          resolveWorktreeBase(blocked, completedBlocker, undefined, inFeatureOne(10, 5)),
        ).toEqual({
          worktreeBase: `origin/${featureBranch(1)}`,
          stacked: false,
          featureIssueNumber: 1,
          featureIssueTitle: "Feature",
        });
      });

      test("member blocked by an outside issue with an open PR waits", () => {
        expect(resolveWorktreeBase(blocked, openBlocker, undefined, inFeatureOne(10))).toBeNull();
      });

      test("member proceeds on the feature branch once the outside blocker has merged", () => {
        expect(resolveWorktreeBase(blocked, mergedBlocker, undefined, inFeatureOne(10))).toEqual({
          worktreeBase: `origin/${featureBranch(1)}`,
          stacked: false,
          featureIssueNumber: 1,
          featureIssueTitle: "Feature",
        });
      });

      test("member proceeds once the outside blocker issue is closed as completed", () => {
        expect(resolveWorktreeBase(blocked, completedBlocker, undefined, inFeatureOne(10))).toEqual(
          {
            worktreeBase: `origin/${featureBranch(1)}`,
            stacked: false,
            featureIssueNumber: 1,
            featureIssueTitle: "Feature",
          },
        );
      });

      test("non-member blocked by a member waits, open PR or merged", () => {
        expect(resolveWorktreeBase(blocked, openBlocker, undefined, inFeatureOne(5))).toBeNull();
        expect(resolveWorktreeBase(blocked, mergedBlocker, undefined, inFeatureOne(5))).toBeNull();
        expect(
          resolveWorktreeBase(blocked, completedBlocker, undefined, inFeatureOne(5)),
        ).toBeNull();
      });

      test("members of two different features wait on each other", () => {
        const featureOf: FeatureLookup = (issueNumber) =>
          issueNumber === 10 ? liveFeature(1) : issueNumber === 5 ? liveFeature(2) : null;
        expect(resolveWorktreeBase(blocked, openBlocker, undefined, featureOf)).toBeNull();
        expect(resolveWorktreeBase(blocked, mergedBlocker, undefined, featureOf)).toBeNull();
      });

      test("a retired feature drops both sides back onto the default-branch arm", () => {
        expect(resolveWorktreeBase(blocked, openBlocker, undefined, () => null)).toEqual({
          worktreeBase: `origin/${issueBranch(5)}`,
          stacked: true,
          blockerIssueNumber: 5,
          blockerPrNumber: 99,
        });
      });
    });
  });

  test("uses config.defaultBranch instead of origin/main when configured", () => {
    const previous = { ...installedConfig };
    setResolvedConfig(resolveConfig({ ...sampleUserConfig, defaultBranch: "trunk" }));
    try {
      expect(resolveWorktreeBase(issue({ number: 108 }), emptyStates)).toEqual({
        worktreeBase: "origin/trunk",
        stacked: false,
      });
      const blocked = issue({ number: 102, body: "Blocked by #98" });
      const mergedStates = new Map<number, BlockerPrState>([
        [98, { hasOpenPr: false, hasMergedPr: true }],
      ]);
      expect(resolveWorktreeBase(blocked, mergedStates)).toEqual({
        worktreeBase: "origin/trunk",
        stacked: false,
      });
    } finally {
      setResolvedConfig(previous);
    }
  });
});

describe("isCompletedBlockerIssue", () => {
  test("closed as completed satisfies the blocker", () => {
    expect(isCompletedBlockerIssue({ state: "CLOSED", stateReason: "COMPLETED" })).toBe(true);
  });

  test("closed as not planned does not", () => {
    expect(isCompletedBlockerIssue({ state: "CLOSED", stateReason: "NOT_PLANNED" })).toBe(false);
  });

  test("an open issue does not, whatever the reason field says", () => {
    expect(isCompletedBlockerIssue({ state: "OPEN", stateReason: null })).toBe(false);
    expect(isCompletedBlockerIssue({ state: "OPEN", stateReason: "COMPLETED" })).toBe(false);
  });

  test("tolerates lowercase and missing reason", () => {
    expect(isCompletedBlockerIssue({ state: "closed", stateReason: "completed" })).toBe(true);
    expect(isCompletedBlockerIssue({ state: "CLOSED" })).toBe(false);
  });
});

describe("unresolvedBlockerNumbers", () => {
  test("names the distinct blockers that skipped issues are waiting on", () => {
    const issues = [
      issue({ number: 498, body: "Blocked by #497" }),
      issue({ number: 524, body: "Blocked by #497" }),
      issue({ number: 499, body: "Blocked by #498" }),
    ];
    const states = new Map<number, BlockerPrState>([
      [497, { hasOpenPr: false, hasMergedPr: false, blockerCompleted: false }],
      [498, { hasOpenPr: false, hasMergedPr: false, blockerCompleted: false }],
    ]);
    expect(unresolvedBlockerNumbers(issues, states)).toEqual([497, 498]);
  });

  test("includes blockers whose state could not be fetched", () => {
    const issues = [issue({ number: 102, body: "Blocked by #98" })];
    expect(unresolvedBlockerNumbers(issues, new Map<number, BlockerPrState>())).toEqual([98]);
  });

  test("omits satisfied blockers and workable issues", () => {
    const issues = [
      issue({ number: 102, body: "Blocked by #98" }),
      issue({ number: 103, body: "Blocked by #99" }),
      issue({ number: 104 }),
    ];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: true }],
      [99, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(unresolvedBlockerNumbers(issues, states)).toEqual([99]);
  });

  test("names only the gating blocker when an issue lists several", () => {
    const issues = [issue({ number: 102, body: "Blocked by #98\nBlocked by #99" })];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false, blockerCompleted: false }],
      [99, { hasOpenPr: false, hasMergedPr: false, blockerCompleted: false }],
    ]);
    expect(unresolvedBlockerNumbers(issues, states)).toEqual([98]);
  });

  test("names the outside blocker a member is waiting on across the boundary (#383)", () => {
    const issues = [issue({ number: 10, body: "Blocked by #5" })];
    const states = new Map<number, BlockerPrState>([
      [5, { hasOpenPr: true, openPrNumber: asPrNumber(99), hasMergedPr: false }],
    ]);
    const featureOf: FeatureLookup = (issueNumber) =>
      issueNumber === 10 ? { issueNumber: 1, title: "Feature", branch: featureBranch(1) } : null;

    // Without the lookup the member reads as stacked, so nothing is waiting.
    expect(unresolvedBlockerNumbers(issues, states)).toEqual([]);
    expect(unresolvedBlockerNumbers(issues, states, undefined, undefined, featureOf)).toEqual([5]);
  });

  test("excludes processing issues from the unresolved-blocker report", () => {
    const issues = [
      issue({ number: 102, body: "Blocked by #98", labels: ["ready-for-agent", "processing"] }),
      issue({ number: 103, body: "Blocked by #99" }),
    ];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false, blockerCompleted: false }],
      [99, { hasOpenPr: false, hasMergedPr: false, blockerCompleted: false }],
    ]);
    expect(unresolvedBlockerNumbers(issues, states, undefined, "processing")).toEqual([99]);
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
      issue({
        number: 108,
        title: "Phoebe poll loop",
        createdAt: "2026-06-02T00:00:00Z",
      }),
    ];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    const picked = selectIssue(issues, states);
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
    expect(selectIssue(issues, states)).toBeNull();
  });

  test("skips issues carrying processingLabel", () => {
    const issues = [
      issue({ number: 10, labels: ["ready-for-agent", "processing"] }),
      issue({ number: 11, labels: ["ready-for-agent"] }),
    ];
    const picked = selectIssue(issues, new Map(), undefined, "processing");
    expect(picked?.issue.number).toBe(11);
  });

  test("returns null when all issues carry processingLabel", () => {
    const issues = [
      issue({ number: 10, labels: ["ready-for-agent", "processing"] }),
      issue({ number: 11, labels: ["ready-for-agent", "processing"] }),
    ];
    expect(selectIssue(issues, new Map(), undefined, "processing")).toBeNull();
  });
});

describe("stackedPrComment", () => {
  test("names blocker issue and PR with do-not-merge warning", () => {
    const comment = stackedPrComment(98, asPrNumber(104));
    expect(comment).toContain("#98");
    expect(comment).toContain("PR #104");
    expect(comment).toContain("Do not merge");
  });

  test("names the feature branch when the blocked PR is a member (#383)", () => {
    const comment = stackedPrComment(98, asPrNumber(104), featureBranch(1));
    expect(comment).toContain(`\`${featureBranch(1)}\``);
    expect(comment).not.toContain("`main`");
  });

  test("uses config.defaultBranch in the warning text", () => {
    const previous = { ...installedConfig };
    setResolvedConfig(resolveConfig({ ...sampleUserConfig, defaultBranch: "trunk" }));
    try {
      const comment = stackedPrComment(98, asPrNumber(104));
      expect(comment).toContain("`trunk`");
    } finally {
      setResolvedConfig(previous);
    }
  });
});

describe("isPhoebeHeadBranch", () => {
  test("matches phoebe/ prefix", () => {
    expect(isPhoebeHeadBranch(asBranchRef("phoebe/issue-109"))).toBe(true);
    expect(isPhoebeHeadBranch(asBranchRef("feature/foo"))).toBe(false);
  });
});

const defaultPrScopeConfig = {
  branchPrefix: "phoebe/",
  prScope: "phoebe" as const,
  draftPrs: "skip-non-phoebe" as const,
  prOptOutLabel: "ready-for-human",
};

function prScanFields(
  overrides: Partial<{
    headRefName: string;
    isDraft: boolean;
    isCrossRepository: boolean;
    labels: string[];
  }> = {},
) {
  return {
    isDraft: false,
    isCrossRepository: false,
    labels: [] as string[],
    ...overrides,
    headRefName: asBranchRef(overrides.headRefName ?? "phoebe/issue-1"),
  };
}

describe("isPrInScope", () => {
  test("phoebe scope includes Phoebe branches", () => {
    expect(isPrInScope(prScanFields({ headRefName: "phoebe/issue-1" }), defaultPrScopeConfig)).toBe(
      true,
    );
  });

  test("phoebe scope excludes non-Phoebe branches", () => {
    expect(isPrInScope(prScanFields({ headRefName: "feature/foo" }), defaultPrScopeConfig)).toBe(
      false,
    );
  });

  test("all scope includes same-repo non-Phoebe branches", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo" }), {
        ...defaultPrScopeConfig,
        prScope: "all",
      }),
    ).toBe(true);
  });

  test("cross-repo PRs are always excluded", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo", isCrossRepository: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
      }),
    ).toBe(false);
  });

  test("opt-out label excludes any PR including Phoebe branches", () => {
    expect(
      isPrInScope(
        prScanFields({ headRefName: "phoebe/issue-1", labels: ["ready-for-human"] }),
        defaultPrScopeConfig,
      ),
    ).toBe(false);
  });

  test("skip-all draft mode excludes all drafts", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "phoebe/issue-1", isDraft: true }), {
        ...defaultPrScopeConfig,
        draftPrs: "skip-all",
      }),
    ).toBe(false);
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo", isDraft: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
        draftPrs: "skip-all",
      }),
    ).toBe(false);
  });

  test("skip-non-phoebe draft mode excludes drafts on human branches only", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo", isDraft: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
      }),
    ).toBe(false);
    expect(
      isPrInScope(prScanFields({ headRefName: "phoebe/issue-1", isDraft: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
      }),
    ).toBe(true);
  });

  test("include draft mode allows drafts on any in-scope branch", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo", isDraft: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
        draftPrs: "include",
      }),
    ).toBe(true);
  });
});

describe("parseIssueNumberFromBranch", () => {
  test("parses phoebe/issue-N branches", () => {
    expect(parseIssueNumberFromBranch(asBranchRef("phoebe/issue-109"))).toBe(109);
  });

  test("returns null for non-issue branches", () => {
    expect(parseIssueNumberFromBranch(asBranchRef("phoebe/custom"))).toBeNull();
  });

  // src/cli.ts imports the engine statically and installs the resolved config
  // afterwards (#280), so the branch pattern has to be read per call. Frozen at
  // import time it would either throw (nothing installed yet) or answer for the
  // wrong tenant.
  test("follows a config installed after this module was imported", () => {
    // Snapshot what is installed rather than rebuilding the sample: this test
    // has to leave the holder as it found it, whoever filled it. The spread
    // reads through the Proxy, so `previous` is a plain copy of that value.
    const previous = { ...installedConfig };
    setResolvedConfig(resolveConfig({ ...sampleUserConfig, branchPrefix: "bot/" }));
    try {
      expect(parseIssueNumberFromBranch(asBranchRef("bot/issue-7"))).toBe(7);
      expect(parseIssueNumberFromBranch(asBranchRef("phoebe/issue-7"))).toBeNull();
    } finally {
      setResolvedConfig(previous);
    }
  });
});

describe("isPrMergeConflicting", () => {
  test("detects CONFLICTING mergeable state", () => {
    expect(isPrMergeConflicting("CONFLICTING")).toBe(true);
    expect(isPrMergeConflicting("MERGEABLE")).toBe(false);
  });

  test("treats UNKNOWN + DIRTY as conflicting", () => {
    expect(isPrMergeConflicting("UNKNOWN", "DIRTY")).toBe(true);
    expect(isPrMergeConflicting("UNKNOWN", "CLEAN")).toBe(false);
  });
});

describe("shouldSkipStackedConflictFix", () => {
  test("skips when blocker PR is still open", () => {
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(shouldSkipStackedConflictFix("Blocked by #108", states)).toBe(true);
  });

  test("does not skip when blocker PR merged", () => {
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
    ]);
    expect(shouldSkipStackedConflictFix("Blocked by #108", states)).toBe(false);
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
      getMergedBlockerPrNumbers("Blocked by #100\nBlocked by #101\nBlocked by #102", states),
    ).toEqual([110, 111]);
  });

  test("returns empty when no blockers merged", () => {
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(getMergedBlockerPrNumbers("Blocked by #108", states)).toEqual([]);
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

  test("uses config.defaultBranch in the catch-up text", () => {
    const previous = { ...installedConfig };
    setResolvedConfig(resolveConfig({ ...sampleUserConfig, defaultBranch: "trunk" }));
    try {
      const comment = stackedCatchUpRetractionComment([asPrNumber(112)]);
      expect(comment).toContain("`trunk`");
    } finally {
      setResolvedConfig(previous);
    }
  });
});

describe("validateWorkOrder", () => {
  const validate = (order: readonly string[]) => validateWorkOrder(order, WORK_KIND_NAMES);

  test("accepts known kinds", () => {
    expect(validate(["conflicts", "checks", "reviews", "issues"])).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
    ]);
    expect(validate(["conflicts", "issues"])).toEqual(["conflicts", "issues"]);
    expect(validate(["issues"])).toEqual(["issues"]);
  });

  test("accepts research", () => {
    expect(validate(["conflicts", "checks", "reviews", "issues", "research"])).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
      "research",
    ]);
    expect(validate(["research"])).toEqual(["research"]);
  });

  test("accepts a registered custom kind in the legal set", () => {
    expect(validateWorkOrder(["issues", "my-kind"], [...WORK_KIND_NAMES, "my-kind"])).toEqual([
      "issues",
      "my-kind",
    ]);
  });

  test("accepts an empty order — priority, not membership (#415)", () => {
    expect(validate([])).toEqual([]);
  });

  test("throws on unknown kind", () => {
    expect(() => validate(["conflicts", "bogus"])).toThrow(/Unknown work kind/);
  });
});

// ---------------------------------------------------------------------------
// One selection entry point
//
// The registry walk (src/work-kinds/walk.ts) is the only way into selection,
// so the per-kind tests below go through it rather than through a wrapper the
// loop does not call. `selectFirstWorkUnit` here is a thin shim that lays a
// flat fixture out into the built-in kinds' gathered slots and stubs the cycle
// ctx — `github`/`origin` are poisoned, so a `select` that reaches beyond its
// gathered slot and the cycle services crashes the test. Picked PR units are
// unwrapped back to their candidate for the assertions.
// ---------------------------------------------------------------------------

type WalkData = {
  issues: readonly Issue[];
  researchIssues?: readonly Issue[];
  blockerStates: ReadonlyMap<number, BlockerPrState>;
  conflictingPrs: readonly ConflictingPrCandidate[];
  failingCheckPrs: readonly ChecksCandidate[];
  reviewActivityPrs: readonly ReviewsCandidate[];
  issueBodies: ReadonlyMap<number, string>;
  phoebeBase?: string;
  phoebeLogin?: string;
  currentMainHead?: Sha;
};

const NO_WORK: WalkData = {
  issues: [],
  blockerStates: new Map(),
  conflictingPrs: [],
  failingCheckPrs: [],
  reviewActivityPrs: [],
  issueBodies: new Map(),
};

const walkRegistry = buildRegistry(resolveConfig(sampleUserConfig));

function walkCtx(kind: string, data: WalkData): WorkKindCtx {
  return {
    kind,
    config: installedConfig,
    options: undefined,
    env: data.phoebeBase !== undefined ? { PHOEBE_BASE: data.phoebeBase } : {},
    // Poisoned on purpose: select must be pure over gathered + cycle services.
    github: null as never,
    origin: null as never,
    cycle: {
      issueBody: (n) => data.issueBodies.get(n) ?? null,
      registerIssues: () => {},
      blockerStates: () => data.blockerStates,
      feature: () => null,
    },
    clock: { now: () => new Date(0), sleep: () => Promise.resolve() },
    inFlight: new Set<string>(),
    log: () => {},
  };
}

function selectFirstWorkUnit(
  order: readonly string[],
  data: WalkData,
  opts?: { oneShotOnly?: boolean },
): { unit: { kind: string; unit: any } | null; skipped: WorkUnitSkip[] } {
  if (opts?.oneShotOnly) {
    order = oneShotWorkKinds(order, walkRegistry);
  }
  const gathered = new Map<string, unknown>([
    [
      "conflicts",
      {
        candidates: data.conflictingPrs,
        issueBodies: data.issueBodies,
        currentMainHead: data.currentMainHead,
      },
    ],
    ["checks", { candidates: data.failingCheckPrs, issueBodies: data.issueBodies }],
    [
      "reviews",
      {
        candidates: data.reviewActivityPrs,
        issueBodies: data.issueBodies,
        phoebeLogin: data.phoebeLogin ?? "",
      },
    ],
    ["issues", { issues: data.issues }],
    ["research", { issues: data.researchIssues ?? [] }],
  ]);
  const { units, skipped } = selectWorkUnits({
    registry: walkRegistry,
    kinds: order,
    gathered,
    ctxFor: (kind: string) => walkCtx(kind, data),
    limit: 1,
    inFlight: () => new Set<string>(),
  });
  const unit = units[0];
  if (!unit) return { unit: null, skipped };
  const raw = unit.unit as Record<string, unknown>;
  const flattened = "pr" in raw ? raw["pr"] : raw;
  return { unit: { kind: unit.kind, unit: flattened }, skipped };
}

function conflictPick(
  prs: readonly ConflictingPrCandidate[],
  ctx: StackContext,
  opts?: { currentMainHead: Sha },
): ConflictingPrCandidate | null {
  const { unit } = selectFirstWorkUnit(["conflicts"], {
    ...NO_WORK,
    ...ctx,
    conflictingPrs: prs,
    ...opts,
  });
  return unit?.kind === "conflicts" ? unit.unit : null;
}

function checksPick(prs: readonly ChecksCandidate[], ctx: StackContext): ChecksCandidate | null {
  const { unit } = selectFirstWorkUnit(["checks"], { ...NO_WORK, ...ctx, failingCheckPrs: prs });
  return unit?.kind === "checks" ? unit.unit : null;
}

function reviewsPick(
  prs: readonly ReviewsCandidate[],
  ctx: StackContext,
  phoebeLogin: string,
): ReviewsCandidate | null {
  const { unit } = selectFirstWorkUnit(["reviews"], {
    ...NO_WORK,
    ...ctx,
    reviewActivityPrs: prs,
    phoebeLogin,
  });
  return unit?.kind === "reviews" ? unit.unit : null;
}

describe("the conflicts pick", () => {
  const pr = (
    overrides: Omit<Partial<ConflictingPrCandidate>, "prNumber"> & { prNumber: number },
  ) =>
    ({
      ...overrides,
      prNumber: asPrNumber(overrides.prNumber),
      headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
    }) satisfies ConflictingPrCandidate;

  test("picks oldest PR number among eligible conflicts", () => {
    const prs = [pr({ prNumber: 120 }), pr({ prNumber: 115 }), pr({ prNumber: 118 })];
    const bodies = new Map<number, string>();
    const states = new Map<number, BlockerPrState>();
    expect(conflictPick(prs, { issueBodies: bodies, blockerStates: states })?.prNumber).toBe(115);
  });

  test("selects stacked follow-up when blocker merged (catch-up eligible)", () => {
    const prs = [pr({ prNumber: 115, issueNumber: 115 })];
    const bodies = new Map<number, string>([[115, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
    ]);
    expect(conflictPick(prs, { issueBodies: bodies, blockerStates: states })?.prNumber).toBe(115);
  });

  test("returns null when every conflict is stacked on open blocker", () => {
    const prs = [pr({ prNumber: 110 })];
    const bodies = new Map<number, string>([[110, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(conflictPick(prs, { issueBodies: bodies, blockerStates: states })).toBeNull();
  });
});

describe("selectFirstWorkUnit", () => {
  const pr = (prNumber: number): ConflictingPrCandidate => ({
    prNumber: asPrNumber(prNumber),
    headRefName: asBranchRef(`phoebe/issue-${prNumber}`),
  });

  test("prefers conflicts before issues when both have work", () => {
    const issues = [issue({ number: 135, title: "New feature" })];
    const { unit: picked } = selectFirstWorkUnit(["conflicts", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [pr(200)],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("conflicts");
    expect(picked?.kind === "conflicts" && picked.unit.prNumber).toBe(200);
  });

  test("takes issues when conflicts kind is omitted from order", () => {
    const issues = [issue({ number: 135, title: "New feature" })];
    const { unit: picked } = selectFirstWorkUnit(["issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [pr(200)],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("issues");
    expect(picked?.kind === "issues" && picked.unit.issue.number).toBe(135);
  });

  test("takes conflicts only when issues kind is omitted", () => {
    const { unit: picked } = selectFirstWorkUnit(["conflicts"], {
      issues: [issue({ number: 135 })],
      blockerStates: new Map(),
      conflictingPrs: [pr(200)],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("conflicts");
  });

  test("under oneShotOnly skips conflicts and takes the first eligible kind", () => {
    const issues = [issue({ number: 137, title: "Run-once respects WORK_ORDER" })];
    const { unit: picked } = selectFirstWorkUnit(
      ["conflicts", "issues"],
      {
        issues,
        blockerStates: new Map(),
        conflictingPrs: [pr(200)],
        failingCheckPrs: [],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked?.kind).toBe("issues");
    expect(picked?.kind === "issues" && picked.unit.issue.number).toBe(137);
  });

  test("under oneShotOnly returns null for conflict-only WORK_ORDER even when conflicts exist", () => {
    const { unit: picked } = selectFirstWorkUnit(
      ["conflicts"],
      {
        issues: [],
        blockerStates: new Map(),
        conflictingPrs: [pr(200)],
        failingCheckPrs: [],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked).toBeNull();
  });

  test("under oneShotOnly never selects conflicts when issues are absent", () => {
    const { unit: picked } = selectFirstWorkUnit(
      ["conflicts", "issues"],
      {
        issues: [],
        blockerStates: new Map(),
        conflictingPrs: [pr(200)],
        failingCheckPrs: [],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked).toBeNull();
  });
});

describe("selectFirstWorkUnit research ordering", () => {
  const researchIssue = (number: number, overrides: Partial<Issue> = {}): Issue =>
    issue({ number, title: `Research ${number}`, labels: ["wayfinder:research"], ...overrides });

  test("selects a research ticket via the reused issues path", () => {
    const { unit: picked } = selectFirstWorkUnit(["research"], {
      issues: [],
      researchIssues: [researchIssue(140)],
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("research");
    expect(picked?.kind === "research" && picked.unit.issue.number).toBe(140);
  });

  test("prefers issues before research when both have work", () => {
    const { unit: picked } = selectFirstWorkUnit(["issues", "research"], {
      issues: [issue({ number: 150, title: "New feature" })],
      researchIssues: [researchIssue(140)],
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("issues");
    expect(picked?.kind === "issues" && picked.unit.issue.number).toBe(150);
  });

  test("skips a research ticket blocked by an issue with no blocker PR", () => {
    const { unit: picked } = selectFirstWorkUnit(["research"], {
      issues: [],
      researchIssues: [researchIssue(141, { body: "Blocked by #108" })],
      blockerStates: new Map<number, BlockerPrState>([
        [108, { hasOpenPr: false, hasMergedPr: false }],
      ]),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked).toBeNull();
  });

  test("under oneShotOnly selects research when it is the eligible kind", () => {
    const { unit: picked } = selectFirstWorkUnit(
      ["conflicts", "research"],
      {
        issues: [],
        researchIssues: [researchIssue(142)],
        blockerStates: new Map(),
        conflictingPrs: [],
        failingCheckPrs: [],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked?.kind).toBe("research");
  });

  test("selects nothing for research when researchIssues is absent", () => {
    const { unit: picked } = selectFirstWorkUnit(["research"], {
      issues: [issue({ number: 150 })],
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked).toBeNull();
  });
});

describe("one-shot eligibility", () => {
  const eligible = (kind: string): boolean => walkRegistry.get(kind)!.definition.oneShotEligible;

  test("janitor kinds are persistent-mode only", () => {
    expect(eligible("conflicts")).toBe(false);
    expect(eligible("checks")).toBe(false);
    expect(eligible("reviews")).toBe(false);
    expect(eligible("issues")).toBe(true);
  });

  test("research is one-shot-eligible like issues", () => {
    expect(eligible("research")).toBe(true);
  });
});

describe("oneShotWorkKinds", () => {
  const oneShot = (order: readonly string[]): readonly string[] =>
    oneShotWorkKinds(order, walkRegistry);

  test("filters to one-shot-eligible kinds in WORK_ORDER order", () => {
    expect(oneShot(["conflicts", "checks", "reviews", "issues"])).toEqual(["issues"]);
    expect(oneShot(["conflicts", "issues"])).toEqual(["issues"]);
    expect(oneShot(["conflicts"])).toEqual([]);
    expect(oneShot(["issues"])).toEqual(["issues"]);
  });

  test("keeps research alongside issues", () => {
    expect(oneShot(["conflicts", "checks", "reviews", "issues", "research"])).toEqual([
      "issues",
      "research",
    ]);
    expect(oneShot(["conflicts", "research"])).toEqual(["research"]);
  });
});

describe("selectConflictFixCandidates", () => {
  const pr = (
    overrides: Omit<Partial<ConflictingPrCandidate>, "prNumber"> & { prNumber: number },
  ) =>
    ({
      headSha: asSha("aaa111"),
      ...overrides,
      prNumber: asPrNumber(overrides.prNumber),
      headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
    }) satisfies ConflictingPrCandidate;

  const emptyBodies = new Map<number, string>();
  const emptyStates = new Map<number, BlockerPrState>();

  test("filters out stacked PRs with open blocker", () => {
    const prs = [pr({ prNumber: 109 }), pr({ prNumber: 110 })];
    const bodies = new Map<number, string>([
      [109, "No blockers"],
      [110, "Blocked by #108"],
    ]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(
      selectConflictFixCandidates(prs, { issueBodies: bodies, blockerStates: states }).map(
        (p) => p.prNumber,
      ),
    ).toEqual([109]);
  });

  test("skips PRs whose failure watermark matches current SHAs", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100"), mainHead: asSha("main1") },
      }),
      pr({
        prNumber: 101,
        headSha: asSha("pr101"),
        failureWatermark: null,
      }),
    ];
    expect(
      selectConflictFixCandidates(
        prs,
        { issueBodies: emptyBodies, blockerStates: emptyStates },
        {
          currentMainHead: asSha("main1"),
        },
      ).map((p) => p.prNumber),
    ).toEqual([101]);
  });

  test("re-attempts when PR head moved since watermark", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100v2"),
        failureWatermark: { prHead: asSha("pr100v1"), mainHead: asSha("main1") },
      }),
    ];
    expect(
      selectConflictFixCandidates(
        prs,
        { issueBodies: emptyBodies, blockerStates: emptyStates },
        {
          currentMainHead: asSha("main1"),
        },
      ).map((p) => p.prNumber),
    ).toEqual([100]);
  });

  test("re-attempts when main moved since watermark", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100"), mainHead: asSha("main1") },
      }),
    ];
    expect(
      selectConflictFixCandidates(
        prs,
        { issueBodies: emptyBodies, blockerStates: emptyStates },
        {
          currentMainHead: asSha("main2"),
        },
      ).map((p) => p.prNumber),
    ).toEqual([100]);
  });

  test("watermark skip still applies to merged-blocker catch-up candidates", () => {
    const prs = [
      pr({
        prNumber: 115,
        issueNumber: 115,
        headSha: asSha("pr115"),
        failureWatermark: { prHead: asSha("pr115"), mainHead: asSha("main1") },
      }),
    ];
    const bodies = new Map<number, string>([[115, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
    ]);
    expect(
      selectConflictFixCandidates(
        prs,
        { issueBodies: bodies, blockerStates: states },
        { currentMainHead: asSha("main1") },
      ),
    ).toEqual([]);
  });
});

describe("the conflicts pick, watermark skip", () => {
  const pr = (
    overrides: Omit<Partial<ConflictingPrCandidate>, "prNumber"> & { prNumber: number },
  ) =>
    ({
      headSha: asSha("aaa111"),
      ...overrides,
      prNumber: asPrNumber(overrides.prNumber),
      headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
    }) satisfies ConflictingPrCandidate;

  test("picks oldest non-skipped conflicting PR", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100"), mainHead: asSha("main1") },
      }),
      pr({ prNumber: 101, headSha: asSha("pr101"), failureWatermark: null }),
    ];
    const unit = conflictPick(
      prs,
      { issueBodies: new Map(), blockerStates: new Map() },
      { currentMainHead: asSha("main1") },
    );
    expect(unit?.prNumber).toBe(101);
  });
});

describe("conflict fail watermark", () => {
  const watermark = { prHead: asSha("abc123def"), mainHead: asSha("9876543210ab") };

  test("builds a parseable HTML comment marker", () => {
    const marker = buildConflictFailWatermarkMarker(watermark);
    expect(marker).toBe("<!-- phoebe-conflict-fail: prHead=abc123def mainHead=9876543210ab -->");
    expect(parseConflictFailWatermark(marker)).toEqual(watermark);
  });

  test("parseConflictFailWatermark returns null when marker absent", () => {
    expect(parseConflictFailWatermark("no marker here")).toBeNull();
  });

  test("parseLatestMarker returns latest conflict marker", () => {
    const older = buildConflictFailWatermarkMarker({
      prHead: asSha("old"),
      mainHead: asSha("oldmain"),
    });
    const newer = buildConflictFailWatermarkMarker(watermark);
    expect(
      parseLatestMarker(
        [`failure\n${older}`, "unrelated", `retry\n${newer}`],
        parseConflictFailWatermark,
      ),
    ).toEqual(watermark);
  });
});

describe("shouldSkipWatermarkConflictFix", () => {
  const watermark = { prHead: asSha("pr1"), mainHead: asSha("main1") };

  test("skips when both SHAs match watermark", () => {
    expect(
      shouldSkipWatermarkConflictFix({
        watermark,
        currentPrHead: asSha("pr1"),
        currentMainHead: asSha("main1"),
      }),
    ).toBe(true);
  });

  test("does not skip without a watermark", () => {
    expect(
      shouldSkipWatermarkConflictFix({
        watermark: null,
        currentPrHead: asSha("pr1"),
        currentMainHead: asSha("main1"),
      }),
    ).toBe(false);
  });

  test("re-attempts when either SHA moved", () => {
    expect(
      shouldSkipWatermarkConflictFix({
        watermark,
        currentPrHead: asSha("pr2"),
        currentMainHead: asSha("main1"),
      }),
    ).toBe(false);
    expect(
      shouldSkipWatermarkConflictFix({
        watermark,
        currentPrHead: asSha("pr1"),
        currentMainHead: asSha("main2"),
      }),
    ).toBe(false);
  });
});

describe("conflictFixFailureComment", () => {
  test("names the PR and explains merge was aborted", () => {
    const comment = conflictFixFailureComment(asPrNumber(42));
    expect(comment).toContain("PR #42");
    expect(comment).toContain("merge --abort");
  });

  test("uses config.defaultBranch in the merge description", () => {
    const previous = { ...installedConfig };
    setResolvedConfig(resolveConfig({ ...sampleUserConfig, defaultBranch: "trunk" }));
    try {
      const comment = conflictFixFailureComment(asPrNumber(42));
      expect(comment).toContain("origin/trunk");
    } finally {
      setResolvedConfig(previous);
    }
  });

  test("embeds SHA watermark marker when provided", () => {
    const comment = conflictFixFailureComment(asPrNumber(42), {
      prHead: asSha("deadbeef"),
      mainHead: asSha("cafebabe"),
    });
    expect(comment).toContain("<!-- phoebe-conflict-fail: prHead=deadbeef mainHead=cafebabe -->");
    expect(parseConflictFailWatermark(comment)).toEqual({
      prHead: "deadbeef",
      mainHead: "cafebabe",
    });
  });
});

describe("shouldPostConflictFixFailure", () => {
  const base = {
    originShaBefore: asSha("abc123"),
    originShaAfter: asSha("abc123"),
    mergeable: "CONFLICTING" as const,
    mergeStateStatus: "DIRTY",
  };

  test("sandbox pushed then cleanup failed — origin advanced, no failure comment", () => {
    expect(
      shouldPostConflictFixFailure({
        ...base,
        hostCommitCount: 0,
        originShaAfter: asSha("def456"),
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
    ).toBe(false);
  });

  test("PR now mergeable even when origin SHA unchanged — no failure comment", () => {
    expect(
      shouldPostConflictFixFailure({
        ...base,
        hostCommitCount: 0,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
    ).toBe(false);
  });

  test("genuine no-op — origin unchanged and still conflicting", () => {
    expect(
      shouldPostConflictFixFailure({
        ...base,
        hostCommitCount: 0,
      }),
    ).toBe(true);
  });

  test("host has unpushed commits — no failure comment", () => {
    expect(
      shouldPostConflictFixFailure({
        ...base,
        hostCommitCount: 1,
      }),
    ).toBe(false);
  });
});

describe("buildInitialPrBody", () => {
  test("notes the stacked base on the initial PR only", () => {
    const body = buildInitialPrBody({
      issueNumber: 103,
      commitCount: 2,
      stacked: { blockerIssueNumber: 98, blockerPrNumber: asPrNumber(104) },
    });
    expect(body).toContain("Closes #103");
    expect(body).toContain("Stacked on PR #104");
    expect(body).toContain("#98");
    expect(body).toContain("Commits: 2");
    // The do-not-merge warning is the fallback comment's job (native stacking
    // may succeed, and then the warning would be wrong), not the body's.
    expect(body).not.toContain("Do not merge");
  });

  test("carries no stack note when the issue is unblocked", () => {
    const body = buildInitialPrBody({ issueNumber: 103, commitCount: 2 });
    expect(body).not.toContain("Stacked");
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

describe("statusCheckRollupState", () => {
  const check = (overrides: Partial<StatusCheckItem>): StatusCheckItem => ({
    __typename: "CheckRun",
    name: "test",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    ...overrides,
  });

  test("returns NONE when no checks", () => {
    expect(statusCheckRollupState([])).toBe("NONE");
  });

  test("returns PENDING when any check is queued or in progress", () => {
    expect(
      statusCheckRollupState([
        check({ name: "a", status: "IN_PROGRESS", conclusion: null }),
        check({ name: "b", conclusion: "FAILURE" }),
      ]),
    ).toBe("PENDING");
  });

  test("returns FAILURE when a check failed and none pending", () => {
    expect(
      statusCheckRollupState([
        check({ name: "a", conclusion: "SUCCESS" }),
        check({ name: "b", conclusion: "FAILURE" }),
      ]),
    ).toBe("FAILURE");
  });

  test("returns SUCCESS when all checks passed", () => {
    expect(statusCheckRollupState([check({ conclusion: "SUCCESS" })])).toBe("SUCCESS");
  });

  test("handles StatusContext pending and failure states", () => {
    expect(
      statusCheckRollupState([{ __typename: "StatusContext", context: "ci", state: "PENDING" }]),
    ).toBe("PENDING");
    expect(
      statusCheckRollupState([{ __typename: "StatusContext", context: "ci", state: "FAILURE" }]),
    ).toBe("FAILURE");
  });
});

describe("workflowRunsToCheckItems", () => {
  test("uppercases REST enums and keeps only the newest run per workflow", () => {
    expect(
      workflowRunsToCheckItems([
        { workflowName: "ready", status: "completed", conclusion: "success" },
        { workflowName: "ready", status: "completed", conclusion: "failure" },
        { workflowName: "autofix.ci", status: "in_progress", conclusion: null },
      ]),
    ).toEqual([
      { name: "ready", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "autofix.ci", status: "IN_PROGRESS", conclusion: null },
    ]);
  });

  test("maps onto rollup state: failed run yields FAILURE, running run yields PENDING", () => {
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([
          { workflowName: "ready", status: "completed", conclusion: "failure" },
        ]),
      ),
    ).toBe("FAILURE");
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([
          { workflowName: "ready", status: "queued", conclusion: null },
          { workflowName: "autofix.ci", status: "completed", conclusion: "failure" },
        ]),
      ),
    ).toBe("PENDING");
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([
          { workflowName: "ready", status: "completed", conclusion: "success" },
        ]),
      ),
    ).toBe("SUCCESS");
  });

  test("treats REST-only pending statuses as pending", () => {
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([{ workflowName: "ready", status: "pending", conclusion: null }]),
      ),
    ).toBe("PENDING");
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([
          { workflowName: "ready", status: "requested", conclusion: null },
        ]),
      ),
    ).toBe("PENDING");
  });

  test("falls back to run name when workflowName is missing", () => {
    expect(
      workflowRunsToCheckItems([{ name: "ready", status: "completed", conclusion: "success" }]),
    ).toEqual([{ name: "ready", status: "COMPLETED", conclusion: "SUCCESS" }]);
  });
});

describe("listFailingChecks", () => {
  test("lists only failing checks with names and conclusions", () => {
    const checks: StatusCheckItem[] = [
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "ci/old", state: "ERROR" },
    ];
    expect(listFailingChecks(checks)).toEqual([
      { name: "lint", conclusion: "FAILURE" },
      { name: "ci/old", conclusion: "ERROR" },
    ]);
  });
});

describe("the checks pick", () => {
  const checksPr = (
    overrides: Omit<Partial<ChecksCandidate>, "prNumber"> & { prNumber: number },
  ): ChecksCandidate => ({
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    failingChecks: [{ name: "test", conclusion: "FAILURE" }],
    ...overrides,
    prNumber: asPrNumber(overrides.prNumber),
    headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
  });

  test("picks oldest PR number among eligible failing-CI candidates", () => {
    const prs = [
      checksPr({ prNumber: 120 }),
      checksPr({ prNumber: 115 }),
      checksPr({ prNumber: 118 }),
    ];
    expect(checksPick(prs, { issueBodies: new Map(), blockerStates: new Map() })?.prNumber).toBe(
      115,
    );
  });

  test("skips conflicting PRs", () => {
    const prs = [
      checksPr({ prNumber: 110, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      checksPr({ prNumber: 111 }),
    ];
    expect(checksPick(prs, { issueBodies: new Map(), blockerStates: new Map() })?.prNumber).toBe(
      111,
    );
  });

  test("skips stacked PRs with open blocker", () => {
    const prs = [checksPr({ prNumber: 110 })];
    const bodies = new Map<number, string>([[110, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(checksPick(prs, { issueBodies: bodies, blockerStates: states })).toBeNull();
  });

  test("skips PRs with unchanged failure watermark", () => {
    const prs = [
      checksPr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100") },
      }),
      checksPr({ prNumber: 101, headSha: asSha("pr101"), failureWatermark: null }),
    ];
    expect(checksPick(prs, { issueBodies: new Map(), blockerStates: new Map() })?.prNumber).toBe(
      101,
    );
  });
});

describe("selectFirstWorkUnit checks ordering", () => {
  const conflictPr = (prNumber: number): ConflictingPrCandidate => ({
    prNumber: asPrNumber(prNumber),
    headRefName: asBranchRef(`phoebe/issue-${prNumber}`),
  });

  const checksPr = (prNumber: number): ChecksCandidate => ({
    prNumber: asPrNumber(prNumber),
    headRefName: asBranchRef(`phoebe/issue-${prNumber}`),
    mergeable: "MERGEABLE",
    failingChecks: [{ name: "test", conclusion: "FAILURE" }],
  });

  test("prefers conflicts before checks before issues", () => {
    const issues = [issue({ number: 135, title: "New feature" })];
    const { unit: picked } = selectFirstWorkUnit(["conflicts", "checks", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [conflictPr(200)],
      failingCheckPrs: [checksPr(201)],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("conflicts");
  });

  test("takes checks when no conflicts but failing CI exists", () => {
    const issues = [issue({ number: 135, title: "New feature" })];
    const { unit: picked } = selectFirstWorkUnit(["conflicts", "checks", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [checksPr(201)],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("checks");
    expect(picked?.kind === "checks" && picked.unit.prNumber).toBe(201);
  });

  test("under oneShotOnly skips checks", () => {
    const issues = [issue({ number: 137 })];
    const { unit: picked } = selectFirstWorkUnit(
      ["conflicts", "checks", "issues"],
      {
        issues,
        blockerStates: new Map(),
        conflictingPrs: [],
        failingCheckPrs: [checksPr(201)],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked?.kind).toBe("issues");
  });
});

describe("checks fail watermark", () => {
  const watermark = { prHead: asSha("abc123def") };

  test("builds a parseable HTML comment marker", () => {
    const marker = buildChecksFailWatermarkMarker(watermark);
    expect(marker).toBe("<!-- phoebe-checks-fail: prHead=abc123def -->");
    expect(parseChecksFailWatermark(marker)).toEqual(watermark);
  });

  test("parseLatestMarker returns latest checks marker", () => {
    const older = buildChecksFailWatermarkMarker({ prHead: asSha("old") });
    const newer = buildChecksFailWatermarkMarker(watermark);
    expect(
      parseLatestMarker(
        [`failure\n${older}`, "unrelated", `retry\n${newer}`],
        parseChecksFailWatermark,
      ),
    ).toEqual(watermark);
  });
});

describe("shouldSkipWatermarkChecksFix", () => {
  test("skips when prHead matches watermark", () => {
    expect(
      shouldSkipWatermarkChecksFix({
        watermark: { prHead: asSha("pr1") },
        currentPrHead: asSha("pr1"),
      }),
    ).toBe(true);
  });

  test("re-attempts when prHead moved", () => {
    expect(
      shouldSkipWatermarkChecksFix({
        watermark: { prHead: asSha("pr1") },
        currentPrHead: asSha("pr2"),
      }),
    ).toBe(false);
  });
});

describe("shouldSkipStackedChecksFix", () => {
  test("aliases stacked conflict skip logic", () => {
    expect(shouldSkipStackedChecksFix).toBe(shouldSkipStackedConflictFix);
  });
});

describe("checksFixFailureComment", () => {
  test("embeds prHead-only watermark when provided", () => {
    const comment = checksFixFailureComment(asPrNumber(42), { prHead: asSha("deadbeef") });
    expect(comment).toContain("PR #42");
    expect(comment).toContain("<!-- phoebe-checks-fail: prHead=deadbeef -->");
  });
});

describe("shouldPostChecksFixFailure", () => {
  const base = { originShaBefore: asSha("abc123"), originShaAfter: asSha("abc123") };

  test("genuine no-op — origin unchanged and no local commits", () => {
    expect(shouldPostChecksFixFailure({ ...base, hostCommitCount: 0 })).toBe(true);
  });

  test("agent pushed — no failure comment", () => {
    expect(
      shouldPostChecksFixFailure({ ...base, hostCommitCount: 0, originShaAfter: asSha("def456") }),
    ).toBe(false);
  });

  test("host has unpushed commits — no failure comment", () => {
    expect(shouldPostChecksFixFailure({ ...base, hostCommitCount: 1 })).toBe(false);
  });
});

describe("formatFailingChecksForPrompt", () => {
  test("formats name and conclusion per line", () => {
    expect(
      formatFailingChecksForPrompt([
        { name: "lint", conclusion: "FAILURE" },
        { name: "test", conclusion: "TIMED_OUT" },
      ]),
    ).toBe("lint: FAILURE\ntest: TIMED_OUT");
  });
});

function reviewThread(
  overrides: Partial<ReviewThread> & Pick<ReviewThread, "comments">,
): ReviewThread {
  return {
    isResolved: false,
    isOutdated: false,
    ...overrides,
  };
}

function reviewsPr(
  overrides: Omit<Partial<ReviewsCandidate>, "prNumber"> & { prNumber: number },
): ReviewsCandidate {
  return {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    threads: [],
    ...overrides,
    prNumber: asPrNumber(overrides.prNumber),
    headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
  };
}

describe("hasNewNonPhoebeReviewActivity", () => {
  const phoebeLogin = "phoebe-bot";

  test("detects new comment on unresolved thread after watermark", () => {
    const threads = [
      reviewThread({
        comments: [
          { authorLogin: "reviewer", createdAt: "2026-06-01T10:00:00Z" },
          { authorLogin: "reviewer", createdAt: "2026-06-02T12:00:00Z" },
        ],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        watermark: { latest: "2026-06-01T11:00:00Z" },
      }),
    ).toBe(true);
  });

  test("ignores Phoebe's own challenge replies", () => {
    const threads = [
      reviewThread({
        comments: [{ authorLogin: phoebeLogin, createdAt: "2026-06-03T12:00:00Z" }],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        watermark: { latest: "2026-06-01T00:00:00Z" },
      }),
    ).toBe(false);
  });

  test("ignores PR author's own replies on human PRs", () => {
    const authorLogin = "human-dev";
    const threads = [
      reviewThread({
        comments: [{ authorLogin, createdAt: "2026-06-03T12:00:00Z" }],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        authorLogin,
        watermark: { latest: "2026-06-01T00:00:00Z" },
      }),
    ).toBe(false);
  });

  test("ignores resolved and outdated threads", () => {
    const threads = [
      reviewThread({
        isResolved: true,
        comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
      }),
      reviewThread({
        isOutdated: true,
        comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        watermark: null,
      }),
    ).toBe(false);
  });

  test("no watermark treats any non-Phoebe unresolved activity as new", () => {
    const threads = [
      reviewThread({
        comments: [{ authorLogin: "reviewer", createdAt: "2026-06-01T10:00:00Z" }],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        watermark: null,
      }),
    ).toBe(true);
  });
});

describe("newestReviewThreadCommentCreatedAt", () => {
  test("returns newest createdAt across all thread comments", () => {
    const threads = [
      reviewThread({
        comments: [{ authorLogin: "a", createdAt: "2026-06-01T10:00:00Z" }],
      }),
      reviewThread({
        comments: [
          { authorLogin: "b", createdAt: "2026-06-02T08:00:00Z" },
          { authorLogin: "c", createdAt: "2026-06-03T09:00:00Z" },
        ],
      }),
    ];
    expect(newestReviewThreadCommentCreatedAt(threads)).toBe("2026-06-03T09:00:00Z");
  });
});

describe("reviews handled watermark", () => {
  test("builds and parses timestamp marker", () => {
    const marker = buildReviewsHandledMarker({ latest: "2026-06-03T09:00:00Z" });
    expect(marker).toBe("<!-- phoebe-reviews-handled: latest=2026-06-03T09:00:00Z -->");
    expect(parseReviewsHandledWatermark(marker)).toEqual({ latest: "2026-06-03T09:00:00Z" });
  });

  test("parseLatestMarker returns latest reviews marker", () => {
    const older = buildReviewsHandledMarker({ latest: "2026-06-01T00:00:00Z" });
    const newer = buildReviewsHandledMarker({ latest: "2026-06-03T00:00:00Z" });
    expect(
      parseLatestMarker(
        [`done\n${older}`, "unrelated", `retry\n${newer}`],
        parseReviewsHandledWatermark,
      ),
    ).toEqual({ latest: "2026-06-03T00:00:00Z" });
  });
});

describe("buildReviewsHandledComment", () => {
  test("failure comment is visible and embeds marker", () => {
    const comment = buildReviewsHandledComment({
      latestActivityAt: "2026-06-03T09:00:00Z",
      failed: true,
    });
    expect(comment).toContain("attempted to handle review feedback and failed");
    expect(comment).toContain("<!-- phoebe-reviews-handled: latest=2026-06-03T09:00:00Z -->");
  });

  test("success comment is marker only", () => {
    const comment = buildReviewsHandledComment({
      latestActivityAt: "2026-06-03T09:00:00Z",
      failed: false,
    });
    expect(comment).toBe("<!-- phoebe-reviews-handled: latest=2026-06-03T09:00:00Z -->");
  });
});

describe("isReviewSummaryComment", () => {
  test("detects handle-pr-review summary heading", () => {
    expect(isReviewSummaryComment("## Review feedback addressed (abc123)\n\n**Fixed:**")).toBe(
      true,
    );
    expect(isReviewSummaryComment("Phoebe update")).toBe(false);
  });
});

describe("the reviews pick", () => {
  const phoebeLogin = "phoebe-bot";

  test("picks oldest PR with new non-Phoebe review activity", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({ prNumber: 120, threads: [thread] }),
      reviewsPr({ prNumber: 115, threads: [thread] }),
    ];
    expect(
      reviewsPick(prs, { issueBodies: new Map(), blockerStates: new Map() }, phoebeLogin)?.prNumber,
    ).toBe(115);
  });

  test("skips conflicting PRs", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 110,
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        threads: [thread],
      }),
      reviewsPr({ prNumber: 111, threads: [thread] }),
    ];
    expect(
      reviewsPick(prs, { issueBodies: new Map(), blockerStates: new Map() }, phoebeLogin)?.prNumber,
    ).toBe(111);
  });

  test("skips stacked PRs with open blocker", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [reviewsPr({ prNumber: 110, threads: [thread] })];
    const bodies = new Map<number, string>([[110, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(
      reviewsPick(prs, { issueBodies: bodies, blockerStates: states }, phoebeLogin),
    ).toBeNull();
  });

  test("skips when watermark covers all activity", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 110,
        threads: [thread],
        handledWatermark: { latest: "2026-06-03T12:00:00Z" },
      }),
    ];
    expect(
      reviewsPick(prs, { issueBodies: new Map(), blockerStates: new Map() }, phoebeLogin),
    ).toBeNull();
  });

  test("human PR with null issue number and reviewer activity is eligible", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 130,
        headRefName: asBranchRef("feature/human-pr"),
        authorLogin: "human-dev",
        threads: [thread],
      }),
    ];
    expect(
      reviewsPick(prs, { issueBodies: new Map(), blockerStates: new Map() }, phoebeLogin)?.prNumber,
    ).toBe(130);
  });
});

describe("selectFirstWorkUnit reviews ordering", () => {
  const phoebeLogin = "phoebe-bot";
  const thread = reviewThread({
    comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
  });

  const reviewsCandidate = reviewsPr({ prNumber: 202, threads: [thread] });

  const checksPr = (prNumber: number): ChecksCandidate => ({
    prNumber: asPrNumber(prNumber),
    headRefName: asBranchRef(`phoebe/issue-${prNumber}`),
    mergeable: "MERGEABLE",
    failingChecks: [{ name: "test", conclusion: "FAILURE" }],
  });

  test("prefers checks before reviews when both match", () => {
    const issues = [issue({ number: 135 })];
    const { unit: picked } = selectFirstWorkUnit(["conflicts", "checks", "reviews", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [checksPr(201)],
      reviewActivityPrs: [reviewsCandidate],
      issueBodies: new Map(),
      phoebeLogin,
    });
    expect(picked?.kind).toBe("checks");
  });

  test("takes reviews when no conflicts or checks", () => {
    const issues = [issue({ number: 135 })];
    const { unit: picked } = selectFirstWorkUnit(["conflicts", "checks", "reviews", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [reviewsCandidate],
      issueBodies: new Map(),
      phoebeLogin,
    });
    expect(picked?.kind).toBe("reviews");
    expect(picked?.kind === "reviews" && picked.unit.prNumber).toBe(202);
  });

  test("under oneShotOnly skips reviews", () => {
    const issues = [issue({ number: 137 })];
    const { unit: picked } = selectFirstWorkUnit(
      ["conflicts", "checks", "reviews", "issues"],
      {
        issues,
        blockerStates: new Map(),
        conflictingPrs: [],
        failingCheckPrs: [],
        reviewActivityPrs: [reviewsCandidate],
        issueBodies: new Map(),
        phoebeLogin,
      },
      { oneShotOnly: true },
    );
    expect(picked?.kind).toBe("issues");
  });
});

describe("shouldSkipStackedReviewsFix", () => {
  test("aliases stacked conflict skip logic", () => {
    expect(shouldSkipStackedReviewsFix).toBe(shouldSkipStackedConflictFix);
  });
});

describe("the skip record selection returns", () => {
  const conflictPr = (
    overrides: Omit<Partial<ConflictingPrCandidate>, "prNumber"> & { prNumber: number },
  ) =>
    ({
      headSha: asSha(`sha${overrides.prNumber}`),
      ...overrides,
      prNumber: asPrNumber(overrides.prNumber),
      headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
    }) satisfies ConflictingPrCandidate;

  const emptyData = {
    issues: [],
    blockerStates: new Map(),
    conflictingPrs: [],
    failingCheckPrs: [],
    reviewActivityPrs: [],
    issueBodies: new Map(),
  } satisfies WalkData;

  test("conflicts separates the stacked skips from the watermarked ones", () => {
    const prs = [
      // Stacked on an open blocker → skipped as stacked.
      conflictPr({ prNumber: 100, issueNumber: 100 }),
      // Watermark unchanged (prHead + mainHead match) → skipped as watermark.
      conflictPr({
        prNumber: 101,
        headSha: asSha("pr101"),
        failureWatermark: { prHead: asSha("pr101"), mainHead: asSha("main1") },
      }),
      // Fixable.
      conflictPr({ prNumber: 102, headSha: asSha("pr102"), failureWatermark: null }),
    ];
    const selection = selectFirstWorkUnit(["conflicts"], {
      ...emptyData,
      conflictingPrs: prs,
      issueBodies: new Map([[100, "Blocked by #98"]]),
      blockerStates: new Map([
        [98, { hasOpenPr: true, openPrNumber: asPrNumber(200), hasMergedPr: false }],
      ]),
      currentMainHead: asSha("main1"),
    });

    expect(selection.unit?.kind === "conflicts" && selection.unit.unit.prNumber).toBe(102);
    expect(selection.skipped).toEqual([
      { kind: "conflicts", reason: "stacked on open blocker", count: 1 },
      { kind: "conflicts", reason: "unchanged failure watermark", count: 1 },
    ]);
  });

  test("checks records one ineligible count and the total when nothing is fixable", () => {
    const prs: ChecksCandidate[] = [
      {
        prNumber: asPrNumber(111),
        headRefName: asBranchRef("phoebe/issue-111"),
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        failingChecks: [],
      },
    ];
    const selection = selectFirstWorkUnit(["checks"], { ...emptyData, failingCheckPrs: prs });

    expect(selection.unit).toBeNull();
    expect(selection.skipped).toEqual([
      { kind: "checks", reason: "conflicting, stacked, or watermarked", count: 1 },
      { kind: "checks", reason: "none-workable", count: 1 },
    ]);
  });

  test("reviews counts a PR with no new activity as ineligible", () => {
    const phoebeLogin = "phoebe-bot";
    const prs: ReviewsCandidate[] = [
      {
        prNumber: asPrNumber(120),
        headRefName: asBranchRef("phoebe/issue-120"),
        mergeable: "MERGEABLE",
        threads: [
          {
            isResolved: false,
            isOutdated: false,
            comments: [{ createdAt: "2026-06-01T00:00:00Z", authorLogin: "human" }],
          },
        ],
      },
      {
        prNumber: asPrNumber(121),
        headRefName: asBranchRef("phoebe/issue-121"),
        mergeable: "MERGEABLE",
        threads: [
          {
            isResolved: false,
            isOutdated: false,
            comments: [{ createdAt: "2026-06-01T00:00:00Z", authorLogin: phoebeLogin }],
          },
        ],
      },
    ];
    const selection = selectFirstWorkUnit(["reviews"], {
      ...emptyData,
      reviewActivityPrs: prs,
      phoebeLogin,
    });

    expect(selection.unit?.kind === "reviews" && selection.unit.unit.prNumber).toBe(120);
    expect(selection.skipped).toEqual([
      { kind: "reviews", reason: "stacked, watermarked, or no new activity", count: 1 },
    ]);
  });

  test("the record follows workOrder, and stops at the kind that was picked", () => {
    const selection = selectFirstWorkUnit(["checks", "conflicts", "issues"], {
      ...emptyData,
      // Conflicting, so the checks kind turns it away; the conflicts kind takes it.
      failingCheckPrs: [
        {
          prNumber: asPrNumber(130),
          headRefName: asBranchRef("phoebe/issue-130"),
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
          failingChecks: [],
        },
      ],
      conflictingPrs: [conflictPr({ prNumber: 130 })],
      issues: [issue({ number: 131 })],
    });

    expect(selection.unit?.kind).toBe("conflicts");
    // `issues` had a workable ticket too, but the walk never reached it — so the
    // record says nothing about it either.
    expect(selection.skipped).toEqual([
      { kind: "checks", reason: "conflicting, stacked, or watermarked", count: 1 },
      { kind: "checks", reason: "none-workable", count: 1 },
    ]);
  });

  test("a kind with no units at all leaves no trace in the record", () => {
    const selection = selectFirstWorkUnit(["conflicts", "checks", "reviews", "issues"], emptyData);

    expect(selection.unit).toBeNull();
    expect(selection.skipped).toEqual([]);
  });

  test("reviews with no resolved login does not report its PRs as skipped", () => {
    const selection = selectFirstWorkUnit(["reviews"], {
      ...emptyData,
      reviewActivityPrs: [
        {
          prNumber: asPrNumber(140),
          headRefName: asBranchRef("phoebe/issue-140"),
          mergeable: "MERGEABLE",
          threads: [],
        },
      ],
    });

    expect(selection.unit).toBeNull();
    expect(selection.skipped).toEqual([]);
  });
});
