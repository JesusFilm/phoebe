#!/usr/bin/env node
// The companion from the checkout, in one command: `vp run ui`.
//
// Three things have to happen in order, and each one is a different directory,
// which is why this is a script rather than a line in package.json. The
// console's dev server starts and is waited for, because an Electron window
// that loads http://localhost:5273 before Vite answers is a blank window that
// never recovers. The companion's main and preload are built, because Electron
// runs the bundle under dist/ and not the sources. Then Electron opens against
// the dev server, and when its window closes the dev server goes with it.
//
// ELECTRON_RUN_AS_NODE is dropped from the environment on purpose. Some hosts
// (T3 Code's shell, for one) export it, and under it Electron starts as plain
// Node and fails on `import { app } from "electron"`.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE = path.join(ROOT, "apps", "console");
const DESKTOP = path.join(ROOT, "apps", "desktop");

/** The console dev server's fixed port (apps/console/vite.config.ts). */
const DEV_URL = "http://localhost:5273/";
const WAIT_FOR_DEV_MS = 60_000;

const WINDOWS = process.platform === "win32";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

/** Every child started, so a quit can stop whichever are still running. */
const children = new Set();

/**
 * Run `vp …` in a directory. `shell` so that `vp` resolves to vp.cmd on
 * Windows. Elsewhere the child leads its own process group, so stop() can
 * signal the shell, vp and Vite together. A group of its own is in the
 * terminal's background, where reading the keyboard would suspend it, so no
 * child gets stdin: Vite's key shortcuts are the only thing that used it.
 */
function vp(args, cwd) {
  const child = spawn(`vp ${args}`, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    shell: true,
    detached: !WINDOWS,
  });
  children.add(child);
  return child;
}

/**
 * Stop a child's whole process tree: a shell, vp, and what vp runs.
 * On Windows this resolves once taskkill is done, because exiting while it
 * runs kills only part of the tree and leaves the dev server holding the port.
 */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (!WINDOWS) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The group is already gone.
    }
    return Promise.resolve();
  }
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  return new Promise((resolve) => {
    killer.on("exit", resolve);
    killer.on("error", resolve);
  });
}

/** The child's exit code, once it has one. */
function exited(child) {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}

/** The console's own document, so another app's server on the port does not count. */
const CONSOLE_MARKER = "<title>Phoebe console</title>";

/**
 * Poll until the console answers, or false at the deadline. Each request is
 * cut off at the deadline too, so a server that accepts the connection and
 * then never answers cannot hold the wait past it.
 */
async function waitForDevServer(deadline) {
  while (Date.now() < deadline) {
    try {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const res = await fetch(DEV_URL, { signal });
      if (res.ok && (await res.text()).includes(CONSOLE_MARKER)) return true;
    } catch {
      // Nothing listening yet, or the request ran into the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** Set by the first quit, and what every later step checks before it starts. */
let stopping = null;

/** Stop every child still running, once, resolving when they are down. */
const quit = () => (stopping ??= Promise.all([...children].map(stop)));

/** After a signal: wait for the children, then leave without starting anything. */
async function leaveIfStopping() {
  if (stopping === null) return;
  await stopping;
  process.exit(1);
}

process.on("SIGINT", quit);
process.on("SIGTERM", quit);

const devServer = vp("dev", CONSOLE);
// Listened for from the start, so an exit before the wait begins is not missed.
const devServerExit = exited(devServer);

// The dev server dying ends the wait too: a startup error, or a port another
// app holds (the port is strict).
const ready = await Promise.race([
  waitForDevServer(Date.now() + WAIT_FOR_DEV_MS).then((answered) =>
    answered ? "ready" : "timeout",
  ),
  devServerExit.then(() => "exited"),
]);
await leaveIfStopping();
if (ready !== "ready") {
  console.error(
    ready === "exited"
      ? "ui: the console dev server exited before it answered"
      : `ui: the console dev server did not answer at ${DEV_URL} within a minute`,
  );
  await quit();
  process.exit(1);
}

const built = await exited(vp("run build", DESKTOP));
await leaveIfStopping();
if (built !== 0) {
  console.error("ui: the companion's main and preload did not build");
  await quit();
  process.exit(built);
}

const code = await exited(vp("exec electron . --dev", DESKTOP));
await quit();
process.exit(code);
