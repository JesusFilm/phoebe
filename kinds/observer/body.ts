// What the observer writes on GitHub and in its unit record (#934). Code
// writes every word a person reads outside the finding's own prose, and every
// marker, so neither can be left out or forged by the grouping run.

import type { FlaggedUnit } from "./evidence.ts";
import { CATEGORY_TEXT, type Finding } from "./findings.ts";
import { renderFindingMarker, renderUnitsMarker } from "./proposals.ts";

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

/** The issue a new proposal opens with. */
export function renderBody(opts: {
  finding: Finding;
  units: readonly FlaggedUnit[];
  lookback: string;
  regressionOf: number | null;
}): string {
  const { finding, units } = opts;
  const lines: string[] = [renderFindingMarker(finding.key), ""];
  lines.push(
    "> Proposed by Phoebe's observer from its unit history. Phoebe does not work this " +
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
    "## What keeps going wrong",
    "",
    defang(finding.problem === "" ? finding.title : finding.problem),
    "",
  );
  if (finding.fix !== "") {
    lines.push("## Suggested fix", "", defang(finding.fix), "");
  }
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

/** The comment new evidence for an open proposal becomes. */
export function renderFoldComment(units: readonly FlaggedUnit[]): string {
  return [
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

/**
 * The run's one-line summary, which becomes its unit record's `detail`:
 * `2 proposals filed (#41, #42), 1 folded into #38, 1 skipped; coverage work
 * 14d, intake 9d`.
 */
export function renderSummary(tally: RunTally, coverage: string): string {
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
  return `${parts.join(", ")}; ${coverage}`;
}
