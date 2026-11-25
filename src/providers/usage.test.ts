import { describe, expect, test } from "vite-plus/test";
import { TOOL_CALL_NAMES_MAX } from "../contracts/unit-record.ts";
import { PROVIDERS } from "./providers.ts";
import {
  costBasisFor,
  countToolCall,
  meterClaudeUsage,
  meterCodexUsage,
  meterCursorUsage,
} from "./usage.ts";

/** Feed a meter recorded stream lines, as `runAgent` does. */
function metered(lines: readonly unknown[], meter = meterClaudeUsage()) {
  for (const line of lines) meter.observe(typeof line === "string" ? line : JSON.stringify(line));
  return meter.read();
}

const assistant = (
  id: string,
  usage: Record<string, number>,
  content: unknown[] = [],
  model = "claude-sonnet-5-5",
) => ({ type: "assistant", message: { id, model, usage, content, stop_reason: null } });

const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });

describe("the Claude meter", () => {
  test("is handed out by the claude provider", () => {
    const meter = PROVIDERS.claude.meterUsage();
    meter.observe(JSON.stringify({ type: "result", subtype: "success", num_turns: 1 }));
    expect(meter.read()).toMatchObject({ turns: 1, usageComplete: true });
  });

  test("reads the result line's modelUsage across every model, subagents included", () => {
    const usage = metered([
      { type: "system", subtype: "init", model: "claude-opus-5-5" },
      assistant("msg_1", { input_tokens: 3, output_tokens: 1 }, [toolUse("tu_1", "Read")]),
      {
        type: "result",
        subtype: "success",
        num_turns: 5,
        duration_ms: 9000,
        stop_reason: "end_turn",
        total_cost_usd: 0.5,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          "claude-opus-5-5": {
            inputTokens: 10,
            outputTokens: 200,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 300,
            thinkingTokens: 40,
            costUSD: 0.4,
          },
          "claude-haiku-5-5": {
            inputTokens: 5,
            outputTokens: 20,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 30,
            thinkingTokens: 0,
            costUSD: 0.1,
          },
        },
        result: "done",
      },
    ]);

    expect(usage).toEqual({
      inputTokens: 15,
      outputTokens: 220,
      cacheReadTokens: 1100,
      cacheWriteTokens: 330,
      reasoningTokens: 40,
      costUsd: 0.5,
      turns: 5,
      providerDurationMs: 9000,
      stopReason: "end_turn",
      reportedModels: ["claude-opus-5-5", "claude-haiku-5-5"],
      usageComplete: true,
      toolCalls: { Read: 1 },
    });
  });

  test("leaves a field the CLI did not emit null rather than zero", () => {
    const usage = metered([
      {
        type: "result",
        subtype: "success",
        modelUsage: { "claude-sonnet-5-5": { inputTokens: 4, outputTokens: 8 } },
      },
    ]);

    expect(usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 8,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      costUsd: null,
      turns: null,
      providerDurationMs: null,
      stopReason: "success",
      usageComplete: true,
    });
  });

  test("names the error a run ended in, which its stop_reason would hide", () => {
    const usage = metered([
      { type: "result", subtype: "error_max_turns", stop_reason: "tool_use", modelUsage: {} },
    ]);
    expect(usage.stopReason).toBe("error_max_turns");
  });

  test("a run killed before its result keeps the input and cache tokens, once per message", () => {
    const first = {
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    };
    const usage = metered([
      assistant("msg_1", { ...first, output_tokens: 1 }, [{ type: "text", text: "Looking" }]),
      // The same message again, one content block per line, repeating its usage.
      assistant("msg_1", { ...first, output_tokens: 1 }, [toolUse("tu_1", "Bash")]),
      assistant(
        "msg_2",
        { input_tokens: 2, cache_read_input_tokens: 150, cache_creation_input_tokens: 0 },
        [toolUse("tu_2", "Bash")],
        "claude-haiku-5-5",
      ),
      "not json",
    ]);

    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: null,
      cacheReadTokens: 250,
      cacheWriteTokens: 50,
      reasoningTokens: null,
      costUsd: null,
      turns: null,
      providerDurationMs: null,
      stopReason: null,
      reportedModels: ["claude-sonnet-5-5", "claude-haiku-5-5"],
      usageComplete: false,
      toolCalls: { Bash: 2 },
    });
  });

  test("counts every tool, not only the ones the log prints, and each call once", () => {
    const usage = metered([
      assistant("msg_1", {}, [toolUse("tu_1", "Edit"), toolUse("tu_2", "mcp__github__get_pr")]),
      assistant("msg_1", {}, [toolUse("tu_2", "mcp__github__get_pr")]),
      assistant("msg_2", {}, [toolUse("tu_3", "Edit")]),
    ]);
    expect(usage.toolCalls).toEqual({ Edit: 2, mcp__github__get_pr: 1 });
  });
});

// Cursor's stream, as the 2026.11.22 bundle writes it (#915).
const cursorUsage = (id: string, usage: Record<string, number>) => ({
  type: "usage",
  subtype: "model_call",
  model_call_id: id,
  usage,
  session_id: "s",
  timestamp_ms: 1,
});

const cursorTool = (callId: string, subtype: string, toolCall: Record<string, unknown>) => ({
  type: "tool_call",
  subtype,
  call_id: callId,
  tool_call: toolCall,
  session_id: "s",
});

describe("the Cursor meter", () => {
  const meter = () => meterCursorUsage();

  test("is handed out by the cursor provider", () => {
    expect(
      metered([{ type: "result", subtype: "success" }], PROVIDERS.cursor.meterUsage()),
    ).toMatchObject({ usageComplete: true });
  });

  test("reads the result line's usage and duration, with no cost", () => {
    const usage = metered(
      [
        { type: "system", subtype: "init", model: "Claude 5.5 Sonnet" },
        cursorUsage("mc_1", {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 100,
          cacheWriteTokens: 20,
        }),
        cursorTool("call_1", "started", { readToolCall: { args: { path: "a.ts" } } }),
        cursorTool("call_1", "completed", { readToolCall: { args: { path: "a.ts" }, result: {} } }),
        cursorUsage("mc_2", {
          inputTokens: 3,
          outputTokens: 7,
          cacheReadTokens: 110,
          cacheWriteTokens: 0,
        }),
        {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 4200,
          duration_api_ms: 4200,
          result: "done",
          usage: {
            inputTokens: 14,
            outputTokens: 12,
            cacheReadTokens: 210,
            cacheWriteTokens: 20,
            reasoningTokens: 6,
          },
        },
      ],
      meter(),
    );

    expect(usage).toEqual({
      inputTokens: 14,
      outputTokens: 12,
      cacheReadTokens: 210,
      cacheWriteTokens: 20,
      reasoningTokens: 6,
      costUsd: null,
      turns: 2,
      providerDurationMs: 4200,
      stopReason: "success",
      reportedModels: ["Claude 5.5 Sonnet"],
      usageComplete: true,
      toolCalls: { read: 1 },
    });
  });

  test("sums the per-call lines when the result carries no usage", () => {
    const usage = metered(
      [
        cursorUsage("mc_1", {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 100,
          cacheWriteTokens: 20,
        }),
        cursorUsage("mc_2", {
          inputTokens: 3,
          outputTokens: 7,
          cacheReadTokens: 110,
          cacheWriteTokens: 0,
        }),
        { type: "result", subtype: "success", duration_ms: 900, result: "done" },
      ],
      meter(),
    );

    expect(usage).toMatchObject({
      inputTokens: 13,
      outputTokens: 12,
      cacheReadTokens: 210,
      cacheWriteTokens: 20,
      reasoningTokens: null,
      costUsd: null,
      providerDurationMs: 900,
      usageComplete: true,
    });
  });

  test("a run killed before its result keeps its per-call usage, marked incomplete", () => {
    const usage = metered(
      [
        cursorUsage("mc_1", {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 100,
          cacheWriteTokens: 20,
        }),
        // A line repeated for one call counts once.
        cursorUsage("mc_1", {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 100,
          cacheWriteTokens: 20,
        }),
        cursorUsage("mc_2", {
          inputTokens: 3,
          outputTokens: 7,
          cacheReadTokens: 110,
          cacheWriteTokens: 0,
        }),
        cursorTool("call_1", "started", { shellToolCall: { args: { command: "ls" } } }),
      ],
      meter(),
    );

    expect(usage).toEqual({
      inputTokens: 13,
      outputTokens: 12,
      cacheReadTokens: 210,
      cacheWriteTokens: 20,
      reasoningTokens: null,
      costUsd: null,
      turns: 2,
      providerDurationMs: null,
      stopReason: null,
      reportedModels: [],
      usageComplete: false,
      toolCalls: { shell: 1 },
    });
  });

  test("counts every tool call once, a function call under its own name", () => {
    const usage = metered(
      [
        cursorTool("call_1", "started", { function: { name: "mcp_github", arguments: "{}" } }),
        cursorTool("call_1", "completed", { function: { name: "mcp_github", arguments: "{}" } }),
        cursorTool("call_2", "started", { editToolCall: { args: { path: "a.ts" } } }),
        cursorTool("call_3", "started", { editToolCall: { args: { path: "b.ts" } } }),
      ],
      meter(),
    );
    expect(usage.toolCalls).toEqual({ mcp_github: 1, edit: 2 });
  });

  test("folds tool names past the cap under other", () => {
    const lines = Array.from({ length: TOOL_CALL_NAMES_MAX + 2 }, (_, i) =>
      cursorTool(`call_${i}`, "started", { function: { name: `tool${i}` } }),
    );
    const usage = metered(lines, meter());
    expect(Object.keys(usage.toolCalls)).toHaveLength(TOOL_CALL_NAMES_MAX + 1);
    expect(usage.toolCalls["other"]).toBe(2);
  });
});

// Codex's `exec --json` stream (#915).
const codexItem = (event: string, id: string, item: Record<string, unknown>) => ({
  type: event,
  item: { id, ...item },
});

describe("the Codex meter", () => {
  const meter = () => meterCodexUsage();

  test("is handed out by the codex provider", () => {
    expect(
      metered(
        [{ type: "turn.completed", usage: { input_tokens: 1 } }],
        PROVIDERS.codex.meterUsage(),
      ),
    ).toMatchObject({ inputTokens: 1, usageComplete: true });
  });

  test("reads turn.completed, taking the cached tokens out of the input", () => {
    const usage = metered(
      [
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        codexItem("item.started", "item_0", {
          type: "command_execution",
          command: "ls",
          status: "in_progress",
        }),
        codexItem("item.completed", "item_0", {
          type: "command_execution",
          command: "ls",
          status: "completed",
        }),
        codexItem("item.completed", "item_1", { type: "agent_message", text: "done" }),
        {
          type: "turn.completed",
          usage: {
            input_tokens: 24763,
            cached_input_tokens: 24448,
            cache_write_input_tokens: 0,
            output_tokens: 122,
            reasoning_output_tokens: 64,
          },
        },
      ],
      meter(),
    );

    expect(usage).toEqual({
      inputTokens: 315,
      outputTokens: 122,
      cacheReadTokens: 24448,
      cacheWriteTokens: 0,
      reasoningTokens: 64,
      costUsd: null,
      turns: null,
      providerDurationMs: null,
      stopReason: "completed",
      reportedModels: [],
      usageComplete: true,
      toolCalls: { command_execution: 1 },
    });
  });

  test("an older CLI's missing cache-write field stays null", () => {
    const usage = metered(
      [
        {
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
        },
      ],
      meter(),
    );
    expect(usage).toMatchObject({ inputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: null });
  });

  test("a later turn.completed carries the running total, and replaces the earlier one", () => {
    const usage = metered(
      [
        {
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 30, cached_input_tokens: 5, output_tokens: 9 },
        },
      ],
      meter(),
    );
    expect(usage).toMatchObject({ inputTokens: 25, outputTokens: 9 });
  });

  test("a run killed mid-turn has no usage to recover, but keeps its tool calls", () => {
    const usage = metered(
      [
        { type: "turn.started" },
        codexItem("item.started", "item_0", { type: "command_execution", command: "vp test" }),
      ],
      meter(),
    );

    expect(usage).toEqual({
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
      toolCalls: { command_execution: 1 },
    });
  });

  test("a failed turn reports no usage", () => {
    const usage = metered(
      [{ type: "turn.started" }, { type: "turn.failed", error: { message: "rate limited" } }],
      meter(),
    );
    expect(usage).toMatchObject({ inputTokens: null, stopReason: "failed", usageComplete: false });
  });

  test("counts each tool item once, an MCP call under its tool's name", () => {
    const usage = metered(
      [
        codexItem("item.started", "item_0", {
          type: "mcp_tool_call",
          server: "github",
          tool: "get_pr",
        }),
        codexItem("item.completed", "item_0", {
          type: "mcp_tool_call",
          server: "github",
          tool: "get_pr",
        }),
        codexItem("item.completed", "item_1", { type: "file_change", changes: [] }),
        codexItem("item.started", "item_2", { type: "todo_list", items: [] }),
        codexItem("item.updated", "item_2", { type: "todo_list", items: [] }),
        codexItem("item.completed", "item_3", { type: "reasoning", text: "hmm" }),
        codexItem("item.completed", "item_4", { type: "web_search", query: "q" }),
      ],
      meter(),
    );
    expect(usage.toolCalls).toEqual({ get_pr: 1, file_change: 1, todo_list: 1, web_search: 1 });
  });

  test("folds tool names past the cap under other", () => {
    const lines = Array.from({ length: TOOL_CALL_NAMES_MAX + 2 }, (_, i) =>
      codexItem("item.completed", `item_${i}`, {
        type: "mcp_tool_call",
        server: "s",
        tool: `tool${i}`,
      }),
    );
    const usage = metered(lines, meter());
    expect(Object.keys(usage.toolCalls)).toHaveLength(TOOL_CALL_NAMES_MAX + 1);
    expect(usage.toolCalls["other"]).toBe(2);
  });
});

describe("countToolCall", () => {
  test("keeps 32 names and counts the rest under other", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < TOOL_CALL_NAMES_MAX + 3; i++) countToolCall(counts, `tool${i}`);
    countToolCall(counts, "tool0");
    countToolCall(counts, `tool${TOOL_CALL_NAMES_MAX + 1}`);

    expect(Object.keys(counts)).toHaveLength(TOOL_CALL_NAMES_MAX + 1);
    expect(counts["tool0"]).toBe(2);
    expect(counts["other"]).toBe(4);
  });

  test("counts names that collide with Object.prototype members", () => {
    const counts: Record<string, number> = {};
    countToolCall(counts, "constructor");
    countToolCall(counts, "__proto__");
    countToolCall(counts, "__proto__");

    expect(Object.getOwnPropertyDescriptor(counts, "constructor")?.value).toBe(1);
    expect(Object.getOwnPropertyDescriptor(counts, "__proto__")?.value).toBe(2);
    expect(Object.getPrototypeOf(counts)).toBe(Object.prototype);
  });
});

describe("costBasisFor", () => {
  test("an API key is billed spend", () => {
    expect(costBasisFor("claude", { ANTHROPIC_API_KEY: "api-key" })).toBe("api");
  });

  test("a gateway's bearer token is billed spend", () => {
    expect(costBasisFor("claude", { ANTHROPIC_AUTH_TOKEN: "t" })).toBe("api");
  });

  test("a subscription token is an estimate", () => {
    expect(costBasisFor("claude", { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" })).toBe(
      "subscription-estimate",
    );
  });

  test("no key at all is the on-disk subscription login, and an estimate", () => {
    expect(costBasisFor("claude", { PATH: "/usr/bin", ANTHROPIC_API_KEY: "" })).toBe(
      "subscription-estimate",
    );
  });

  test("a provider that reports no cost has no basis", () => {
    expect(costBasisFor("cursor", { CURSOR_API_KEY: "k" })).toBeNull();
    expect(costBasisFor("codex", { OPENAI_API_KEY: "k" })).toBeNull();
  });
});
