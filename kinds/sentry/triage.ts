// The triage contract (#472): the agent writes `triage.json` to scratch and the
// kind files from it. The symptom block is rendered by the kind from Sentry
// data, so it cannot be hallucinated; the agent supplies the located cause,
// the change, the test and, for a not-ready verdict, the open question. Two
// outcomes and never none: every successful run files an issue, because the
// issue is the watermark.

import type { SentryEvent, SentryGroup } from "./adapter.ts";
import type { SentryKindOptions } from "./options.ts";
import { renderMarker } from "./watermark.ts";

/** The file the prompt tells the agent to write. */
export const TRIAGE_FILE = "triage.json";

export type TriageVerdict = "ready" | "not-ready";

/** What the agent hands back. Only `verdict` is required. */
export type TriageDraft = {
  verdict: TriageVerdict;
  cause?: string;
  change?: string;
  test?: string;
  openQuestion?: string;
  /** A human-filed open issue this crash already belongs to. */
  duplicateOf?: number;
};

export type ParsedTriage =
  | { ok: true; draft: TriageDraft }
  | { ok: false; raw: string; problem: string };

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Read the agent's draft. Anything the kind cannot make sense of is
 * `ok: false` with the raw text, which files as not-ready under an
 * "Agent output (unparsed)" heading rather than failing the run: the
 * watermark invariant holds whenever the agent produced anything at all.
 */
export function parseTriageDraft(text: string): ParsedTriage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      raw: text,
      problem: `not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, raw: text, problem: "not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const verdict = record["verdict"];
  if (verdict !== "ready" && verdict !== "not-ready") {
    return { ok: false, raw: text, problem: `verdict must be "ready" or "not-ready"` };
  }
  const duplicateOf = record["duplicateOf"];
  const draft: TriageDraft = { verdict };
  const cause = optionalText(record["cause"]);
  const change = optionalText(record["change"]);
  const test = optionalText(record["test"]);
  const openQuestion = optionalText(record["openQuestion"]);
  if (cause !== undefined) draft.cause = cause;
  if (change !== undefined) draft.change = change;
  if (test !== undefined) draft.test = test;
  if (openQuestion !== undefined) draft.openQuestion = openQuestion;
  if (duplicateOf !== undefined && duplicateOf !== null) {
    if (typeof duplicateOf === "number" && Number.isInteger(duplicateOf) && duplicateOf > 0) {
      draft.duplicateOf = duplicateOf;
    } else {
      // The agent meant "a human already filed this" and got the number wrong.
      // The claim still stands, so the verdict cannot be ready; the number is
      // dropped and the open question says why.
      draft.verdict = "not-ready";
      draft.openQuestion =
        `The triage named a duplicate but not as an issue number (${JSON.stringify(duplicateOf)}); ` +
        `find the human-filed issue this crash belongs to.` +
        (draft.openQuestion !== undefined ? `\n\n${draft.openQuestion}` : "");
    }
  }
  // A duplicate is never ready: the human merges or closes it (#472).
  if (draft.duplicateOf !== undefined) draft.verdict = "not-ready";
  return { ok: true, draft };
}

/** Everything the body needs that came from Sentry rather than the agent. */
export type SymptomInput = {
  group: SentryGroup;
  event: SentryEvent;
  options: SentryKindOptions;
  /** The issue this one is a regression of (#471), when it is. */
  regressionOf: number | null;
};

/** `Sentry: <title> (<culprit>)`, the culprit dropped when Sentry has none. */
export function renderTitle(group: SentryGroup): string {
  const culprit = group.culprit.trim();
  return culprit.length > 0 ? `Sentry: ${group.title} (${culprit})` : `Sentry: ${group.title}`;
}

const MAX_FRAMES = 10;

function renderFrames(event: SentryEvent): string {
  if (event.frames.length === 0) return "_No stack frames on the latest event._";
  // Innermost first: the throw site is what a reader wants at the top, and
  // in-app frames before vendored ones, since those are where the cause lives.
  const ordered = [...event.frames].reverse();
  const inApp = ordered.filter((frame) => frame.inApp);
  const shown = (inApp.length > 0 ? inApp : ordered).slice(0, MAX_FRAMES);
  const lines = shown.map((frame) => {
    const where = `${frame.filename ?? "?"}:${frame.lineNo ?? "?"}${frame.colNo !== null ? `:${frame.colNo}` : ""}`;
    const fn = frame.function ?? "<anonymous>";
    const line = frame.context.find(([n]) => n === frame.lineNo)?.[1]?.trim();
    return `- \`${where}\` in \`${fn}\`${line !== undefined && line.length > 0 ? ` — \`${line}\`` : ""}`;
  });
  const omitted = (inApp.length > 0 ? inApp : ordered).length - shown.length;
  if (omitted > 0) lines.push(`- _…${omitted} more frame(s) in the event_`);
  return lines.join("\n");
}

function renderSymptom(input: SymptomInput): string {
  const { group, event, options } = input;
  const rows: Array<[string, string]> = [
    ["Level", group.level],
    ["Events", `${group.count} in the last ${options.window}`],
    ["First seen", group.firstSeen || "unknown"],
    ["Last seen", group.lastSeen || "unknown"],
    ["Release", event.release ?? "none on the latest event"],
    ["Environment", event.environment ?? "unknown"],
    ["Transaction", event.transaction ?? "unknown"],
    ["Sentry", group.permalink.length > 0 ? group.permalink : `group ${group.id}`],
  ];
  const table = ["| | |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
  return `## Symptom\n\n**${group.title}**${group.culprit ? ` in \`${group.culprit}\`` : ""}\n\n${table}\n\n### Stack\n\n${renderFrames(event)}`;
}

function section(heading: string, text: string | undefined, fallback: string): string {
  return `## ${heading}\n\n${text ?? fallback}`;
}

/**
 * The whole issue body. The kind's block first, then the agent's sections,
 * then the marker on its own line at the end where a reader never sees it
 * and the next cycle's search always does.
 */
export function renderBody(input: SymptomInput, triage: ParsedTriage): string {
  const parts: string[] = [];
  if (input.regressionOf !== null) {
    parts.push(
      `Regression of #${input.regressionOf}: the linked fix shipped and Sentry has seen this group again since it closed.`,
    );
  }
  if (triage.ok && triage.draft.duplicateOf !== undefined) {
    parts.push(
      `Possibly duplicate of #${triage.draft.duplicateOf}. Filed so the crash is on record; merge or close as not planned.`,
    );
  }
  parts.push(renderSymptom(input));
  if (triage.ok) {
    const { draft } = triage;
    parts.push(section("Cause", draft.cause, "_Not located._"));
    parts.push(section("Change", draft.change, "_Not decided._"));
    parts.push(section("Test", draft.test, "_Not named._"));
    if (draft.verdict === "not-ready") {
      parts.push(
        section(
          "Open question",
          draft.openQuestion,
          "_The triage did not say what is still unknown._",
        ),
      );
    }
  } else {
    parts.push(
      `## Agent output (unparsed)\n\nThe triage agent wrote something the kind could not read as a draft (${triage.problem}). Filed as not ready.\n\n\`\`\`\n${triage.raw.trim()}\n\`\`\``,
    );
  }
  parts.push(renderMarker(input.group.id));
  return `${parts.join("\n\n")}\n`;
}

/**
 * The labels a filed issue wears (#472): `label` always; a ready verdict adds
 * `triagedLabel` for a human to flip, or the tenant's `readyLabel` directly
 * when the tenant made that a standing decision with `applyReadyLabel`.
 */
export function labelsFor(
  triage: ParsedTriage,
  options: SentryKindOptions,
  readyLabel: string,
): string[] {
  const labels = [options.label];
  if (triage.ok && triage.draft.verdict === "ready") {
    labels.push(options.applyReadyLabel ? readyLabel : options.triagedLabel);
  }
  return labels;
}

/** The one comment the kind posts on a human's open issue a triage duplicated. */
export function renderDuplicateComment(input: {
  group: SentryGroup;
  event: SentryEvent;
  options: SentryKindOptions;
  filedIssueNumber: number;
}): string {
  const { group, event, options } = input;
  const link = group.permalink.length > 0 ? `[${group.title}](${group.permalink})` : group.title;
  return (
    `Sentry is seeing this: ${link} — ${group.count} event(s) in the last ${options.window}` +
    `${event.release !== null ? ` on release \`${event.release}\`` : ""}. ` +
    `Triage filed as #${input.filedIssueNumber}.`
  );
}
