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
  assertHostLifecycle,
  defaultCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "./deployment-compose.ts";
import { loadUserConfig } from "./load-config.ts";

/** The shell literal lifecycle commands run under. */
export const LIFECYCLE_SHELL = "/bin/sh";

/** Which config string a lifecycle step is running. */
export type LifecycleField = "startCommand" | "stopCommand" | "stopNowCommand";

/** Present participle for the announce line, so the field is the only argument. */
const LIFECYCLE_VERB: Record<LifecycleField, string> = {
  startCommand: "Starting",
  stopCommand: "Stopping",
  stopNowCommand: "Stopping",
};

/**
 * Resolve the `deployment` block a CLI entry point should hand its run
 * function: refuse in-container first, then read the config unless the caller
 * already supplied the block.
 *
 * The refusal comes before the read on purpose — reading the config means
 * importing, and so *executing*, the consumer's TS module, which a command that
 * is about to refuse must not do. The run functions assert again on their own;
 * they are the guard for direct callers.
 */
export async function resolveDeploymentCommands(opts: {
  command: "start" | "stop";
  cwd: string;
  inContainer?: boolean;
  provided?: DeploymentField;
}): Promise<DeploymentField | undefined> {
  assertHostLifecycle(opts.command, opts.inContainer);
  return opts.provided ?? (await readDeploymentCommands(opts.cwd));
}

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
 * Announce, run, and check one literal lifecycle command. Announcing first is
 * the operator's only way to tell which config string owns whatever the
 * inherited stdio then prints; stdio is inherited because a drain that takes an
 * hour has that output as its sole evidence of life. Returns nothing — a clean
 * exit is the entire success signal, and a non-zero one throws.
 */
export async function runLifecycleStep(opts: {
  field: LifecycleField;
  command: string;
  cwd: string;
  announce: (line: string) => void;
  runner?: CommandRunner;
}): Promise<void> {
  opts.announce(
    `[phoebe] ${LIFECYCLE_VERB[opts.field]} via \`deployment.${opts.field}\`: ${opts.command}`,
  );
  const runner = opts.runner ?? defaultCommandRunner;
  const result = await runner({
    file: LIFECYCLE_SHELL,
    args: ["-c", opts.command],
    cwd: opts.cwd,
    inheritStdio: true,
  });
  if (result.code !== 0) throw lifecycleFailureError(opts.field, opts.command, result);
}

/**
 * Failure for a non-zero literal command. Names the config field so the
 * operator knows which string to fix; there is no captured output to quote
 * (stdio was inherited, so they have already seen it).
 */
function lifecycleFailureError(
  field: LifecycleField,
  command: string,
  result: CommandResult,
): Error {
  return new Error(
    `\`deployment.${field}\` exited ${result.code}: ${command} — ` +
      `see that command's output above.`,
  );
}
