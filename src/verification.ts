// #17: the engine does not execute checkCommand/testCommand/readyCommand itself
// — by design (see the repo's Phoebe config comment), the agent runs them as
// part of its own workflow. This module reads back the structured report the agent is
// prompted to write after it verifies, and maps it into VerificationResult[]
// for the WorkOutcomeEvent — the producer #17 found missing. A missing or
// malformed report is not an error: it just means the caller gets no
// verification data, and the existing status-contract fallback reports
// `unknown` — an honest "Phoebe has no confirmation," not a fabricated result.

import { readFileSync, rmSync } from "node:fs";
import type { WorkOutcomeEvent } from "./status-contract.ts";

export type VerificationResult = WorkOutcomeEvent["verification"][number];

/** Output kept on a failing run, tail-first — the actionable error in a
 *  build/test failure is almost always in the last lines, not the first. */
const OUTPUT_TAIL_CHARS = 1_500;

/** Defensive cap on how many commands a single report can carry. */
const MAX_REPORTED_COMMANDS = 10;

type ReportedCommand = { command: string; exitCode: number; output?: string };

function isReportedCommand(value: unknown): value is ReportedCommand {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["command"] === "string" &&
    v["command"].length > 0 &&
    typeof v["exitCode"] === "number" &&
    Number.isInteger(v["exitCode"]) &&
    (v["output"] === undefined || typeof v["output"] === "string")
  );
}

function tail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…${trimmed.slice(trimmed.length - maxChars)}`;
}

function toVerificationResult(reported: ReportedCommand): VerificationResult {
  if (reported.exitCode === 0) {
    return { command: reported.command, status: "passed", summary: `${reported.command} passed.` };
  }
  return {
    command: reported.command,
    status: "failed",
    summary: `${reported.command} exited ${reported.exitCode}.\n${tail(reported.output ?? "", OUTPUT_TAIL_CHARS)}`,
  };
}

/**
 * Read and validate the agent-written verification report at `path`.
 * Returns `undefined` on anything short of a well-formed report — file
 * missing, invalid JSON, empty array, or any entry with the wrong shape —
 * rather than salvaging a partial result from a report that didn't match the
 * contract the agent was given.
 */
export function readVerificationReport(path: string): VerificationResult[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const reported = parsed.slice(0, MAX_REPORTED_COMMANDS);
  if (!reported.every(isReportedCommand)) return undefined;
  return reported.map(toVerificationResult);
}

/**
 * Best-effort removal of the report file. The file lives outside the
 * worktree (so the agent's own git operations can't sweep it into a commit),
 * so nothing else cleans it up — call this once per run, whether or not a
 * report was written, so a stale report never leaks into the next run on the
 * same branch.
 */
export function removeVerificationReport(path: string): void {
  rmSync(path, { force: true });
}
