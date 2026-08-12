// #17: originally the engine never executed checkCommand/testCommand/
// readyCommand itself — by design (see the repo's Phoebe config comment), the
// agent ran them as part of its own workflow, and this module only read back
// the structured report the agent was prompted to write after it verified,
// mapping it into VerificationResult[] for the WorkOutcomeEvent. A missing or
// malformed report was not an error: it just meant the caller got no
// verification data, and the existing status-contract fallback reports
// `unknown` — an honest "Phoebe has no confirmation," not a fabricated
// result. That fallback protects against an *absent* report, not a
// *fabricated* one: an agent run with its permission gate bypassed (see the
// provider argv in `src/providers/providers.ts`) can write a well-formed
// report without ever having run the commands it describes.
//
// #166 adds a second, engine-side path: `runEngineVerification` executes the
// same commands itself, in the same worktree, after the agent exits — an
// authoritative result independent of anything the agent claims. Which path
// (or both) a run uses is `PhoebeConfig.verifyMode` (`src/config/types.ts`);
// the call sites live in `src/kinds/janitor.ts` and `src/kinds/producer.ts`.

import { readFileSync, rmSync } from "node:fs";
import type { VerifyMode } from "./config/index.ts";
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

/**
 * One command's engine-side execution — a shell seam, not a network/API call,
 * so it never throws: a nonzero exit or a timeout is a result, not an error.
 * `timedOut` (#173) is the engine's own signal that the command was killed on
 * `SHELL_COMMAND_TIMEOUT_MS` rather than exiting on its own — optional so a
 * capture implementation that can't distinguish the two (none exist today,
 * but a future/test stand-in might) is still a valid `CaptureCommand`.
 */
export type CaptureCommand = (
  command: string,
  cwd: string,
) => { exitCode: number; output: string; timedOut?: boolean };

/**
 * Run `commands` in `cwd` via `capture` and map each to a `VerificationResult`
 * — the engine's own authoritative verification run (#166), independent of
 * anything the agent claims. Mirrors `readVerificationReport`'s shape so an
 * engine-run result and an agent-reported one are interchangeable wherever
 * `VerificationResult[]` is consumed. `timedOut` (#173) rides along as an
 * additive field, distinct from `status` (still just `"failed"`) — a typed
 * park reason for callers that need to tell a hang from an ordinary failure,
 * without breaking anything reading `status` alone.
 */
export function runEngineVerification(
  commands: readonly string[],
  cwd: string,
  capture: CaptureCommand,
): VerificationResult[] {
  return commands.map((command) => {
    const { exitCode, output, timedOut } = capture(command, cwd);
    const result = toVerificationResult({ command, exitCode, output });
    return timedOut ? { ...result, timedOut: true } : result;
  });
}

/**
 * Compare the agent's self-report against the engine's own run of the same
 * commands (#166). A command the engine ran that the agent didn't mention, or
 * reported a different status for, is a disagreement — the agent's self-report
 * cannot be trusted for that unit. Order-independent: matches by command
 * string, not position, since a report is free to list commands in whatever
 * order the agent ran them.
 */
export function diffVerification(
  agentReported: readonly VerificationResult[] | undefined,
  engineRun: readonly VerificationResult[],
): string[] {
  const disagreements: string[] = [];
  for (const engineResult of engineRun) {
    const agentResult = agentReported?.find((r) => r.command === engineResult.command);
    if (!agentResult) {
      disagreements.push(
        `"${engineResult.command}": agent reported nothing, engine observed ${engineResult.status}.`,
      );
    } else if (agentResult.status !== engineResult.status) {
      disagreements.push(
        `"${engineResult.command}": agent reported ${agentResult.status}, engine observed ${engineResult.status}.`,
      );
    }
  }
  return disagreements;
}

/**
 * The single call site every kind's agent-run workflow uses to settle on a
 * final `VerificationResult[]` under `PhoebeConfig.verifyMode` (#166):
 *  - `"agent"` (default): today's behavior, unchanged — the agent's
 *    self-report as-is, `runEngine` never called.
 *  - `"engine"`: the engine's own run is authoritative; the agent's report is
 *    never even read for this decision.
 *  - `"both"` (recommended shadow-mode rollout): the engine's own run is
 *    still authoritative, but `onDisagreement` fires when it diverges from
 *    the agent's self-report — a mismatch is itself a high-value signal, not
 *    something to silently discard.
 * `runEngine` is a thunk, not the array itself, so `"agent"` mode never pays
 * for a checkCommand/testCommand run it doesn't need.
 */
export function resolveVerification(opts: {
  verifyMode: VerifyMode;
  agentReported: readonly VerificationResult[] | undefined;
  runEngine: () => VerificationResult[];
  onDisagreement: (disagreements: readonly string[]) => void;
}): readonly VerificationResult[] | undefined {
  if (opts.verifyMode === "agent") {
    return opts.agentReported;
  }
  const engineRun = opts.runEngine();
  if (opts.verifyMode === "both") {
    const disagreements = diffVerification(opts.agentReported, engineRun);
    if (disagreements.length > 0) {
      opts.onDisagreement(disagreements);
    }
  }
  return engineRun;
}
