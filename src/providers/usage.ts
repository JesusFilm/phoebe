// Reading usage out of a provider CLI's stream (#926, decisions in #917, field
// research in #915). One meter per agent run, fed every raw stdout line, read
// when the unit settles. Nothing raw is kept: a meter holds counters and the
// handful of fields the unit record names, never a payload.

import type { ProviderName } from "../config-schema.ts";
import {
  OTHER_TOOL_CALLS,
  TOOL_CALL_NAMES_MAX,
  type AgentRunUsage,
  type CostBasis,
} from "../contracts/unit-record.ts";
import type { UsageMeter } from "./types.ts";

/** A run nobody metered: every figure unknown, and so not complete. */
export function noUsage(): AgentRunUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
    turns: null,
    providerDurationMs: null,
    stopReason: null,
    reportedModels: [],
    usageComplete: false,
    toolCalls: {},
  };
}

/**
 * Count one tool call by name. The first {@link TOOL_CALL_NAMES_MAX} names
 * seen keep a key each, and every later name counts under `other`, so a run
 * that calls a hundred distinct MCP tools still writes a bounded record.
 */
export function countToolCall(counts: Record<string, number>, name: string): void {
  if (Object.hasOwn(counts, name)) {
    counts[name] = (counts[name] ?? 0) + 1;
    return;
  }
  const named = Object.keys(counts).filter((key) => key !== OTHER_TOOL_CALLS).length;
  const key = named < TOOL_CALL_NAMES_MAX ? name : OTHER_TOOL_CALLS;
  counts[key] = (counts[key] ?? 0) + 1;
}

type Json = Record<string, unknown>;

function parseObject(line: string): Json | null {
  if (!line.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Json)
      : null;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Sum one field across rows, or `null` when no row carries it. */
function sumField(rows: readonly Json[], field: string): number | null {
  let total: number | null = null;
  for (const row of rows) {
    const value = numberOrNull(row[field]);
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

/**
 * What ended a Claude run. A clean run says why its last turn stopped
 * (`end_turn`); a run that ended in error says which error (`error_max_turns`),
 * which its `stop_reason` would hide.
 */
function claudeStopReason(result: Json): string | null {
  const subtype = stringOrNull(result["subtype"]);
  if (subtype !== null && subtype !== "success") return subtype;
  return stringOrNull(result["stop_reason"]) ?? subtype;
}

/**
 * Claude Code's meter. The accounting comes from the terminal `result` line:
 * `modelUsage` and `total_cost_usd`, not `usage`, which counts the main loop
 * alone and leaves subagents out.
 *
 * A run killed before that line keeps what its `assistant` lines said. Several
 * lines share one `message.id` and repeat its usage, so they count once per
 * id. Their output count is a placeholder taken when the message opened, so
 * output, cost and turns stay unknown; input and cache tokens are a lower
 * bound.
 */
export function meterClaudeUsage(): UsageMeter {
  const toolCalls: Record<string, number> = {};
  const toolIds = new Set<string>();
  const messages = new Map<string, Json>();
  const models: string[] = [];
  let result: Json | null = null;

  const noteModel = (model: unknown): void => {
    if (typeof model === "string" && model !== "" && !models.includes(model)) models.push(model);
  };

  return {
    observe(line) {
      const obj = parseObject(line);
      if (obj === null) return;
      if (obj["type"] === "result") {
        result = obj;
        return;
      }
      if (obj["type"] !== "assistant") return;
      const message = asObject(obj["message"]);
      if (message === null) return;
      noteModel(message["model"]);
      const id = stringOrNull(message["id"]);
      const usage = asObject(message["usage"]);
      if (id !== null && usage !== null) messages.set(id, usage);
      const content = message["content"];
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const tool = asObject(block);
        if (tool?.["type"] !== "tool_use") continue;
        const name = stringOrNull(tool["name"]);
        if (name === null) continue;
        const toolId = stringOrNull(tool["id"]);
        if (toolId !== null) {
          if (toolIds.has(toolId)) continue;
          toolIds.add(toolId);
        }
        countToolCall(toolCalls, name);
      }
    },

    read() {
      const tools = { ...toolCalls };
      if (result === null) {
        const rows = [...messages.values()];
        return {
          ...noUsage(),
          inputTokens: sumField(rows, "input_tokens"),
          cacheReadTokens: sumField(rows, "cache_read_input_tokens"),
          cacheWriteTokens: sumField(rows, "cache_creation_input_tokens"),
          reportedModels: [...models],
          toolCalls: tools,
        };
      }
      const modelUsage = asObject(result["modelUsage"]);
      const rows: Json[] = [];
      for (const row of Object.values(modelUsage ?? {})) {
        const usage = asObject(row);
        if (usage !== null) rows.push(usage);
      }
      const reported = modelUsage === null ? [] : Object.keys(modelUsage);
      return {
        inputTokens: sumField(rows, "inputTokens"),
        outputTokens: sumField(rows, "outputTokens"),
        cacheReadTokens: sumField(rows, "cacheReadInputTokens"),
        cacheWriteTokens: sumField(rows, "cacheCreationInputTokens"),
        reasoningTokens: sumField(rows, "thinkingTokens"),
        costUsd: numberOrNull(result["total_cost_usd"]),
        turns: numberOrNull(result["num_turns"]),
        providerDurationMs: numberOrNull(result["duration_ms"]),
        stopReason: claudeStopReason(result),
        reportedModels: reported.length > 0 ? reported : [...models],
        usageComplete: true,
        toolCalls: tools,
      };
    },
  };
}

/**
 * What a provider's cost figure is, read from the credential Phoebe put in its
 * agent's environment (`buildAgentEnv`), never from what the CLI says about
 * itself. Claude reports a list-price figure on every auth mode, so the basis
 * is the only thing that marks a subscription's figure as an estimate.
 *
 * Claude's own precedence decides: a bearer token or an API key is billed per
 * token; a subscription token, or no credential at all (the on-disk login,
 * docs/claude-subscription-auth.md Approach B), is a plan. A provider that
 * reports no cost has no basis.
 */
export function costBasisFor(
  provider: ProviderName,
  agentEnv: Readonly<Record<string, string>>,
): CostBasis | null {
  if (provider !== "claude") return null;
  const set = (key: string): boolean => (agentEnv[key] ?? "") !== "";
  if (set("ANTHROPIC_AUTH_TOKEN") || set("ANTHROPIC_API_KEY")) return "api";
  return "subscription-estimate";
}
