// The incoming engine's own migrations, run from the companion.
//
// `upgrade` moves the engine pin only after the checkout it is moving to has
// run its `phoebe migrate` against the config (docs/upgrading.md), and the way
// the verb does that by default is boot's way: materialize the checkout with
// synchronous git, then spawnSync `process.execPath` on its cli.ts. Both halves
// of that are wrong in this process. `process.execPath` is the companion itself,
// so the child opens as an Electron app handed a TypeScript file, not as Node
// running it, and main sits inside the synchronous spawn behind it with the
// window frozen until that child dies. And the clone is the whole engine
// repository, which is not a wait a window can take on its own thread.
//
// So the same two steps, the companion's way. Git goes through the run's
// streaming runner: each line lands in the cli tab, and a cancel reaches the
// child. The migrate child is told to run as Node (`ELECTRON_RUN_AS_NODE`);
// Electron's Node is the engine's own major, so the checkout's raw TypeScript
// runs there as it does in the container. The clone takes no history
// (`--filter=blob:none`): a migrate needs one tree, not every one.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner } from "../../../src/deployment-compose.ts";
import {
  buildAuthenticatedRepoUrl,
  githubEngineDir,
  type GithubSource,
} from "../../../bootstrap/github-engine.ts";

/** A command to run, with the environment the child gets when it is not this process's. */
export type EnvCommandSpec = Parameters<CommandRunner>[0] & { env?: NodeJS.ProcessEnv };

/** The desktop's runner: a {@link CommandRunner} that also takes the child's env. */
export type EnvCommandRunner = (spec: EnvCommandSpec) => Promise<CommandResult>;

export type MigrateRunDeps = {
  /** Runs a command on this machine with its lines streamed into the run. */
  run: EnvCommandRunner;
  /** Where engine checkouts live. Defaults to where `upgrade`'s own would. */
  baseDir?: string;
  /** The binary the migrate child runs under. Defaults to this process's. */
  execPath?: string;
  exists?: (file: string) => boolean;
  mkdir?: (dir: string) => Promise<unknown>;
};

/** The knob `phoebe boot` and `upgrade` share, so one clone serves them all. */
export function engineBaseDir(): string {
  return process.env["PHOEBE_ENGINE_DIR"] ?? path.join(tmpdir(), "phoebe-agent");
}

/**
 * Fetch the target checkout and run its `phoebe migrate` against the config.
 * The exit code of the migrate, or null when the checkout has no migrations
 * index and so nothing to run: the shape `runUpgrade`'s seam expects.
 */
export async function runTargetMigrations(
  opts: { source: GithubSource; configPath: string; token: string | undefined },
  deps: MigrateRunDeps,
): Promise<number | null> {
  const exists = deps.exists ?? existsSync;
  const makeDir = deps.mkdir ?? ((dir: string) => mkdir(dir, { recursive: true }));
  const dir = githubEngineDir(deps.baseDir ?? engineBaseDir(), opts.source.repo);
  const authUrl = buildAuthenticatedRepoUrl(opts.source.repo, opts.token);
  const cleanUrl = buildAuthenticatedRepoUrl(opts.source.repo, undefined);

  // The failure names the subcommand and nothing else: the clone and fetch
  // argv carry the token.
  const git = async (verb: string, args: string[], stream: boolean): Promise<string> => {
    const result = await deps.run({ file: "git", args, inheritStdio: stream });
    if (result.code !== 0) {
      throw new Error(
        `Failed to materialize the engine from ${opts.source.repo}@${opts.source.ref}: ` +
          `git ${verb} exited ${String(result.code)}`,
      );
    }
    return result.stdout;
  };

  if (!exists(path.join(dir, ".git"))) {
    await makeDir(dir);
    await git("clone", ["clone", "--filter=blob:none", authUrl, dir], true);
    // Drop the token from the persisted remote, as boot does: the fetch below
    // supplies it each time, so the checkout on disk never holds the secret.
    await git("remote", ["-C", dir, "remote", "set-url", "origin", cleanUrl], false);
  }
  await git("fetch", ["-C", dir, "fetch", "--force", "--tags", authUrl, opts.source.ref], true);
  await git("checkout", ["-C", dir, "checkout", "--force", "--detach", "FETCH_HEAD"], true);

  if (!exists(path.join(dir, "src", "migrations", "index.ts"))) return null;

  const result = await deps.run({
    file: deps.execPath ?? process.execPath,
    args: [path.join(dir, "src", "cli.ts"), "migrate", "--config", opts.configPath],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    inheritStdio: true,
  });
  return result.code;
}
