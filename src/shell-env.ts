// Env for the consumer toolchain commands the engine shells out to
// (installCommand, and the `!` expansions in prompt templates).
//
// Unlike the agent's env (see agent-env.ts) this is NOT an allowlist: a
// toolchain command is the consumer's own, runs before any agent is involved,
// and legitimately needs whatever the operator put in the image — registry
// tokens, proxy settings, NODE_OPTIONS. It inherits the parent env whole,
// minus the engine's own credentials. installCommand runs inside a worktree
// checked out at a PR branch head, so the branch's install hooks (postinstall
// scripts, pnpm patches) execute as the engine's child — the credentials the
// engine holds for itself and its agents must not ride along. The prompt `!`
// expansions keep GH_TOKEN because the shipped templates call `gh`, but the
// commands themselves come from the read-only config mount, never the branch;
// no toolchain command needs a provider API key, so those never ride along.
//
// Declared keys (#425) join that list unconditionally, on both spawns. A key a
// kind named in `requiredEnv` is a credential the tenant provisioned for the
// *engine's* use; the consumer's install script and a prompt's `!` expansion
// are neither, and until now every `.env` value reached both — which is the
// pre-existing leak into the target repo's install hooks this closes.

const ENGINE_CREDENTIAL_KEYS = ["GH_TOKEN", "GH_APP_ID", "GH_APP_PRIVATE_KEY"] as const;

/**
 * The parent env plus a default answer for Corepack's download confirmation.
 *
 * The `pnpm`/`yarn` shims `corepack enable` installs begin with
 * `process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ??= '1'`, so the first use of a
 * package manager version Corepack has not cached yet prints
 *
 *     ! Corepack is about to download https://registry.npmjs.org/pnpm/...
 *     ? Do you want to continue? [Y/n]
 *
 * and — when stdin is a TTY and CI is unset — blocks reading that answer.
 *
 * `installCommand` is spawned with inherited stdio, and a deployment launched
 * with `docker compose run` has a TTY by default, so there the prompt reaches a
 * terminal with no operator watching it: the work unit hangs at install rather
 * than failing, and the run-timeout deadline cannot interrupt a blocked
 * `execSync`. The prompt expansions cannot hang — `execSync`'s default stdio
 * hands the child a piped stdin, so the TTY guard is false and Corepack goes
 * ahead — but they would still write that `!` line to the engine's stderr, and
 * one helper across both spawns is one fewer thing to keep in step.
 *
 * Pre-setting the variable wins the shim's `??=`. `0` means "download without
 * asking", not "download anything you like" — the version still comes from the
 * repo's own `packageManager` field, so this suppresses the confirmation, not
 * the pin. An operator who set the variable themselves keeps their value.
 */
function withCorepackAnswer(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: parentEnv.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? "0",
  };
}

function without(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  for (const key of keys) {
    delete env[key];
  }
  return env;
}

/**
 * Env for `installCommand`: the parent env minus GH_TOKEN, the GH_APP_*
 * credentials, every configured provider API key (`providerKeys` — the values
 * of `config.providerEnv`), and every key this pipeline's kinds declared
 * (`declaredKeys`). An install that needs GitHub auth of its own (private git
 * dependencies, GitHub Packages) must bring a dedicated token; the engine's
 * minted credential is not it.
 */
export function buildInstallCommandEnv(
  parentEnv: NodeJS.ProcessEnv,
  providerKeys: readonly string[],
  declaredKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  return without(withCorepackAnswer(parentEnv), [
    ...ENGINE_CREDENTIAL_KEYS,
    ...providerKeys,
    ...declaredKeys,
  ]);
}

/**
 * Env for prompt `!`...`` expansions: keeps GH_TOKEN — the shipped templates
 * open with `gh pr view` / `gh issue view` — but drops the GH_APP_*
 * credentials, every provider API key, and every declared key, none of which an
 * expansion has a use for.
 */
export function buildPromptShellEnv(
  parentEnv: NodeJS.ProcessEnv,
  providerKeys: readonly string[],
  declaredKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  return without(withCorepackAnswer(parentEnv), [
    "GH_APP_ID",
    "GH_APP_PRIVATE_KEY",
    ...providerKeys,
    ...declaredKeys,
  ]);
}
