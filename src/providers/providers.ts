// The three agent CLIs Phoebe can drive. Invocation flags and stream-JSON
// schemas were authored from Sandcastle 0.8.0's AgentProvider.ts (the
// `@ai-hero/sandcastle` package sources) and carry its field-level
// knowledge of each CLI's output format.

import type { AgentCommand, AgentEvent, AgentUsage, Provider } from "./types.ts";
import type { ProviderName } from "../config/index.ts";

/** Maps allowlisted tool names to the input field carrying the display arg. */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

/**
 * Claude Code's terminal `result` event carries `usage` (`input_tokens`,
 * `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`)
 * and `total_cost_usd` alongside the `result` text (#165) — verified against a
 * live `claude --output-format stream-json` run, not just documentation.
 */
function claudeUsage(value: unknown): AgentUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const usage: AgentUsage = {};
  if (typeof raw["input_tokens"] === "number") usage.inputTokens = raw["input_tokens"];
  if (typeof raw["output_tokens"] === "number") usage.outputTokens = raw["output_tokens"];
  if (typeof raw["cache_read_input_tokens"] === "number") {
    usage.cacheReadTokens = raw["cache_read_input_tokens"];
  }
  if (typeof raw["cache_creation_input_tokens"] === "number") {
    usage.cacheCreationTokens = raw["cache_creation_input_tokens"];
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Claude Code and Cursor share the Claude stream-json line schema:
 * `assistant` messages with text/tool_use content blocks, plus a terminal
 * `result` event.
 */
const parseClaudeStreamLine = (line: string): AgentEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const message = obj["message"] as { content?: unknown } | undefined;
    if (obj["type"] === "assistant" && Array.isArray(message?.content)) {
      const events: AgentEvent[] = [];
      const texts: string[] = [];
      for (const block of message.content as Array<{
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue;
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue;
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({ type: "tool_call", name: block.name, args: argValue });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj["type"] === "result" && typeof obj["result"] === "string") {
      const events: AgentEvent[] = [{ type: "result", result: obj["result"] }];
      const usage = claudeUsage(obj["usage"]);
      const costUsd = typeof obj["total_cost_usd"] === "number" ? obj["total_cost_usd"] : undefined;
      if (usage !== undefined || costUsd !== undefined) {
        events.push({
          type: "usage",
          ...(usage !== undefined ? { usage } : {}),
          ...(costUsd !== undefined ? { costUsd } : {}),
        });
      }
      return events;
    }
  } catch {
    // Not valid JSON — skip.
  }
  return [];
};

/** Cursor additionally emits top-level `tool_call` events with per-tool shapes. */
const parseCursorStreamLine = (line: string): AgentEvent[] => {
  if (!line.startsWith("{")) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (obj["type"] !== "tool_call" || obj["subtype"] !== "started") {
    return parseClaudeStreamLine(line);
  }
  const toolCall = obj["tool_call"];
  if (!toolCall || typeof toolCall !== "object") return [];
  const tc = toolCall as Record<string, unknown>;

  const readToolCall = tc["readToolCall"] as { args?: { path?: unknown } } | undefined;
  if (readToolCall?.args && typeof readToolCall.args.path === "string") {
    return [{ type: "tool_call", name: "Read", args: readToolCall.args.path }];
  }
  const writeToolCall = tc["writeToolCall"] as { args?: { path?: unknown } } | undefined;
  if (writeToolCall?.args && typeof writeToolCall.args.path === "string") {
    return [{ type: "tool_call", name: "Write", args: writeToolCall.args.path }];
  }
  const fn = tc["function"] as { name?: unknown; arguments?: unknown } | undefined;
  if (fn && typeof fn.name === "string") {
    const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "";
    if (rawArgs) {
      try {
        const parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
        if (typeof parsedArgs["command"] === "string") {
          return [{ type: "tool_call", name: "Bash", args: parsedArgs["command"] }];
        }
      } catch {
        // Fall through to the raw arguments string.
      }
      return [{ type: "tool_call", name: fn.name, args: rawArgs }];
    }
    return [{ type: "tool_call", name: fn.name, args: "" }];
  }
  return [];
};

const extractErrorMessage = (obj: Record<string, unknown>): string | undefined => {
  const err = obj["error"];
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; data?: { message?: unknown } };
    if (typeof e.message === "string") return e.message;
    if (typeof e.data?.message === "string") return e.data.message;
  }
  if (typeof obj["message"] === "string") return obj["message"];
  return undefined;
};

/**
 * Codex has no dollar cost on its stream (`RolloutBudget` only injects
 * reminders — docs/competitive-landscape.md §4.1) but `turn.completed` carries
 * token usage separately from the `item.completed` text event, verified
 * against a live `codex exec --json` run: `{"type":"turn.completed","usage":
 * {"input_tokens":...,"cached_input_tokens":...,"cache_write_input_tokens":...,
 * "output_tokens":...,"reasoning_output_tokens":...}}`.
 */
function codexUsage(value: unknown): AgentUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const usage: AgentUsage = {};
  if (typeof raw["input_tokens"] === "number") usage.inputTokens = raw["input_tokens"];
  if (typeof raw["output_tokens"] === "number") usage.outputTokens = raw["output_tokens"];
  if (typeof raw["cached_input_tokens"] === "number") {
    usage.cacheReadTokens = raw["cached_input_tokens"];
  }
  if (typeof raw["cache_write_input_tokens"] === "number") {
    usage.cacheCreationTokens = raw["cache_write_input_tokens"];
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Codex `exec --json` emits item/turn events rather than message blocks. */
const parseCodexStreamLine = (line: string): AgentEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const item = obj["item"] as { type?: string; text?: unknown; command?: unknown } | undefined;
    if (
      obj["type"] === "item.completed" &&
      item?.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      return [
        { type: "text", text: item.text },
        { type: "result", result: item.text },
      ];
    }
    if (
      obj["type"] === "item.started" &&
      item?.type === "command_execution" &&
      typeof item.command === "string"
    ) {
      return [{ type: "tool_call", name: "Bash", args: item.command }];
    }
    if (obj["type"] === "turn.completed") {
      const usage = codexUsage(obj["usage"]);
      return usage !== undefined ? [{ type: "usage", usage }] : [];
    }
    // Codex reports auth/rate-limit/API errors on stdout, not stderr.
    if (obj["type"] === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }
  } catch {
    // Not valid JSON — skip.
  }
  return [];
};

/**
 * The Cursor CLI takes the prompt as a positional argv argument (stdin is not
 * documented for prompt delivery). Linux caps a single argument at ~128 KiB;
 * stay under it so users get a clear error instead of spawn E2BIG.
 */
const CURSOR_PROMPT_MAX_BYTES = 120 * 1024;

const cursor: Provider = {
  name: "cursor",
  buildCommand({ prompt, model }): AgentCommand {
    const bytes = Buffer.byteLength(prompt, "utf8");
    if (bytes > CURSOR_PROMPT_MAX_BYTES) {
      throw new Error(
        `Cursor prompt is ${bytes} bytes (max ${CURSOR_PROMPT_MAX_BYTES}). The Cursor CLI only accepts the prompt as an argv argument; shorten the prompt or use another provider.`,
      );
    }
    return {
      argv: [
        "agent",
        "--print",
        "--output-format",
        "stream-json",
        "--model",
        model,
        "--force",
        prompt,
      ],
    };
  },
  parseStreamLine: parseCursorStreamLine,
};

const claude: Provider = {
  name: "claude",
  buildCommand({ prompt, model, effort }): AgentCommand {
    return {
      argv: [
        "claude",
        "--print",
        "--verbose",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--model",
        model,
        ...(effort !== undefined ? ["--effort", effort] : []),
        "-p",
        "-",
      ],
      stdin: prompt,
    };
  },
  parseStreamLine: parseClaudeStreamLine,
};

const codex: Provider = {
  name: "codex",
  buildCommand({ prompt, model }): AgentCommand {
    return {
      argv: ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-m", model],
      stdin: prompt,
    };
  },
  parseStreamLine: parseCodexStreamLine,
};

export const PROVIDERS: Record<ProviderName, Provider> = { cursor, claude, codex };
