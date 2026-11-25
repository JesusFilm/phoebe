import { describe, expect, test } from "vite-plus/test";
import { TOOL_CALL_NAMES_MAX } from "../contracts/unit-record.ts";
import { PROVIDERS } from "./providers.ts";
import { costBasisFor, countToolCall, meterClaudeUsage } from "./usage.ts";

/** Feed a meter recorded stream lines, as `runAgent` does. */
function metered(lines: readonly unknown[]) {
  const meter = meterClaudeUsage();
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
  test("is handed out by the claude provider, and by no other yet", () => {
    const meter = PROVIDERS.claude.meterUsage?.();
    meter?.observe(JSON.stringify({ type: "result", subtype: "success", num_turns: 1 }));
    expect(meter?.read()).toMatchObject({ turns: 1, usageComplete: true });
    expect("meterUsage" in PROVIDERS.cursor).toBe(false);
    expect("meterUsage" in PROVIDERS.codex).toBe(false);
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
