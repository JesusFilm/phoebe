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

/** A whole process tree, which is what a shell-spawned child is on Windows. */
function stop(child) {
  if (child.exitCode !== null) return;
  if (WINDOWS) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function exited(child) {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}

async function waitForDevServer(deadline) {
  while (Date.now() < deadline) {
    try {
      await fetch(DEV_URL);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}

const devServer = vp("dev", CONSOLE);
let electron = null;

const quit = () => {
  if (electron !== null) stop(electron);
  stop(devServer);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);

if (!(await waitForDevServer(Date.now() + WAIT_FOR_DEV_MS))) {
  console.error(`ui: the console dev server did not answer at ${DEV_URL} within a minute`);
  quit();
  process.exit(1);
}

const built = await exited(vp("run build", DESKTOP));
if (built !== 0) {
  console.error("ui: the companion's main and preload did not build");
  quit();
  process.exit(built);
}

electron = vp("exec electron . --dev", DESKTOP);
const code = await exited(electron);
stop(devServer);
process.exit(code);
