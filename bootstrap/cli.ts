#!/usr/bin/env node

// `phoebe` bin — the published bootstrapper entry point consumers invoke via
// `npx phoebe-agent …` (or a pinned `phoebe` script). The npm package is the
// thin bootstrapper; the engine (`src/`) is a separate slice it drives.
//
// For now this delegates the whole command surface to the engine CLI's
// `runCli` (scaffold via `init`, otherwise run the engine), so the published
// behavior is unchanged while the package is restructured around the
// bootstrapper. Later tickets grow a `boot` subcommand here that resolves the
// engine source (bootstrap/engine-source.ts), materializes the engine, and
// execs it as a long-lived, drain-and-respawn daemon.

import { runCli } from "../src/cli.ts";

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[phoebe] ${message}`);
  process.exit(1);
});
