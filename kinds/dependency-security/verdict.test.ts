// The verdict markers: which comment is live, which issues a verdict can sit
// on, and that the shipped prompt writes the marker the scan reads.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import type { MentioningIssue } from "../../src/github-client.ts";
import { DEPENDENCIES_PROMPT_FILE } from "../dependencies-work/index.ts";
import { hasLiveVerdict, VERDICT_ACK_MARKER, VERDICT_MARKER, verdictIssues } from "./verdict.ts";

const verdict = `## Verdict\n\nNot affected.\n\n${VERDICT_MARKER}\n<!-- phoebe-blocked -->`;
const ack = `Phoebe closed the issue as not planned.\n\n${VERDICT_ACK_MARKER}`;

describe("hasLiveVerdict", () => {
  test("a verdict is live until an acknowledgement lands after it", () => {
    expect(hasLiveVerdict([])).toBe(false);
    expect(hasLiveVerdict(["Addressed by Phoebe"])).toBe(false);
    expect(hasLiveVerdict([verdict])).toBe(true);
    expect(hasLiveVerdict([verdict, "⏸️ parked"])).toBe(true);
    expect(hasLiveVerdict([verdict, ack])).toBe(false);
    expect(hasLiveVerdict([verdict, ack, "a later run's note"])).toBe(false);
    expect(hasLiveVerdict([verdict, ack, verdict])).toBe(true);
  });

  test("the marker counts only on a line of its own", () => {
    expect(hasLiveVerdict([`> ${VERDICT_MARKER}`])).toBe(false);
    expect(hasLiveVerdict([`as in \`${VERDICT_MARKER}\``])).toBe(false);
    expect(hasLiveVerdict(["<!--phoebe-verdict   not-affected-->"])).toBe(true);
  });

  test("an acknowledgement is not read as a verdict", () => {
    expect(hasLiveVerdict([ack])).toBe(false);
  });
});

describe("verdictIssues", () => {
  const issue = (number: number, key: string, overrides: Partial<MentioningIssue> = {}) =>
    ({
      number,
      body: `<!-- phoebe-dependencies bundle=${encodeURIComponent(key)} fingerprint=abc -->`,
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: ["dependencies", "security", "phoebe:dependencies"],
      ...overrides,
    }) satisfies MentioningIssue;

  test("only open, routed, per-package security issues", () => {
    const issues = [
      issue(1, "npm:security:tar"),
      issue(2, "npm:security-transitive"),
      issue(3, "npm:prod:relation:react"),
      issue(4, "npm:security:ws", { labels: ["dependencies", "security"] }),
      issue(5, "npm:security:qs", { state: "closed", stateReason: "not_planned" }),
      issue(6, "npm:security:ip", {
        labels: ["dependencies", "security", "phoebe:dependencies", "phoebe:blocked"],
      }),
    ];
    expect(verdictIssues(issues, "phoebe:dependencies").map((i) => i.number)).toEqual([1, 6]);
  });
});

describe("the shipped prompt", () => {
  const prompt = readFileSync(DEPENDENCIES_PROMPT_FILE, "utf8");

  test("writes the marker the scan reads, with the blocked marker after it", () => {
    expect(prompt).toContain(`${VERDICT_MARKER}\n  <!-- phoebe-blocked -->`);
    expect(hasLiveVerdict([`## Verdict\n\n${VERDICT_MARKER}`])).toBe(true);
  });

  test("says when a verdict is owed, what each requires, and to leave the issue alone", () => {
    expect(prompt).toContain('opens "Dropped from #N": reach a verdict before you attempt the fix');
    expect(prompt).toContain("Reach a verdict only if the fix still fails the gate");
    expect(prompt).toContain("A person has overruled an earlier verdict");
    expect(prompt).toContain(
      "never sees input an attacker controls, or never runs outside a build",
    );
    expect(prompt).toContain("Treat the ticket as affected and apply the fix");
    expect(prompt).toContain(
      "Do not close the issue and do not touch its labels, whatever the verdict",
    );
  });
});
