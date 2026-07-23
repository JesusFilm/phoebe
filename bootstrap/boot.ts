// `phoebe boot` — the container's long-lived main process.
//
// The bootstrapper's job at boot is small: read the mounted consumer config,
// resolve where the engine source lives, and exec that engine as a long-running
// child (its normal persistent poll loop). Stop signals are forwarded to the
// child so a container `SIGTERM` reaches the engine and triggers its graceful
// drain (src/drain.ts); the child's exit is propagated so the container exits
// with the engine's status.
//
// For #40 the only wired source is `local` — a host→container mount at
// `/opt/phoebe-engine`, supplied by the dogfood `compose.local.yml`. Resolving a
// `github` source (clone the engine at a ref) lands in #41; until then boot
// fails loudly if the config selects it. The later respawn-on-change loop
// (watch config + `ls-remote`, SIGTERM, respawn) also builds on this exec.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadUserConfig, resolveConfigPath } from "../src/load-config.ts";
import { readEngineSource, type ResolvedEngineSource } from "./engine-source.ts";
// Untyped plain-JS import (see spawn-engine.mjs / materialize.mjs for why the
// bootstrapper's child-process plumbing can't be TypeScript).
import { spawnEngine } from "./spawn-engine.mjs";

/** Where the dogfood compose overlay mounts the engine source for `source: "local"`. */
export const LOCAL_ENGINE_DIR = "/opt/phoebe-engine";

/**
 * Turn a resolved engine source into the engine-CLI path boot execs. `local`
 * points at the mounted engine's `src/cli.ts` (failing loudly if it is absent,
 * since a missing/empty mount means a misconfigured container, not a fallback —
 * checking the entry file, not just the directory, catches a mounted-but-empty
 * volume too). `github` is not resolved yet — boot only materializes a local
 * mount until #41 — so it throws rather than silently doing nothing.
 *
 * `exists`/`localEngineDir` are injectable so the decision is unit-tested
 * without a real filesystem.
 */
export function resolveEngineEntry(
  source: ResolvedEngineSource,
  deps: { localEngineDir?: string; exists?: (path: string) => boolean } = {},
): string {
  const exists = deps.exists ?? existsSync;
  if (source.source === "local") {
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
  throw new Error(
    `engine.source "github" (repo ${source.repo}, ref ${source.ref}) is not supported by ` +
      `\`phoebe boot\` yet — it currently materializes only a local mount. ` +
      `Set engine: { source: "local" } (github materialization lands in #41).`,
  );
}

/**
 * `phoebe boot` entry. Loads the mounted config (default `phoebe.config.ts` in
 * the working directory), resolves the engine source, and execs the engine as a
 * long-lived child — signals forwarded, exit propagated (spawn-engine.mjs), so a
 * container SIGTERM reaches the engine and triggers its drain. Extra args after
 * `boot` are forwarded to the engine (none ⇒ the persistent poll loop).
 */
export async function runBoot(argv: readonly string[]): Promise<void> {
  const configPath = resolveConfigPath(undefined, process.cwd());
  const userConfig = await loadUserConfig(configPath);
  const source = readEngineSource(userConfig as unknown as Record<string, unknown>);
  const entry = resolveEngineEntry(source);
  console.log(`[phoebe] boot: engine source "${source.source}" — exec ${entry} (long-running).`);
  spawnEngine(entry, argv);
}
