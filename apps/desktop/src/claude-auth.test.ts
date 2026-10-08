import { describe, expect, test } from "vite-plus/test";
import { claudeLoginCommand, looksLikeClaudeToken, readClaudeAuth } from "./claude-auth.ts";

const LOG = [
  "[phoebe] boot: ok",
  "[phoebe:acme/a:work][issues issue:716] Preparing worktree",
  "[acme/a:claude][issues issue:716] Not logged in · Please run /login",
  "[phoebe:acme/a:work] Agent exited with code 1.",
  "[acme/b:claude][issues issue:9] Reading the ticket",
];

describe("what the log says about Claude Code's sign-in", () => {
  test("the last refusal on a tenant is read, and a tenant that ran is not", () => {
    expect(readClaudeAuth(LOG)).toEqual([
      { slug: "acme/a", state: "not-logged-in", text: "Not logged in · Please run /login" },
    ]);
  });

  test("a refusal that Claude got past is not a refusal", () => {
    expect(
      readClaudeAuth([...LOG, "[acme/a:claude][issues issue:717] Reading the ticket"]),
    ).toEqual([]);
  });

  test("each way of not running is told apart", () => {
    const states = (said: string) =>
      readClaudeAuth([`[acme/a:claude:stderr] ${said}`]).map((facts) => facts.state);

    expect(states("OAuth token has expired. Please run /login")).toEqual(["token-expired"]);
    expect(states("Your subscription has expired")).toEqual(["subscription-lapsed"]);
    expect(states("Invalid API key · Please run /login")).toEqual(["invalid-key"]);
    expect(states("Authentication required · Sign in again to continue")).toEqual([
      "not-logged-in",
    ]);
  });

  test("the engine's own lines and a timestamp in front are not Claude's", () => {
    expect(readClaudeAuth(["[phoebe:acme/a:work] Not logged in is what claude said"])).toEqual([]);
    expect(
      readClaudeAuth(["2026-10-06T20:19:02.343Z [acme/a:claude] Not logged in · Run /login"]),
    ).toEqual([{ slug: "acme/a", state: "not-logged-in", text: "Not logged in · Run /login" }]);
  });
});

describe("opening the sign-in", () => {
  test("is a terminal with claude setup-token in it, where one is known", () => {
    expect(claudeLoginCommand("win32")?.args.join(" ")).toContain("claude setup-token");
    expect(claudeLoginCommand("darwin")?.file).toBe("osascript");
    expect(claudeLoginCommand("linux")?.args).toContain("claude setup-token; exec sh");
    expect(claudeLoginCommand("freebsd")).toBeNull();
  });

  test("a pasted token is the shape setup-token prints", () => {
    expect(looksLikeClaudeToken("sk-ant-oat01-" + "a".repeat(40))).toBe(true);
    expect(looksLikeClaudeToken(" sk-ant-oat01-" + "b".repeat(24) + " ")).toBe(true);
    expect(looksLikeClaudeToken("sk-ant-api03-" + "a".repeat(40))).toBe(false);
    expect(looksLikeClaudeToken("hello")).toBe(false);
  });
});
