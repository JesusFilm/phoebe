// What the observer writes on GitHub and in its unit record (#934). Code
// writes every word a person reads outside the finding's own prose, and every
// marker, so neither can be left out or forged by the grouping run.

import type { FlaggedUnit } from "./evidence.ts";
import { ALLOWLIST_TEXT } from "./edit.ts";
import { CATEGORY_TEXT, type Finding, type Omission } from "./findings.ts";
import { renderFindingMarker, renderUnitsMarker } from "./proposals.ts";

/** The heading the problem text sits under in every proposal body. */
const PROBLEM_HEADING = "## What keeps going wrong";

/** The most characters of a unit's `detail` an evidence line quotes. */
export const EVIDENCE_DETAIL_MAX = 200;

/**
 * Text from a record or the grouping run, made safe to put in a body: an HTML
 * comment opener is broken so nothing quoted can pass for a marker.
 */
export function defang(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function code(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
}

/** One evidence line: where, what, how it ended, when, and the record's own words. */
export function evidenceLine(unit: FlaggedUnit): string {
  const { record } = unit;
  const prNumber = unit.pr?.number ?? record.prNumber;
  const pr = prNumber === null ? "" : ` (PR #${prNumber})`;
  const when = record.startedAt.slice(0, 16).replace("T", " ");
  const detail =
    record.detail === null ? "" : `: ${defang(oneLine(record.detail, EVIDENCE_DETAIL_MAX))}`;
  return (
    `- ${code(unit.pipeline)} ${code(record.unit.kind)} ${code(record.unit.id)}${pr}, ` +
    `${unit.flags.join(", ")}, started ${when} UTC${detail}`
  );
}

export function renderTitle(finding: Finding): string {
  return `Observer: ${finding.title}`;
}

/**
 * The body a new proposal opens with: an issue, or a PR when PR mode opened
 * one. `attempt` is set on an issue PR mode meant to be a PR.
 */
export function renderBody(opts: {
  finding: Finding;
  units: readonly FlaggedUnit[];
  lookback: string;
  regressionOf: number | null;
  as?: "issue" | "pr";
  attempt?: EditAttemptNote;
}): string {
  const { finding, units } = opts;
  const pr = opts.as === "pr";
  const lines: string[] = [renderFindingMarker(finding.key), ""];
  lines.push(
    pr
      ? "> Proposed by Phoebe's observer from its unit history. A person reviews it and " +
          "decides whether it merges."
      : "> Proposed by Phoebe's observer from its unit history. Phoebe does not work this " +
          "until a person decides it should and gives it the ready label.",
    "",
  );
  if (opts.regressionOf !== null) {
    lines.push(
      `**Regression of #${opts.regressionOf}.** That proposal was closed as completed, ` +
        "and the units below ran into the same problem after it closed.",
      "",
    );
  }
  lines.push(
    `**Category:** ${CATEGORY_TEXT[finding.category]}`,
    `**Target:** ${code(finding.target)}`,
    "",
    PROBLEM_HEADING,
    "",
    defang(finding.problem === "" ? finding.title : finding.problem),
    "",
  );
  if (finding.fix !== "") {
    lines.push(pr ? "## The fix" : "## Suggested fix", "", defang(finding.fix), "");
  }
  if (opts.attempt !== undefined) lines.push(...renderAttempt(opts.attempt));
  lines.push(
    "## Evidence",
    "",
    `${units.length} unit(s) in the last ${opts.lookback}:`,
    "",
    ...units.map(evidenceLine),
    "",
    renderUnitsMarker(units.map((unit) => unit.key)),
  );
  return `${lines.join("\n")}\n`;
}

/** The most characters of a proposal's problem the grouping run is shown. */
export const PROBLEM_PARAGRAPH_MAX = 400;

/**
 * The first paragraph of what a proposal says keeps going wrong, read back
 * from the body `renderBody` wrote, on one line. `null` when the body has no
 * such section, as when a person rewrote it.
 */
export function problemParagraph(body: string): string | null {
  const at = body.indexOf(PROBLEM_HEADING);
  if (at === -1) return null;
  const rest = body.slice(at + PROBLEM_HEADING.length).trim();
  if (rest.startsWith("## ")) return null;
  const paragraph = rest.split(/\n\s*\n/)[0] ?? "";
  const line = oneLine(paragraph, PROBLEM_PARAGRAPH_MAX);
  return line === "" ? null : line;
}

/** The most characters of a cause a fold comment quotes. */
export const CAUSE_MAX = 300;

/**
 * A finding's cause: the first sentence of its problem, which the grouping
 * prompt asks to name the cause, or its title when the problem is empty.
 */
export function causeOf(finding: Finding): string {
  const paragraph = finding.problem.split(/\n\s*\n/)[0]?.trim() ?? "";
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;
  return oneLine(sentence === "" ? finding.title : sentence, CAUSE_MAX);
}

/**
 * The comment new evidence for an open proposal becomes. It leads with the
 * finding's cause, so a person can spot units that do not belong there.
 */
export function renderFoldComment(finding: Finding, units: readonly FlaggedUnit[]): string {
  return [
    `**Cause:** ${defang(causeOf(finding))}`,
    "",
    `The observer saw this again in ${units.length} more unit(s):`,
    "",
    ...units.map(evidenceLine),
    "",
    renderUnitsMarker(units.map((unit) => unit.key)),
    "",
  ].join("\n");
}

/** What one run did, counted for its summary. */
export type RunTally = {
  filed: number[];
  /** The open proposal each fold went into. */
  foldedInto: number[];
  skipped: number;
};

/** The most characters of an omission's cause the summary quotes. */
export const OMISSION_CAUSE_MAX = 120;

/**
 * The run's one-line summary, which becomes its unit record's `detail`:
 * `2 proposals filed (#41, #42), 1 folded into #38, 1 skipped; coverage work
 * 14d, intake 9d`. Each problem the grouping run left out as already fixed
 * follows, as its cause and the ref that fixed it, so the omission can be
 * checked: `; omitted as fixed: Installs fail on pnpm 12 (#872)`. They come
 * last because the record cuts `detail` to 500 characters.
 */
export function renderSummary(
  tally: RunTally,
  coverage: string,
  omitted: readonly Omission[] = [],
): string {
  const parts: string[] = [];
  if (tally.filed.length > 0) {
    const noun = tally.filed.length === 1 ? "proposal" : "proposals";
    parts.push(
      `${tally.filed.length} ${noun} filed (${tally.filed.map((n) => `#${n}`).join(", ")})`,
    );
  }
  if (tally.foldedInto.length > 0) {
    parts.push(
      `${tally.foldedInto.length} folded into ${tally.foldedInto.map((n) => `#${n}`).join(", ")}`,
    );
  }
  if (tally.skipped > 0) parts.push(`${tally.skipped} skipped`);
  if (parts.length === 0) parts.push("nothing filed");
  const summary = `${parts.join(", ")}; ${coverage}`;
  if (omitted.length === 0) return summary;
  const omissions = omitted.map(
    (omission) =>
      `${oneLine(omission.cause, OMISSION_CAUSE_MAX)} (${oneLine(omission.fixedBy, 40)})`,
  );
  return `${summary}; omitted as fixed: ${omissions.join("; ")}`;
}
/** Why a finding PR mode would have opened as a PR was filed as an issue instead. */
export type EditAttemptNote =
  | { reason: "empty" }
  | { reason: "outside"; changed: readonly string[]; outside: readonly string[] }
  | { reason: "untracked"; untracked: readonly string[]; diff: string };

/** The most characters of a suggested diff an issue quotes. */
export const DIFF_MAX = 40_000;

/** Break only the markers this kind reads, so a quoted diff stays applicable. */
function defangMarkers(text: string): string {
  return text.replace(/<!--(\s*phoebe-observer)/g, "&lt;!--$1");
}

/** A fenced block longer than any backtick run inside it. */
function fenced(text: string, lang: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text.endsWith("\n") ? text : `${text}\n`}${fence}`;
}

function pathList(paths: readonly string[]): string[] {
  return paths.map((path) => `- ${code(path)}`);
}

/** The section an issue that PR mode fell back to opens its account with. */
export function renderAttempt(note: EditAttemptNote): string[] {
  const lines = ["## Why this is an issue and not a PR", ""];
  if (note.reason === "empty") {
    lines.push("The edit run for this finding changed nothing, so there was no PR to open.", "");
    return lines;
  }
  if (note.reason === "outside") {
    lines.push(
      "The edit run for this finding changed paths an observer PR may not touch, so " +
        "nothing was pushed. Outside the allowlist:",
      "",
      ...pathList(note.outside),
      "",
      "Every path it changed:",
      "",
      ...pathList(note.changed),
      "",
      `An observer PR may change only ${ALLOWLIST_TEXT.join(", ")}.`,
      "",
    );
    return lines;
  }
  const diff =
    note.diff.length > DIFF_MAX
      ? `${note.diff.slice(0, DIFF_MAX)}\n… cut at ${DIFF_MAX} of ${note.diff.length} characters\n`
      : note.diff;
  lines.push(
    "The fix edits files this repository does not track at these paths, so a PR here " +
      "would change files nothing reads:",
    "",
    ...pathList(note.untracked),
    "",
    "Apply the suggested diff where the governing files live:",
    "",
    fenced(defangMarkers(diff), "diff"),
    "",
  );
  return lines;
}
