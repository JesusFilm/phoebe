// Blocking a ticket whose run said it needs a human (#817): which comments count
// as a live blocked marker, the comment the sweep posts, and the selection skip.

import { describe, expect, test } from "vite-plus/test";
import {
  BLOCKED_MARKER,
  buildBlockedComment,
  hasLiveBlockedMarker,
  PHOEBE_BLOCKED_LABEL,
} from "./blocked.ts";
import { selectIssue, unresolvedBlockerNumbers, type Issue } from "./orchestrator.ts";
import { buildUnitTimeoutMarker } from "./quarantine.ts";

const PHOEBE = "phoebe-bot";

const said = (body: string, authorLogin: string | null = PHOEBE) => ({ body, authorLogin });

describe("hasLiveBlockedMarker", () => {
  test("no comments, no marker", () => {
    expect(hasLiveBlockedMarker([], PHOEBE)).toBe(false);
  });

  test("Phoebe's comment carrying the marker on its own line is live", () => {
    const comment = said(`The Question needs a product decision.\n\n${BLOCKED_MARKER}`);
    expect(hasLiveBlockedMarker([comment], PHOEBE)).toBe(true);
  });

  test("a plain Phoebe comment is not a marker", () => {
    expect(hasLiveBlockedMarker([said("Tests fail on main; retrying later.")], PHOEBE)).toBe(false);
  });

  test("a marker someone else posted does not count", () => {
    expect(hasLiveBlockedMarker([said(BLOCKED_MARKER, "drive-by")], PHOEBE)).toBe(false);
    expect(hasLiveBlockedMarker([said(BLOCKED_MARKER, null)], PHOEBE)).toBe(false);
  });

  test("a quoted marker is not a fresh one", () => {
    expect(hasLiveBlockedMarker([said(`> ${BLOCKED_MARKER}`)], PHOEBE)).toBe(false);
  });

  test("a human reply after the marker leaves it live", () => {
    const comments = [said(BLOCKED_MARKER), said("Answered above, go ahead.", "human")];
    expect(hasLiveBlockedMarker(comments, PHOEBE)).toBe(true);
  });

  test("the acknowledgement spends the marker before it", () => {
    expect(hasLiveBlockedMarker([said(BLOCKED_MARKER), said(buildBlockedComment())], PHOEBE)).toBe(
      false,
    );
  });

  test("an unproductive-run marker spends the marker before it", () => {
    const comments = [said(BLOCKED_MARKER), said(buildUnitTimeoutMarker(1))];
    expect(hasLiveBlockedMarker(comments, PHOEBE)).toBe(false);
  });

  test("a new marker after an earlier acknowledgement is live again", () => {
    const comments = [said(BLOCKED_MARKER), said(buildBlockedComment()), said(BLOCKED_MARKER)];
    expect(hasLiveBlockedMarker(comments, PHOEBE)).toBe(true);
  });
});

describe("buildBlockedComment", () => {
  test("names the label and how to hand the ticket back", () => {
    const comment = buildBlockedComment();
    expect(comment).toContain(`\`${PHOEBE_BLOCKED_LABEL}\``);
    expect(comment).toContain("remove the");
  });
});

describe("selection skips a blocked ticket", () => {
  const issue = (number: number, over: Partial<Issue> = {}): Issue => ({
    number,
    title: `Ticket ${number}`,
    body: "",
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  });

  test("selectIssue passes over phoebe:blocked", () => {
    const issues = [issue(1, { labels: [PHOEBE_BLOCKED_LABEL] }), issue(2)];
    expect(selectIssue(issues, new Map())?.issue.number).toBe(2);
    expect(selectIssue([issues[0]!], new Map())).toBeNull();
  });

  test("a blocked ticket names no blocker in the idle line", () => {
    const blocked = issue(1, { body: "Blocked by #9", labels: [PHOEBE_BLOCKED_LABEL] });
    expect(unresolvedBlockerNumbers([blocked], new Map())).toEqual([]);
  });
});
