// Explicit env allowlist for agent child processes. The agent sees PATH, HOME,
// git identity, the GitHub token, the bot login, and the *active* provider's
// API key — never the other providers' keys, so a prompt-injected agent can't
// exfiltrate the whole keyring. GH_APP_* vars are deliberately absent:
// only the minted GH_TOKEN reaches the child, not the App credentials that
// minted it.
//
// The one hole in the list is per kind: `agentEnv` (#425). A kind that declares
// a key and then names it in `agentEnv` unions that key onto the allowlist for
// its own agent children and nobody else's. It is opt-in per key because this
// is the hop where a credential meets a prompt.

import type { PhoebeConfig, ProviderName } from "./config-schema.ts";

const BASE_ALLOWLIST = [
  "PATH",
  "HOME",
  "GH_TOKEN",
  "PHOEBE_GH_LOGIN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

export function buildAgentEnv(opts: {
  parentEnv: Record<string, string | undefined>;
  provider: ProviderName;
  providerEnv: PhoebeConfig["providerEnv"];
  /**
   * The running kind's `agentEnv` — keys it declared and chose to open to its
   * agent children (#425). Validation has already pinned this to a subset of
   * the kind's `requiredEnv` and refused every reserved name, so nothing here
   * can widen the list beyond a key the tenant put in its own `.env`.
   */
  agentEnv?: readonly string[];
}): Record<string, string> {
  const { parentEnv, provider, providerEnv, agentEnv = [] } = opts;
  const env: Record<string, string> = { CI: "true" };
  for (const key of [...BASE_ALLOWLIST, providerEnv[provider], ...agentEnv]) {
    const value = parentEnv[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }
  return env;
}
