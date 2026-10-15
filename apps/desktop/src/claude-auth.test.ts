import { describe, expect, test } from "vite-plus/test";
import { claudeLoginCommand, looksLikeClaudeToken, readClaudeAuth } from "./claude-auth.ts";

const LOG = [
  "[phoebe] boot: ok",
  "[phoebe:acme/a:work][issues issue:716] Preparing worktree",
  "[phoebe:acme/a:work][issues issue:716][claude] Not logged in · Please run /login",
  "[phoebe:acme/a:work] Agent exited with code 1.",
  "[phoebe:acme/b:work][issues issue:9][claude] Reading the ticket",
];

describe("what the log says about Claude Code's sign-in", () => {
  test("the last refusal on a tenant is read, and a tenant that ran is not", () => {
    expect(readClaudeAuth(LOG)).toEqual([
      { slug: "acme/a", state: "not-logged-in", text: "Not logged in · Please run /login" },
    ]);
  });

  test("a refusal that Claude got past is not a refusal", () => {
    expect(
      readClaudeAuth([...LOG, "[phoebe:acme/a:work][issues issue:717][claude] Reading the ticket"]),
    ).toEqual([]);
  });

  test("each way of not running is told apart", () => {
    const states = (said: string) =>
      readClaudeAuth([`[phoebe:acme/a:work][issues issue:7][claude:stderr] ${said}`]).map(
        (facts) => facts.state,
      );

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
      readClaudeAuth([
        "2026-10-06T20:19:02.343Z [phoebe:acme/a:work][issues issue:7][claude] Not logged in · Run /login",
      ]),
    ).toEqual([{ slug: "acme/a", state: "not-logged-in", text: "Not logged in · Run /login" }]);
  });

  // The agent took the pipeline's bracket in #686 and before that had its own,
  // with the pipeline segment arriving in #675. A tail can hold lines from any
  // of the three, and all read to the same tenant: one Claude token serves every
  // pipeline on it, so a pipeline that got past the refusal says the token is
  // good for all of them.
  test("the bracket reads in every shape the engine has written, and the tenant is the key", () => {
    expect(readClaudeAuth(["[acme/a:claude] Not logged in · Run /login"])).toEqual([
      { slug: "acme/a", state: "not-logged-in", text: "Not logged in · Run /login" },
    ]);
    expect(
      readClaudeAuth(["[acme/a:work:claude][issues issue:7] Not logged in · Run /login"]),
    ).toEqual([{ slug: "acme/a", state: "not-logged-in", text: "Not logged in · Run /login" }]);
    expect(
      readClaudeAuth([
        "[acme/a:work:claude] Not logged in · Run /login",
        "[phoebe:acme/a:research][issues issue:8][claude] Reading the ticket",
      ]),
    ).toEqual([]);
  });

  test("whatever the deployment is called, the slug is the tenant's", () => {
    expect(
      readClaudeAuth([
        "[ops:east:acme/a:work][issues issue:7][claude] Not logged in · Run /login",
        "[acme/b:acme/b:work][claude] Not logged in · Run /login",
      ]).map((facts) => facts.slug),
    ).toEqual(["acme/a", "acme/b"]);
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
