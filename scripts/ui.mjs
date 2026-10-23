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

/** Run `vp …` in a directory. `shell` so that `vp` resolves to vp.cmd on Windows. */
function vp(args, cwd) {
  return spawn(`vp ${args}`, { cwd, env, stdio: "inherit", shell: true });
}

/**
 * Stop a whole process tree, which is what a shell-spawned child is on Windows.
 * Resolves once taskkill is done: exiting while it runs kills only part of the
 * tree, and leaves the dev server holding the port.
 */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (!WINDOWS) {
    child.kill("SIGTERM");
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

/** Poll until the console answers, or false at the deadline. */
async function waitForDevServer(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(DEV_URL);
      if (res.ok && (await res.text()).includes(CONSOLE_MARKER)) return true;
    } catch {
      // Nothing listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const devServer = vp("dev", CONSOLE);
// Listened for from the start, so an exit before the wait begins is not missed.
const devServerExit = exited(devServer);
let electron = null;

/** Stop Electron and the dev server, resolving once both are down. */
const quit = () => Promise.all([electron === null ? null : stop(electron), stop(devServer)]);
process.on("SIGINT", quit);
process.on("SIGTERM", quit);

// The dev server dying ends the wait too: a startup error, a port another app
// holds (the port is strict), or Ctrl-C, which stops it through quit().
const ready = await Promise.race([
  waitForDevServer(Date.now() + WAIT_FOR_DEV_MS).then((answered) =>
    answered ? "ready" : "timeout",
  ),
  devServerExit.then(() => "exited"),
]);
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
if (built !== 0) {
  console.error("ui: the companion's main and preload did not build");
  await quit();
  process.exit(built);
}

electron = vp("exec electron . --dev", DESKTOP);
const code = await exited(electron);
await stop(devServer);
process.exit(code);
