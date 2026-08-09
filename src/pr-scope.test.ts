import { describe, expect, test } from "vite-plus/test";
import { asBranchRef } from "./branded.ts";
import {
  isIssueInScope,
  isPhoebeHeadBranch,
  isPrInScope,
  isPrMergeConflicting,
  parseIssueNumberFromBranch,
} from "./pr-scope.ts";

describe("isPhoebeHeadBranch", () => {
  test("matches phoebe/ prefix", () => {
    expect(isPhoebeHeadBranch(asBranchRef("phoebe/issue-109"), "phoebe/")).toBe(true);
    expect(isPhoebeHeadBranch(asBranchRef("feature/foo"), "phoebe/")).toBe(false);
  });
});

describe("isIssueInScope", () => {
  test("unset issueAuthors admits every author", () => {
    expect(isIssueInScope({ authorLogin: "octocat" }, { issueAuthors: [] })).toBe(true);
    expect(isIssueInScope({}, { issueAuthors: [] })).toBe(true);
  });

  test("author scope includes only configured GitHub logins, case-insensitively", () => {
    const scoped = { issueAuthors: ["TanFlem"] };
    expect(isIssueInScope({ authorLogin: "tanflem" }, scoped)).toBe(true);
    expect(isIssueInScope({ authorLogin: "coworker" }, scoped)).toBe(false);
  });

  test("author scope excludes issues with no author on record", () => {
    expect(isIssueInScope({}, { issueAuthors: ["tanflem"] })).toBe(false);
  });
});

const defaultPrScopeConfig = {
  branchPrefix: "phoebe/",
  prScope: "phoebe" as const,
  prAuthors: [] as readonly string[],
  draftPrs: "skip-non-phoebe" as const,
  prOptOutLabel: "ready-for-human",
};

function prScanFields(
  overrides: Partial<{
    headRefName: string;
    authorLogin: string;
    isDraft: boolean;
    isCrossRepository: boolean;
    labels: string[];
  }> = {},
) {
  return {
    isDraft: false,
    authorLogin: "octocat",
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

  test("author scope includes only configured GitHub logins, case-insensitively", () => {
    const scoped = { ...defaultPrScopeConfig, prScope: "all" as const, prAuthors: ["TanFlem"] };
    expect(isPrInScope(prScanFields({ authorLogin: "tanflem" }), scoped)).toBe(true);
    expect(isPrInScope(prScanFields({ authorLogin: "coworker" }), scoped)).toBe(false);
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
    expect(parseIssueNumberFromBranch(asBranchRef("phoebe/issue-109"), "phoebe/")).toBe(109);
  });

  test("returns null for non-issue branches", () => {
    expect(parseIssueNumberFromBranch(asBranchRef("phoebe/custom"), "phoebe/")).toBeNull();
  });

  test("the same branch parses differently under two different prefixes", () => {
    const branch = asBranchRef("bot/issue-42");
    expect(parseIssueNumberFromBranch(branch, "bot/")).toBe(42);
    expect(parseIssueNumberFromBranch(branch, "phoebe/")).toBeNull();
    expect(parseIssueNumberFromBranch(asBranchRef("phoebe/issue-42"), "phoebe/")).toBe(42);
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
