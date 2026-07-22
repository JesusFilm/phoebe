#!/usr/bin/env node

// Published `phoebe` / `phoebe-agent` bin — a dumb launcher, nothing more.
//
// It has to be plain JS: npm symlinks this file inside `node_modules`, and Node
// 24 refuses to type-strip `.ts` there. So it does the one thing that lets the
// real, TypeScript bootstrapper run: it copies the package out of node_modules
// (materialize.mjs) and execs the raw-`.ts` entry (bootstrap/cli.ts) with plain
// `node`, from outside node_modules where type-stripping is allowed. Every
// argument is forwarded untouched, so behavior is the bootstrapper's, not this
// shim's.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEngine } from "./materialize.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`[phoebe] ${message}`);
  process.exit(1);
}

let entry;
try {
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  // Override the materialization root with PHOEBE_ENGINE_DIR (e.g. a persistent
  // volume); default to a per-user temp dir, re-materialized cheaply if wiped.
  const baseDir = process.env.PHOEBE_ENGINE_DIR ?? join(tmpdir(), "phoebe-agent");
  entry = ensureEngine({ packageRoot, baseDir, version });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

// Forward the signals the supervisor/daemon uses to stop the engine so a future
// SIGTERM drain reaches the real process, not just this shim.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => fail(error.message));
child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise so the parent's exit reflects the child's terminating signal.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
