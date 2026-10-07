// Where the window's renderer comes from.
//
// Two answers, and the flag on the command line picks between them, so the
// companion reads no `.env` and no `NODE_ENV` to decide (#521 §8). `vp run dev`
// in this directory passes `--dev` and the window points at the console's dev
// server; anything else — including a packaged app — loads the built bundle over
// the console scheme.

import { CONSOLE_URL } from "./console-scheme.ts";

/**
 * The console's dev server. Fixed and strict on the other side too
 * (`apps/console/vite.config.ts`, #521 §7): a port that moves when something
 * else holds it is a window that silently loads the wrong thing, and
 * `console-source.test.ts` holds the two numbers together.
 */
export const CONSOLE_DEV_PORT = 5273;

/** The dev server's URL, built from the port above. */
export const CONSOLE_DEV_URL = `http://localhost:${CONSOLE_DEV_PORT}/`;

/** The URL the window loads, given the process's arguments. */
export function consoleSource(argv: readonly string[]): string {
  return argv.includes("--dev") ? CONSOLE_DEV_URL : CONSOLE_URL;
}
