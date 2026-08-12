import { describe, expect, test } from "vite-plus/test";
import { PROVIDERS } from "./providers.ts";

describe("cursor provider", () => {
  test("builds a print-mode argv with the prompt as the final argument", () => {
    const cmd = PROVIDERS.cursor.buildCommand({ prompt: "do the thing", model: "composer-x" });
    expect(cmd.argv[0]).toBe("agent");
    expect(cmd.argv).toContain("--print");
    expect(cmd.argv).toContain("--force");
    expect(cmd.argv.slice(-1)[0]).toBe("do the thing");
    const modelIdx = cmd.argv.indexOf("--model");
    expect(cmd.argv[modelIdx + 1]).toBe("composer-x");
    expect(cmd.stdin).toBeUndefined();
  });

  test("ignores an effort value — the cursor CLI has no effort concept", () => {
    const cmd = PROVIDERS.cursor.buildCommand({
      prompt: "do the thing",
      model: "composer-x",
      effort: "high",
    });
    expect(cmd.argv).not.toContain("--effort");
  });

  test("rejects prompts too large for a single argv argument", () => {
    const huge = "x".repeat(121 * 1024);
    expect(() => PROVIDERS.cursor.buildCommand({ prompt: huge, model: "m" })).toThrow(/bytes/);
  });

  test("parses cursor top-level tool_call events", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { readToolCall: { args: { path: "src/a.ts" } } },
    });
    expect(PROVIDERS.cursor.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Read", args: "src/a.ts" },
    ]);
  });

  test("parses shell tool_call function arguments", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { function: { name: "shell", arguments: JSON.stringify({ command: "vp test" }) } },
    });
    expect(PROVIDERS.cursor.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "vp test" },
    ]);
  });
});

describe("claude provider", () => {
  test("delivers the prompt on stdin, not argv", () => {
    const cmd = PROVIDERS.claude.buildCommand({ prompt: "big prompt", model: "claude-m" });
    expect(cmd.argv[0]).toBe("claude");
    expect(cmd.argv).toContain("--dangerously-skip-permissions");
    expect(cmd.argv.slice(-2)).toEqual(["-p", "-"]);
    expect(cmd.argv).not.toContain("big prompt");
    expect(cmd.stdin).toBe("big prompt");
    const modelIdx = cmd.argv.indexOf("--model");
    expect(cmd.argv[modelIdx + 1]).toBe("claude-m");
  });

  test("appends --effort immediately after --model when an effort value is present", () => {
    const cmd = PROVIDERS.claude.buildCommand({
      prompt: "big prompt",
      model: "claude-m",
      effort: "high",
    });
    const modelIdx = cmd.argv.indexOf("--model");
    expect(cmd.argv[modelIdx + 1]).toBe("claude-m");
    expect(cmd.argv[modelIdx + 2]).toBe("--effort");
    expect(cmd.argv[modelIdx + 3]).toBe("high");
  });

  test("omits --effort when no effort value is given", () => {
    const cmd = PROVIDERS.claude.buildCommand({ prompt: "big prompt", model: "claude-m" });
    expect(cmd.argv).not.toContain("--effort");
  });

  test("parses assistant text and allowlisted tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "working…" },
          { type: "tool_use", name: "Bash", input: { command: "vp check" } },
          { type: "tool_use", name: "SecretTool", input: { x: "ignored" } },
        ],
      },
    });
    expect(PROVIDERS.claude.parseStreamLine(line)).toEqual([
      { type: "text", text: "working…" },
      { type: "tool_call", name: "Bash", args: "vp check" },
    ]);
  });

  test("parses the terminal result event", () => {
    const line = JSON.stringify({ type: "result", result: "done" });
    expect(PROVIDERS.claude.parseStreamLine(line)).toEqual([{ type: "result", result: "done" }]);
  });

  test("captures usage and total_cost_usd off the terminal result event", () => {
    const line = JSON.stringify({
      type: "result",
      result: "done",
      total_cost_usd: 0.0150938,
      usage: {
        input_tokens: 9,
        output_tokens: 56,
        cache_creation_input_tokens: 6515,
        cache_read_input_tokens: 17748,
        service_tier: "standard",
      },
    });
    expect(PROVIDERS.claude.parseStreamLine(line)).toEqual([
      { type: "result", result: "done" },
      {
        type: "usage",
        usage: {
          inputTokens: 9,
          outputTokens: 56,
          cacheCreationTokens: 6515,
          cacheReadTokens: 17748,
        },
        costUsd: 0.0150938,
      },
    ]);
  });

  test("omits the usage event when the result carries neither usage nor cost", () => {
    const line = JSON.stringify({ type: "result", result: "done", is_error: false });
    expect(PROVIDERS.claude.parseStreamLine(line)).toEqual([{ type: "result", result: "done" }]);
  });

  test("ignores non-JSON lines", () => {
    expect(PROVIDERS.claude.parseStreamLine("plain text")).toEqual([]);
    expect(PROVIDERS.claude.parseStreamLine("{not json")).toEqual([]);
  });
});

describe("codex provider", () => {
  test("delivers the prompt on stdin with bypass flags", () => {
    const cmd = PROVIDERS.codex.buildCommand({ prompt: "fix it", model: "gpt-m" });
    expect(cmd.argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(cmd.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd.stdin).toBe("fix it");
    const modelIdx = cmd.argv.indexOf("-m");
    expect(cmd.argv[modelIdx + 1]).toBe("gpt-m");
  });

  test("ignores an effort value — the codex CLI has no effort concept", () => {
    const cmd = PROVIDERS.codex.buildCommand({ prompt: "fix it", model: "gpt-m", effort: "high" });
    expect(cmd.argv).not.toContain("--effort");
  });

  test("maps agent_message completion to text + result", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "all done" },
    });
    expect(PROVIDERS.codex.parseStreamLine(line)).toEqual([
      { type: "text", text: "all done" },
      { type: "result", result: "all done" },
    ]);
  });

  test("maps command_execution start to a Bash tool call", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "vp test" },
    });
    expect(PROVIDERS.codex.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "vp test" },
    ]);
  });

  test("surfaces stdout error events as result events", () => {
    const line = JSON.stringify({ type: "error", error: { message: "rate limited" } });
    expect(PROVIDERS.codex.parseStreamLine(line)).toEqual([
      { type: "result", result: "rate limited" },
    ]);
  });

  test("captures usage off turn.completed — no cost, codex has none on its stream", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 13178,
        cached_input_tokens: 9984,
        cache_write_input_tokens: 0,
        output_tokens: 6,
        reasoning_output_tokens: 0,
      },
    });
    expect(PROVIDERS.codex.parseStreamLine(line)).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 13178,
          outputTokens: 6,
          cacheReadTokens: 9984,
          cacheCreationTokens: 0,
        },
      },
    ]);
  });

  test("ignores a turn.completed with no usage object", () => {
    const line = JSON.stringify({ type: "turn.completed" });
    expect(PROVIDERS.codex.parseStreamLine(line)).toEqual([]);
  });
});
