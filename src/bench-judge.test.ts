// The bench judge's pieces (#942). The judge run itself is driven end to end in
// src/bench-run.test.ts, with a fake judge.

import { describe, expect, test } from "vite-plus/test";
import {
  issueDocument,
  JUDGE_PROMPT_SHA,
  JUDGE_PROMPT_TEMPLATE,
  judgePrompt,
  parseVerdict,
} from "./bench-judge.ts";
import type { BenchFixture } from "./contracts/bench.ts";
import { promptShaOf } from "./unit-record.ts";

const FIXTURE: BenchFixture = {
  issue: {
    number: 7,
    title: "Fix the widget",
    body: "It breaks.",
    comments: [
      { author: "ana", createdAt: "2026-11-01T00:00:00Z", body: "Also the gadget." },
      { author: null, createdAt: "2026-11-02T00:00:00Z", body: "+1" },
    ],
  },
  pr: { number: 70, headSha: "h".repeat(40), mergeSha: "m".repeat(40) },
  baseSha: "b".repeat(40),
};

describe("parseVerdict", () => {
  test("reads the last JSON object that names a verdict", () => {
    expect(
      parseVerdict(
        'Looked at {"files": 2}.\n{"verdict": "worse", "rationale": "x"}\n{"verdict": "Equivalent", "rationale": " Same fix. "}',
      ),
    ).toEqual({ verdict: "equivalent", rationale: "Same fix." });
  });

  test("a verdict with no rationale keeps none", () => {
    expect(parseVerdict('{"verdict":"wrong"}')).toEqual({ verdict: "wrong", rationale: null });
  });

  test("a verdict off the scale, or no verdict at all, is none", () => {
    expect(parseVerdict('{"verdict": "great"}')).toBeNull();
    expect(parseVerdict("better")).toBeNull();
    expect(parseVerdict("{not json}")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });

  test("caps the rationale", () => {
    const long = "y".repeat(2000);
    expect(
      parseVerdict(JSON.stringify({ verdict: "better", rationale: long }))!.rationale,
    ).toHaveLength(500);
  });
});

describe("the judge's inputs", () => {
  test("the issue document holds the title, body and comments as pinned", () => {
    const doc = issueDocument(FIXTURE);
    expect(doc).toContain("# #7: Fix the widget");
    expect(doc).toContain("It breaks.");
    expect(doc).toContain("### ana at 2026-11-01T00:00:00Z\n\nAlso the gadget.");
    expect(doc).toContain("### (deleted account) at 2026-11-02T00:00:00Z");
    expect(issueDocument({ ...FIXTURE, issue: { ...FIXTURE.issue, comments: [] } })).not.toContain(
      "## Comments",
    );
  });

  test("the prompt names the fixture and the fixed scale, and hashes as its template", () => {
    const prompt = judgePrompt(FIXTURE);
    expect(prompt).toContain("Issue #7 was solved");
    expect(prompt).toContain("(PR #70)");
    expect(prompt).not.toContain("{{");
    for (const verdict of ["better", "equivalent", "worse", "wrong"]) {
      expect(prompt).toContain(`\`${verdict}\``);
    }
    expect(JUDGE_PROMPT_SHA).toBe(promptShaOf(JUDGE_PROMPT_TEMPLATE));
  });
});
