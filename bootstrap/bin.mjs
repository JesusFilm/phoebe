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

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEngine } from "./materialize.mjs";
import { spawnEngine } from "./spawn-engine.mjs";

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

// Exec the TypeScript bootstrapper, forwarding the stop signals the
// supervisor/daemon uses so a SIGTERM drain reaches the real process (the
// engine), not just this shim, and dying however the child dies. The plumbing
// lives in spawn-engine.mjs, shared with `phoebe boot`.
spawnEngine(entry, process.argv.slice(2), { onSpawnError: (error) => fail(error.message) });
