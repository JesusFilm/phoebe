// The triage contract: the draft the agent writes, and the issue the kind
// renders from it — symptom block from Sentry, sections from the agent, the
// marker last, labels by verdict and policy.

import { describe, expect, test } from "vite-plus/test";
import type { SentryEvent, SentryGroup } from "./adapter.ts";
import { resolveSentryOptions } from "./options.ts";
import {
  labelsFor,
  parseTriageDraft,
  renderBody,
  renderDuplicateComment,
  renderTitle,
} from "./triage.ts";
import { parseMarker } from "./watermark.ts";

const options = resolveSentryOptions({ org: "acme", project: 1 }, "kinds.sentry");

const group: SentryGroup = {
  id: "4507",
  shortId: "ACME-9",
  title: "TypeError: Cannot read properties of undefined (reading 'config')",
  culprit: "src/test-setup.ts in <module>",
  level: "error",
  count: 86,
  firstSeen: "2026-09-04T00:00:00Z",
  lastSeen: "2026-09-11T11:00:00Z",
  permalink: "https://sentry.io/organizations/acme/issues/4507/",
  raw: {},
};

const event: SentryEvent = {
  eventId: "e1",
  release: "phoebe-agent@0.12.1",
  environment: "production",
  transaction: "boot",
  dateCreated: "2026-09-11T11:00:00Z",
  tags: [],
  frames: [
    {
      filename: "node_modules/vitest/x.js",
      function: "run",
      lineNo: 1,
      colNo: null,
      inApp: false,
      context: [],
    },
    {
      filename: "src/test-setup.ts",
      function: "<module>",
      lineNo: 21,
      colNo: 3,
      inApp: true,
      context: [[21, "setResolvedConfig(x.config);"]],
    },
  ],
  raw: {},
};

describe("parseTriageDraft", () => {
  test("a full draft round-trips with its optional fields trimmed", () => {
    const parsed = parseTriageDraft(
      JSON.stringify({
        verdict: "ready",
        cause: " src/x.ts:3 — y ",
        change: "z",
        test: "t",
        extra: 1,
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      draft: { verdict: "ready", cause: "src/x.ts:3 — y", change: "z", test: "t" },
    });
  });

  test("a duplicate is never ready", () => {
    const parsed = parseTriageDraft(JSON.stringify({ verdict: "ready", duplicateOf: 12 }));
    expect(parsed).toEqual({ ok: true, draft: { verdict: "not-ready", duplicateOf: 12 } });
  });

  test("a duplicateOf that is not an issue number forces not-ready and says so", () => {
    const parsed = parseTriageDraft(
      JSON.stringify({ verdict: "ready", duplicateOf: "12", cause: "c" }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.verdict).toBe("not-ready");
      expect(parsed.draft.duplicateOf).toBeUndefined();
      expect(parsed.draft.openQuestion).toContain('not as an issue number ("12")');
    }
  });

  test.each([
    ["{not json", "not JSON"],
    ["[]", "not a JSON object"],
    ['{"verdict":"maybe"}', 'verdict must be "ready" or "not-ready"'],
  ])("%s is unparseable, kept raw", (text, problem) => {
    const parsed = parseTriageDraft(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.raw).toBe(text);
      expect(parsed.problem).toContain(problem);
    }
  });
});

describe("renderTitle", () => {
  test("names the Sentry title and culprit", () => {
    expect(renderTitle(group)).toBe(
      "Sentry: TypeError: Cannot read properties of undefined (reading 'config') (src/test-setup.ts in <module>)",
    );
    expect(renderTitle({ ...group, culprit: "" })).toBe(
      "Sentry: TypeError: Cannot read properties of undefined (reading 'config')",
    );
  });
});

describe("renderBody", () => {
  test("a ready draft: symptom block from Sentry, the agent's three sections, the marker last", () => {
    const body = renderBody(
      { group, event, options, regressionOf: null },
      { ok: true, draft: { verdict: "ready", cause: "C", change: "H", test: "T" } },
    );
    expect(body).toContain("## Symptom");
    expect(body).toContain("| Events | 86 in the last 24h |");
    expect(body).toContain("| Release | phoebe-agent@0.12.1 |");
    expect(body).toContain(
      "- `src/test-setup.ts:21:3` in `<module>` — `setResolvedConfig(x.config);`",
    );
    expect(body).not.toContain("node_modules/vitest");
    expect(body).toContain("## Cause\n\nC");
    expect(body).toContain("## Change\n\nH");
    expect(body).toContain("## Test\n\nT");
    expect(body).not.toContain("## Open question");
    expect(body.trimEnd().endsWith("<!-- phoebe-sentry group=4507 -->")).toBe(true);
    expect(parseMarker(body)).toBe("4507");
    expect(body.startsWith("## Symptom")).toBe(true);
  });

  test("a regression opens by naming the closed issue", () => {
    const body = renderBody(
      { group, event, options, regressionOf: 31 },
      { ok: true, draft: { verdict: "not-ready", openQuestion: "Q" } },
    );
    expect(body.startsWith("Regression of #31")).toBe(true);
    expect(body).toContain("## Open question\n\nQ");
    expect(body).toContain("## Cause\n\n_Not located._");
  });

  test("a duplicate says so up top", () => {
    const body = renderBody(
      { group, event, options, regressionOf: null },
      { ok: true, draft: { verdict: "not-ready", duplicateOf: 12 } },
    );
    expect(body).toContain("Possibly duplicate of #12");
  });

  test("an unparseable draft files the raw text under its own heading", () => {
    const body = renderBody(
      { group, event, options, regressionOf: null },
      { ok: false, raw: "I think it is fine", problem: "not JSON (x)" },
    );
    expect(body).toContain("## Agent output (unparsed)");
    expect(body).toContain("```\nI think it is fine\n```");
    expect(parseMarker(body)).toBe("4507");
  });

  test("no frames at all is said, not crashed on", () => {
    const body = renderBody(
      { group, event: { ...event, frames: [], release: null }, options, regressionOf: null },
      { ok: true, draft: { verdict: "not-ready" } },
    );
    expect(body).toContain("_No stack frames on the latest event._");
    expect(body).toContain("| Release | none on the latest event |");
  });
});

describe("labelsFor", () => {
  const ready = { ok: true as const, draft: { verdict: "ready" as const } };
  const notReady = { ok: true as const, draft: { verdict: "not-ready" as const } };

  test("policy off: ready gets the triaged label for a human to flip", () => {
    expect(labelsFor(ready, options, "ready-for-agent")).toEqual(["sentry", "triaged"]);
    expect(labelsFor(notReady, options, "ready-for-agent")).toEqual(["sentry"]);
  });

  test("policy on: ready gets the tenant's ready label directly", () => {
    const on = { ...options, applyReadyLabel: true };
    expect(labelsFor(ready, on, "ready-for-agent")).toEqual(["sentry", "ready-for-agent"]);
  });

  test("an unparsed draft is not ready under either policy", () => {
    expect(
      labelsFor({ ok: false, raw: "", problem: "" }, { ...options, applyReadyLabel: true }, "r"),
    ).toEqual(["sentry"]);
  });
});

describe("renderDuplicateComment", () => {
  test("says what Sentry sees and where the triage went", () => {
    expect(renderDuplicateComment({ group, event, options, filedIssueNumber: 40 })).toBe(
      "Sentry is seeing this: [TypeError: Cannot read properties of undefined (reading 'config')](https://sentry.io/organizations/acme/issues/4507/) — 86 event(s) in the last 24h on release `phoebe-agent@0.12.1`. Triage filed as #40.",
    );
  });
});
