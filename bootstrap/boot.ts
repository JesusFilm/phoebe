// `phoebe boot` — the container's long-lived main process.
//
// The bootstrapper's job at boot is small: read the mounted consumer config,
// resolve where the engine source lives, and exec that engine as a long-running
// child (its normal persistent poll loop). Stop signals are forwarded to the
// child so a container `SIGTERM` reaches the engine and triggers its graceful
// drain (src/drain.ts); the child's exit is propagated so the container exits
// with the engine's status.
//
// Two engine sources are wired: `local` — a host→container mount at
// `/opt/phoebe-engine` (dogfood `compose.local.yml`, #40) — and `github` — a git
// checkout of the engine repo at a ref (github-engine.ts, #41). The later
// respawn-on-change loop (watch config + `ls-remote`, SIGTERM, respawn) also
// builds on this exec.

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserConfig, resolveConfigPath } from "../src/load-config.ts";
import { readEngineSource } from "./engine-source.ts";
import { materializeGithubEngine } from "./github-engine.ts";
// Untyped plain-JS import (see spawn-engine.mjs / materialize.mjs for why the
// bootstrapper's child-process plumbing can't be TypeScript).
import { spawnEngine } from "./spawn-engine.mjs";

/** Where the dogfood compose overlay mounts the engine source for `source: "local"`. */
export const LOCAL_ENGINE_DIR = "/opt/phoebe-engine";

/**
 * Resolve a `local` engine source to the mounted engine's `src/cli.ts`, failing
 * loudly if it is absent — a missing/empty mount means a misconfigured
 * container, not a fallback. Checking the entry file (not just the directory)
 * catches a mounted-but-empty volume too. `github` is handled separately
 * (materializeGithubEngine), so this only ever sees `local`.
 *
 * `exists`/`localEngineDir` are injectable so the decision is unit-tested
 * without a real filesystem.
 */
export function resolveEngineEntry(
  _source: { source: "local" },
  deps: { localEngineDir?: string; exists?: (path: string) => boolean } = {},
): string {
  const exists = deps.exists ?? existsSync;
  const dir = deps.localEngineDir ?? LOCAL_ENGINE_DIR;
  const entry = join(dir, "src", "cli.ts");
  if (!exists(entry)) {
    throw new Error(
      `engine.source is "local" but no engine is mounted at ${dir} (missing ${entry}). ` +
        `Mount the engine there (dogfood: container/compose.local.yml) before \`phoebe boot\`.`,
    );
  }
  return entry;
}

/**
 * Base directory the github source clones the engine into. Reuses
 * `PHOEBE_ENGINE_DIR` (the same knob bin.mjs materializes under); point it at a
 * persistent volume so github clones survive restarts and later boots fetch
 * instead of re-cloning. Defaults to a per-user temp dir for local dev.
 */
function engineBaseDir(): string {
  return process.env["PHOEBE_ENGINE_DIR"] ?? join(tmpdir(), "phoebe-agent");
}

/**
 * `phoebe boot` entry. Loads the mounted config (default `phoebe.config.ts` in
 * the working directory), resolves the engine source to a runnable `src/cli.ts`
 * — a local mount or a github checkout — and execs the engine as a long-lived
 * child. Signals are forwarded and the exit propagated (spawn-engine.mjs) so a
 * container SIGTERM reaches the engine and triggers its drain. Extra args after
 * `boot` are forwarded to the engine (none ⇒ the persistent poll loop).
 */
export async function runBoot(argv: readonly string[]): Promise<void> {
  const configPath = resolveConfigPath(undefined, process.cwd());
  const userConfig = await loadUserConfig(configPath);
  const source = readEngineSource(userConfig as unknown as Record<string, unknown>);
  const entry =
    source.source === "local"
      ? resolveEngineEntry(source)
      : materializeGithubEngine(source, {
          baseDir: engineBaseDir(),
          token: process.env["GH_TOKEN"],
        });
  console.log(`[phoebe] boot: engine source "${source.source}" — exec ${entry} (long-running).`);
  spawnEngine(entry, argv);
}
