// Whether the container's Claude Code can run at all: is it signed in?
//
// The claude provider runs under a subscription token (`providerEnv.claude`
// naming `CLAUDE_CODE_OAUTH_TOKEN`, docs/claude-subscription-auth.md) or an API
// key. When the token is missing, has expired, or the subscription behind it
// has lapsed, the CLI says so on its stderr and exits, every unit fails, and
// the one place that says why is a line in the container's log:
//
//   [acme/repo:claude][issues issue:716] Not logged in · Please run /login
//
// So the log is what this reads. The tail is enough: what matters is whether
// the most recent thing Claude Code said on an install is a refusal to run,
// and whether anything it said after that went better.
//
// Signing in is `claude setup-token`, run by a person in a terminal: it opens
// the browser, waits for the sign-in, and prints a long-lived token. That is
// Anthropic's flow and this does not reimplement it. The companion opens the
// terminal with the command in it, and takes the token back as a secret.

import type { ClaudeAuthFacts, ClaudeAuthState } from "phoebe-agent/contracts";

/** The tag the engine puts on an agent's own output: `[owner/repo:claude]` or `[owner/repo:claude:stderr]`. */
const CLAUDE_TAG = /^\[([^\]:]+\/[^\]:]+):claude(?::stderr)?\]/;

/** What the CLI says for each way of not being able to run, most specific first. */
const REFUSALS: { state: ClaudeAuthState; pattern: RegExp }[] = [
  {
    state: "subscription-lapsed",
    pattern: /subscription.*(expired|lapsed|inactive|ended)|no active subscription/i,
  },
  {
    state: "token-expired",
    pattern: /token (has )?expired|expired.*token|OAuth token.*(invalid|expired)/i,
  },
  {
    state: "invalid-key",
    pattern: /invalid api key|authentication_error|invalid authentication|401 unauthorized/i,
  },
  {
    state: "not-logged-in",
    pattern: /not logged in|please run \/login|run \/login|authentication required|sign in again/i,
  },
];

/**
 * What the log tail says about Claude Code on each tenant that ran it: the
 * last refusal, unless a later line of Claude's own output shows it running.
 */
export function readClaudeAuth(lines: readonly string[]): ClaudeAuthFacts[] {
  const byTenant = new Map<string, { state: ClaudeAuthState; text: string; recovered: boolean }>();
  for (const raw of lines) {
    const line = raw.replace(/^\S+Z\s/, "");
    const tag = CLAUDE_TAG.exec(line);
    if (tag === null) continue;
    const slug = tag[1]!;
    const said = line
      .slice(tag[0].length)
      .replace(/^\[[^\]]*\]\s*/, "")
      .trim();
    const refusal = REFUSALS.find(({ pattern }) => pattern.test(said));
    if (refusal !== undefined) {
      byTenant.set(slug, { state: refusal.state, text: said, recovered: false });
    } else {
      const held = byTenant.get(slug);
      // Something Claude said after the refusal that is not one: it is running.
      if (held !== undefined && said !== "") held.recovered = true;
    }
  }
  return [...byTenant]
    .filter(([, held]) => !held.recovered)
    .map(([slug, held]) => ({ slug, state: held.state, text: held.text }));
}

/**
 * The command that opens a terminal with `claude setup-token` running in it,
 * on this machine. The flow is the CLI's own: a browser sign-in and a token
 * printed at the end, which the operator pastes back. Null where no terminal
 * is known to open.
 */
export function claudeLoginCommand(
  platform: string,
): { file: string; args: readonly string[] } | null {
  switch (platform) {
    case "win32":
      // A new console window that stays open, so the token can be read off it.
      return {
        file: "cmd.exe",
        args: ["/c", "start", '"Sign in to Claude"', "cmd.exe", "/k", "claude setup-token"],
      };
    case "darwin":
      return {
        file: "osascript",
        args: [
          "-e",
          'tell application "Terminal" to do script "claude setup-token"',
          "-e",
          'tell application "Terminal" to activate',
        ],
      };
    case "linux":
      return {
        file: "x-terminal-emulator",
        args: ["-e", "sh", "-c", "claude setup-token; exec sh"],
      };
    default:
      return null;
  }
}

/** Whether a pasted value looks like the token `claude setup-token` prints. */
export function looksLikeClaudeToken(value: string): boolean {
  return /^sk-ant-oat\d\d-[A-Za-z0-9_-]{20,}$/.test(value.trim());
}
