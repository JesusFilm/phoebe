// Explicit env allowlist for agent child processes. The agent sees PATH, HOME,
// git identity, the GitHub token, and the *active* provider's API key — never
// the other providers' keys, so a prompt-injected agent can't exfiltrate the
// whole keyring.

import { randomBytes } from "node:crypto";
import type { PhoebeConfig, ProviderName } from "./config/index.ts";

const BASE_ALLOWLIST = [
  "PATH",
  "HOME",
  "GH_TOKEN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  // #170: deny-by-default means an inherited TRACEPARENT is stripped unless
  // listed here. Listing it is what lets `generateTraceparent`'s per-unit
  // value (spliced into `parentEnv` by the caller) reach the child — the
  // agent CLI's own instrumentation (e.g. Claude Code) hangs its spans off
  // whatever trace context it finds in this env var.
  "TRACEPARENT",
] as const;

/**
 * A fresh W3C trace-context header (`version-traceid-spanid-flags`) for one
 * work unit, sampled (`01`). Call once per agent run — see `runAgentInWorktree`
 * in `main.ts` — so each unit's agent spans land in their own trace.
 */
export function generateTraceparent(): string {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}-01`;
}

export function buildAgentEnv(opts: {
  parentEnv: Record<string, string | undefined>;
  provider: ProviderName;
  providerEnv: PhoebeConfig["providerEnv"];
}): Record<string, string> {
  const { parentEnv, provider, providerEnv } = opts;
  const env: Record<string, string> = { CI: "true" };
  for (const key of [...BASE_ALLOWLIST, providerEnv[provider]]) {
    const value = parentEnv[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }
  return env;
}
