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
// checkout of the engine repo at a ref (github-engine.ts, #41).
//
// Boot then stays in charge for the life of the container: the reconcile watch
// (reconcile.ts, #42) polls the mounted config and the tracked ref, and when
// either moves it drains the engine, re-resolves the source, and relaunches —
// same container, no interrupted work unit. This module is the wiring; the loop
// and its decisions live in reconcile.ts, and everything impure is passed in
// from here.

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDrainSignal } from "../src/drain.ts";
import { loadUserConfig, resolveConfigPath } from "../src/load-config.ts";
import { readEngineSource, type ResolvedEngineSource } from "./engine-source.ts";
import { lsRemoteBranchSha, materializeGithubEngine } from "./github-engine.ts";
import {
  configFingerprint,
  superviseEngine,
  DEFAULT_RECONCILE_INTERVAL_MS,
  type EngineExit,
  type LaunchedEngine,
  type SupervisedChild,
} from "./reconcile.ts";
// Untyped plain-JS import (see spawn-engine.mjs / materialize.mjs for why the
// bootstrapper's child-process plumbing can't be TypeScript).
import { propagateExit, spawnEngine } from "./spawn-engine.mjs";

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
 * How often the reconcile watch samples the config and the tracked ref.
 * `PHOEBE_RECONCILE_INTERVAL_MS` tightens it for dogfooding (the default is a
 * minute, which is a long time to wait when demonstrating a relaunch).
 */
function reconcileIntervalMs(): number {
  const raw = Number(process.env["PHOEBE_RECONCILE_INTERVAL_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECONCILE_INTERVAL_MS;
}

/**
 * Read the config and turn the engine source it names into something runnable —
 * the whole of a (re)launch. Called once at boot and again for every reconcile,
 * so an edited config is genuinely re-read (hence the fingerprint as the ESM
 * cache-bust key) and a moved ref is genuinely re-fetched.
 */
async function launchTarget(configPath: string): Promise<LaunchedEngine> {
  const fingerprint = configFingerprint(configPath);
  const userConfig = await loadUserConfig(configPath, { reloadKey: fingerprint ?? undefined });
  const source = readEngineSource(userConfig as unknown as Record<string, unknown>);
  const token = process.env["GH_TOKEN"];

  const { entry, sha } =
    source.source === "local"
      ? { entry: resolveEngineEntry(source), sha: null }
      : materializeGithubEngine(source, { baseDir: engineBaseDir(), token });

  console.log(
    `[phoebe] boot: engine source "${source.source}"` +
      (source.source === "github" ? ` ${source.repo}@${source.ref}${sha ? ` (${sha})` : ""}` : "") +
      ` — exec ${entry} (long-running).`,
  );

  return {
    entry,
    sha,
    config: fingerprint,
    sample: () => ({
      config: configFingerprint(configPath),
      remoteSha: watchedRefSha(source, token),
    }),
  };
}

/**
 * The ref half of a poll: where the tracked branch points now, or null when
 * there is nothing to watch (a local mount, or a pinned SHA/tag — which the
 * ref-watch leaves alone by design).
 */
function watchedRefSha(source: ResolvedEngineSource, token: string | undefined): string | null {
  if (source.source === "local") return null;
  return lsRemoteBranchSha(source, { token });
}

/**
 * Spawn the engine and expose it as the supervisor's child handle. Both a normal
 * exit and a spawn failure settle `exited` — the failure as a non-zero exit — so
 * the supervisor always sees the child resolve and decides what to do (a
 * first-launch failure is fatal, a relaunch failure retries). Without the
 * `onSpawnError` override, spawn-engine.mjs's default would `process.exit(1)`
 * here, bypassing boot's drain-latch teardown and leaving `exited` pending.
 */
function spawnSupervised(entry: string, argv: readonly string[]): SupervisedChild {
  let settle!: (exit: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  const child = spawnEngine(entry, argv, {
    onExit: (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal }),
    onSpawnError: (error: Error) => {
      console.error(`[phoebe] boot: engine failed to spawn — ${error.message}`);
      settle({ code: 1, signal: null });
    },
  });
  return { kill: (signal) => child.kill(signal), exited };
}

/**
 * `phoebe boot` entry. Loads the mounted config, resolves the engine source to a
 * runnable `src/cli.ts` — a local mount or a github checkout — execs the engine
 * as a long-lived child, and supervises it: reconcile relaunches on a config or
 * ref change, and a container stop drains it and exits with its status. Extra
 * args after `boot` are forwarded to the engine (none ⇒ the persistent loop).
 */
export async function runBoot(argv: readonly string[]): Promise<void> {
  const configPath = resolveConfigPath(undefined, process.cwd());

  // The container's stop request. A one-way latch, and the poll clock: a
  // SIGTERM mid-poll wakes the watch immediately instead of sleeping out the
  // interval. Holding these listeners also keeps boot alive across the moment
  // between an engine exiting and its replacement spawning, where the child's
  // own forwarders are not installed.
  const stop = installDrainSignal(process, ["SIGTERM", "SIGINT"]);
  let exit: EngineExit;
  try {
    exit = await superviseEngine({
      launch: () => launchTarget(configPath),
      spawn: (entry) => spawnSupervised(entry, argv),
      stop,
      intervalMs: reconcileIntervalMs(),
      onRelaunch: (reason) =>
        console.log(
          reason === "config"
            ? "[phoebe] boot: mounted config changed — draining the engine (SIGTERM) and relaunching."
            : "[phoebe] boot: tracked ref advanced — draining the engine (SIGTERM) and relaunching.",
        ),
      onLaunchError: (error) =>
        console.error(
          `[phoebe] boot: could not launch the engine — ${describe(error)}. Retrying next poll.`,
        ),
      onSampleError: (error) =>
        console.warn(`[phoebe] boot: reconcile poll failed — ${describe(error)}. Ignoring.`),
    });
  } finally {
    // Drop the listeners before propagating: re-raising the engine's killing
    // signal must actually kill this process, and our own latch would swallow it.
    stop.dispose();
  }
  propagateExit(exit.code, exit.signal);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
