// The literal-command lifecycle path (#189/#261) — the second arm of `phoebe
// start` / `phoebe stop`, taken when the config carries a `deployment` block.
//
// Where deployment-compose.ts knows the scaffolded Compose layout, this module
// knows nothing about the runtime: it reads the operator's literal strings off
// the config and hands them to `/bin/sh -c`. Exit code 0 is success, anything
// else is a failure — the only contract that holds across podman, systemd, and
// a hand-rolled compose invocation alike.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { TENANT_CONFIG_FILE } from "../bootstrap/tenants.ts";
import { readDeploymentField, type DeploymentField } from "./config-schema.ts";
import {
  defaultCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "./deployment-compose.ts";
import { loadUserConfig } from "./load-config.ts";

/** The shell literal lifecycle commands run under. */
export const LIFECYCLE_SHELL = "/bin/sh";

/**
 * Read the `deployment` block for the deployment rooted at `cwd`, or
 * `undefined` when there is none (the compose driver then runs as before).
 *
 * No config file at all is `undefined`, not an error: the compose path has its
 * own, better-aimed message for a wrong directory (`formatResolveFailure`), and
 * pre-empting it here would replace "no container/compose.yml here" with a
 * vaguer complaint about the config. A config that exists but is broken still
 * throws — a mistyped `deployment` block must not silently fall back to compose.
 */
export async function readDeploymentCommands(cwd: string): Promise<DeploymentField | undefined> {
  const configPath = join(cwd, TENANT_CONFIG_FILE);
  if (!existsSync(configPath)) return undefined;
  return readDeploymentField(await loadUserConfig(configPath));
}

/**
 * Run one literal lifecycle command. stdio is inherited — a drain that takes an
 * hour has the operator's own command output as its only evidence of life — so
 * the result carries an exit code and nothing else.
 */
export async function runLifecycleCommand(opts: {
  command: string;
  cwd: string;
  runner?: CommandRunner;
}): Promise<CommandResult> {
  const runner = opts.runner ?? defaultCommandRunner;
  return await runner({
    file: LIFECYCLE_SHELL,
    args: ["-c", opts.command],
    cwd: opts.cwd,
    inheritStdio: true,
  });
}

/**
 * Failure for a non-zero literal command. Names the config field so the
 * operator knows which string to fix; there is no captured output to quote
 * (stdio was inherited, so they have already seen it).
 */
export function lifecycleFailureError(opts: {
  field: string;
  command: string;
  result: CommandResult;
}): Error {
  return new Error(
    `\`deployment.${opts.field}\` exited ${opts.result.code}: ${opts.command} — ` +
      `see that command's output above.`,
  );
}
