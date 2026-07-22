#!/usr/bin/env node

// `phoebe` bootstrapper entry — the real command surface, in TypeScript.
//
// This is NOT the file npm symlinks as the bin: Node 24 refuses to type-strip
// `.ts` under `node_modules`, so a tiny JS launcher (bootstrap/bin.mjs) is the
// bin instead. That launcher copies the package out of `node_modules` and execs
// THIS module with plain `node` — from outside `node_modules`, where raw `.ts`
// runs. So all bootstrapper logic lives here as type-checked TypeScript.
//
// For now this delegates the whole command surface to the engine CLI's `runCli`
// (scaffold via `init`, otherwise run the engine), so behavior is unchanged
// while the package is restructured around the bootstrapper. Later tickets grow
// a `boot` subcommand here that resolves the engine source
// (bootstrap/engine-source.ts), materializes the engine, and execs it as a
// long-lived, drain-and-respawn daemon.

import { runCli } from "../src/cli.ts";

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[phoebe] ${message}`);
  process.exit(1);
});
