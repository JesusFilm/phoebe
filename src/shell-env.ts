// Env for the consumer toolchain commands the engine shells out to
// (installCommand, and the `!` expansions in prompt templates).
//
// Unlike the agent's env (see agent-env.ts) this is NOT an allowlist: a
// toolchain command is the consumer's own, runs before any agent is involved,
// and legitimately needs whatever the operator put in the image — registry
// tokens, proxy settings, NODE_OPTIONS. It inherits the parent env whole. The
// only thing added is the answer to a question nobody is here to answer.

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
export function buildShellCommandEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: parentEnv.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? "0",
  };
}
