// The agent fallback source (ADR 0003, "The agent enumerates"): for manifests
// no native row claimed, a read-only agent run lists the direct dependencies
// and what is newer, and writes them to a file in scratch. The engine reads
// that file the way the Sentry kind reads `triage.json`: the agent hands back
// data, never files anything, and every record is checked against the
// candidate contract before policy or grouping sees it. A record that fails
// the check is dropped and counted; a run that leaves no file is a failed
// source.
//
// The run uses the calling kind's prompt, so a detector declares
// DEPENDENCY_DETECT_PROMPT_FILE as its `promptFile` and a consumer overrides
// it on the kind block like any other prompt. The agent gets no token beyond
// what the kind's `agentEnv` already grants.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { WorkKindRunCtx } from "../../../src/work-kinds/definition.ts";
import {
  byText,
  DEP_TYPES,
  SEVERITIES,
  UPDATE_TYPES,
  type Advisory,
  type Candidate,
} from "../candidate.ts";
import type { SourceResult } from "./source.ts";

/** The name the detectors' `sources` option lists this source by. */
export const AGENT_SOURCE_NAME = "agent";

/** The shipped detection prompt, an absolute path into the engine checkout. */
export const DEPENDENCY_DETECT_PROMPT_FILE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "prompts",
  "dependency-detect-prompt.md",
);

/** The manifests the native rows already list, written for the agent to skip. */
export const CLAIMED_FILE = "agent-claimed-manifests.json";
/** The file the prompt tells the agent to write. */
export const CANDIDATES_FILE = "agent-candidates.json";

/** How many drop reasons one log line names before it just counts. */
const REASONS_LOGGED = 3;

/** The part of a kind's run context this source reaches. */
export type AgentSourceCtx = Pick<WorkKindRunCtx, "agent" | "workspace" | "log">;

export type ParsedCandidates =
  | { ok: true; candidates: Candidate[]; dropped: string[] }
  | { ok: false; problem: string };

type Checked<T> = { ok: true; value: T } | { ok: false; problem: string };

function text(record: Record<string, unknown>, key: string): Checked<string> {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, problem: `${key} must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}

/** An absent or null field is left out; anything else must be a string. */
function optionalText(record: Record<string, unknown>, key: string): Checked<string | undefined> {
  const value = record[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, problem: `${key} must be a string` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
}

function oneOf<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): Checked<T> {
  const value = record[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    return { ok: false, problem: `${key} must be one of ${allowed.join(", ")}` };
  }
  return { ok: true, value: value as T };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function advisory(value: unknown): Checked<Advisory> {
  if (!isRecord(value)) return { ok: false, problem: "an advisory must be an object" };
  const id = text(value, "id");
  if (!id.ok) return { ok: false, problem: `advisory ${id.problem}` };
  const severity = oneOf(value, "severity", SEVERITIES);
  if (!severity.ok) return { ok: false, problem: `advisory ${severity.problem}` };
  // No fixedIn reads as no fix released, which keeps the maturity wait in place.
  const fixedIn = optionalText(value, "fixedIn");
  if (!fixedIn.ok) return { ok: false, problem: `advisory ${fixedIn.problem}` };
  return {
    ok: true,
    value: { id: id.value, severity: severity.value, fixedIn: fixedIn.value ?? null },
  };
}

/**
 * One record as a candidate, or why it is not one. An absent `advisories` or
 * `peers` is an empty list; a present one that is malformed anywhere drops the
 * whole record, since half an advisory list could skip a wait it should not.
 */
export function checkCandidate(value: unknown): Checked<Candidate> {
  if (!isRecord(value)) return { ok: false, problem: "not a JSON object" };
  const manager = text(value, "manager");
  if (!manager.ok) return manager;
  const pkg = text(value, "package");
  if (!pkg.ok) return pkg;
  const current = text(value, "current");
  if (!current.ok) return current;
  const target = text(value, "target");
  if (!target.ok) return target;
  const updateType = oneOf(value, "updateType", UPDATE_TYPES);
  if (!updateType.ok) return updateType;
  const depType = oneOf(value, "depType", DEP_TYPES);
  if (!depType.ok) return depType;
  const workspace = text(value, "workspace");
  if (!workspace.ok) return workspace;
  if (isAbsolute(workspace.value)) {
    return { ok: false, problem: "workspace must be relative to the checkout" };
  }
  const publishedAt = optionalText(value, "publishedAt");
  if (!publishedAt.ok) return publishedAt;
  const repositoryUrl = optionalText(value, "repositoryUrl");
  if (!repositoryUrl.ok) return repositoryUrl;

  const rawAdvisories = value["advisories"] ?? [];
  if (!Array.isArray(rawAdvisories)) return { ok: false, problem: "advisories must be an array" };
  const advisories: Advisory[] = [];
  for (const raw of rawAdvisories) {
    const checked = advisory(raw);
    if (!checked.ok) return checked;
    advisories.push(checked.value);
  }
  const rawPeers = value["peers"] ?? [];
  if (!Array.isArray(rawPeers) || !rawPeers.every((peer) => typeof peer === "string")) {
    return { ok: false, problem: "peers must be an array of strings" };
  }

  const candidate: Candidate = {
    manager: manager.value,
    package: pkg.value,
    current: current.value,
    target: target.value,
    updateType: updateType.value,
    depType: depType.value,
    workspace: workspace.value,
    advisories: advisories.sort((a, b) => byText(a.id, b.id)),
    peers: [...new Set(rawPeers as string[])].sort(byText),
  };
  if (publishedAt.value !== undefined) candidate.publishedAt = publishedAt.value;
  if (repositoryUrl.value !== undefined) candidate.repositoryUrl = repositoryUrl.value;
  return { ok: true, value: candidate };
}

/**
 * Read the agent's file: a JSON array of candidate records. A file that is
 * not a JSON array is `ok: false`. Otherwise every record that passes the
 * check is kept and every one that fails is named in `dropped`, as is a
 * record for a manifest a native row already claimed, which that row lists.
 */
export function parseAgentCandidates(
  fileText: string,
  claimed: readonly string[] = [],
): ParsedCandidates {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch (error) {
    return {
      ok: false,
      problem: `not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!Array.isArray(parsed)) return { ok: false, problem: "not a JSON array" };
  const claimedSet = new Set(claimed);
  const candidates: Candidate[] = [];
  const dropped: string[] = [];
  parsed.forEach((record, index) => {
    const checked = checkCandidate(record);
    if (!checked.ok) {
      dropped.push(`record ${index}: ${checked.problem}`);
    } else if (claimedSet.has(checked.value.workspace)) {
      dropped.push(`record ${index}: ${checked.value.workspace} is claimed by a native row`);
    } else {
      candidates.push(checked.value);
    }
  });
  return { ok: true, candidates, dropped };
}

/**
 * Run the agent over the manifests no native row claimed and read back what
 * it wrote. Never throws: a failed agent run, a missing file and an
 * unreadable one are all a failed source, for the caller to log beside the
 * other sources' results. Dropped records are logged here, by count.
 */
export async function runAgentSource(
  ctx: AgentSourceCtx,
  opts: { claimed: readonly string[] },
): Promise<SourceResult> {
  const scratch = ctx.workspace.scratch;
  const claimedPath = join(scratch, CLAIMED_FILE);
  const candidatesPath = join(scratch, CANDIDATES_FILE);
  const claimed = [...new Set(opts.claimed)].sort(byText);
  writeFileSync(claimedPath, `${JSON.stringify(claimed, null, 2)}\n`);

  try {
    await ctx.agent.run({
      promptArgs: {
        SCRATCH_DIR: scratch,
        CLAIMED_JSON: claimedPath,
        CANDIDATES_JSON: candidatesPath,
      },
    });
  } catch (error) {
    return {
      ok: false,
      problem: `the agent run failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!existsSync(candidatesPath)) {
    return { ok: false, problem: `the agent left no ${CANDIDATES_FILE} in ${scratch}` };
  }
  const parsed = parseAgentCandidates(readFileSync(candidatesPath, "utf8"), claimed);
  if (!parsed.ok) return { ok: false, problem: `${CANDIDATES_FILE} is ${parsed.problem}` };
  if (parsed.dropped.length > 0) {
    const shown = parsed.dropped.slice(0, REASONS_LOGGED).join("; ");
    const more = parsed.dropped.length - REASONS_LOGGED;
    ctx.log(
      `agent source: kept ${parsed.candidates.length} record(s), dropped ${parsed.dropped.length} ` +
        `(${shown}${more > 0 ? `; ${more} more` : ""}).`,
    );
  }
  return { ok: true, candidates: parsed.candidates };
}
