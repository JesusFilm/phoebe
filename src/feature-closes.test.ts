// The integration PR's `Closes` block (#380): which issue a merged member PR
// speaks for, and the body edit that records it exactly once however many
// cycles sweep over the same set.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber } from "./branded.ts";
import {
  CLOSES_SECTION_END,
  CLOSES_SECTION_START,
  memberIssueNumber,
  withClosesSection,
} from "./feature-closes.ts";
import { issueBranch } from "./orchestrator.ts";

/** A merged member PR on the Phoebe branch for `issueNumber`. */
function member(prNumber: number, issueNumber: number) {
  return { number: asPrNumber(prNumber), headRefName: issueBranch(issueNumber) };
}

/** The `Closes` lines a body carries, in order. */
function closesLines(body: string): string[] {
  return body.split("\n").filter((line) => line.startsWith("Closes #"));
}

describe("memberIssueNumber", () => {
  test("reads the issue out of a Phoebe issue branch", () => {
    expect(memberIssueNumber(member(42, 381))).toBe(381);
  });

  test("is null for a branch Phoebe did not name", () => {
    expect(
      memberIssueNumber({ number: asPrNumber(42), headRefName: asBranchRef("dependabot/npm/x") }),
    ).toBeNull();
  });

  test("is null for the feature branch itself", () => {
    expect(
      memberIssueNumber({ number: asPrNumber(42), headRefName: asBranchRef("phoebe/feature-341") }),
    ).toBeNull();
  });
});

describe("withClosesSection", () => {
  test("adds a delimited block to a body that has none", () => {
    const update = withClosesSection("Part of #341.", [381]);
    expect(update).not.toBeNull();
    expect(update?.added).toEqual([381]);
    expect(update?.body).toContain(CLOSES_SECTION_START);
    expect(update?.body).toContain(CLOSES_SECTION_END);
    expect(update?.body).toContain("Closes #381");
    // The body Phoebe opened the PR with is still there, above the block.
    expect(update?.body.indexOf("Part of #341.")).toBeLessThan(
      update?.body.indexOf(CLOSES_SECTION_START) ?? -1,
    );
  });

  test("is a no-op once every member is listed, however many cycles run", () => {
    const first = withClosesSection("Part of #341.", [381, 382]);
    expect(first?.added).toEqual([381, 382]);
    expect(withClosesSection(first!.body, [381, 382])).toBeNull();
    expect(withClosesSection(first!.body, [382, 381])).toBeNull();
  });

  test("appends a newly merged member below the ones already listed", () => {
    const first = withClosesSection("Part of #341.", [381])!;
    const second = withClosesSection(first.body, [381, 382])!;
    expect(second.added).toEqual([382]);
    expect(closesLines(second.body)).toEqual(["Closes #381", "Closes #382"]);
  });

  test("lists one line per issue when two merged PRs name the same one", () => {
    const update = withClosesSection("", [381, 381])!;
    expect(closesLines(update.body)).toEqual(["Closes #381"]);
  });

  test("writes nothing when no member has merged yet", () => {
    expect(withClosesSection("Part of #341.", [])).toBeNull();
  });

  test("leaves a human's prose on both sides of the block untouched", () => {
    const first = withClosesSection("Part of #341.", [381])!;
    const edited = `${first.body}\n## Review notes\n\nStart with the migration.\n`;
    const second = withClosesSection(edited, [381, 382])!;
    expect(second.body).toContain("## Review notes");
    expect(second.body).toContain("Start with the migration.");
    expect(second.body).toContain("Part of #341.");
    expect(closesLines(second.body)).toEqual(["Closes #381", "Closes #382"]);
  });

  test("keeps a line a human added inside the block rather than rewriting it away", () => {
    // Phoebe only ever appends: a short read of the merged list must not drop
    // what the block already promises to close.
    const body = [CLOSES_SECTION_START, "", "Closes #999", "", CLOSES_SECTION_END].join("\n");
    const update = withClosesSection(body, [381])!;
    expect(closesLines(update.body)).toEqual(["Closes #999", "Closes #381"]);
  });

  test("reads a line a hand edit left trailing blanks on", () => {
    const first = withClosesSection("Part of #400.", [416, 415])!;
    // CRLF from the web UI, and the two spaces of a Markdown hard break.
    const handEdited = first.body.replaceAll("\n", "\r\n").replace("Closes #415", "Closes #415  ");
    expect(withClosesSection(handEdited, [416, 415])).toBeNull();
  });
});

// A stacked member merges into its blocker's branch, not the feature branch, so
// the sweep never sees it and a human records it by hand under the block —
// integration PR #430 carried three such lines (#418, #422, #423).
describe("withClosesSection, with a human's Closes lines below the block", () => {
  const stray = ["Closes #418", "Closes #422", "Closes #423"];

  /** The #430 shape: Phoebe's block, then a human's note and their own lines. */
  function bodyLikePr430(): string {
    const withBlock = withClosesSection("Part of #400.", [416, 415])!.body;
    return [
      withBlock,
      "PRs #438, #439 and #443 merged into `phoebe/issue-415` instead of this",
      "branch; their work came across when that branch merged:",
      "",
      ...stray,
      "",
    ].join("\n");
  }

  test("writes the next member inside the markers, not below the stray lines", () => {
    const update = withClosesSection(bodyLikePr430(), [416, 415, 417])!;
    expect(update.added).toEqual([417]);
    const line = update.body.indexOf("Closes #417");
    expect(line).toBeGreaterThan(update.body.indexOf(CLOSES_SECTION_START));
    expect(line).toBeLessThan(update.body.indexOf(CLOSES_SECTION_END));
  });

  test("leaves the human's lines and note where they wrote them", () => {
    const update = withClosesSection(bodyLikePr430(), [416, 415, 417])!;
    expect(update.body).toContain("their work came across when that branch merged:");
    const tail = update.body.slice(
      update.body.indexOf(CLOSES_SECTION_END) + CLOSES_SECTION_END.length,
    );
    expect(closesLines(tail)).toEqual(stray);
  });

  test("counts a line below the block as said, so no issue is closed twice", () => {
    expect(withClosesSection(bodyLikePr430(), [418])).toBeNull();
    const update = withClosesSection(bodyLikePr430(), [418, 417])!;
    expect(update.added).toEqual([417]);
    expect(closesLines(update.body)).toEqual([
      "Closes #415",
      "Closes #416",
      "Closes #417",
      ...stray,
    ]);
  });
});
