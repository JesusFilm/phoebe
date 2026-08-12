// `phoebe start` — bring the deployment container up detached, host-side
// (#187). `runStartCli` predates the ctx-based Command shape and still reads
// `process.*` directly (Docker Compose calls, not just stdio) — this wrapper
// only bridges its `process.exitCode` side effect into the return value
// dispatch expects.

import { runStartCli } from "../start.ts";
import type { Command } from "./types.ts";

export const startCommand: Command = {
  name: "start",
  summary:
    "phoebe start [--build]           Bring the deployment container up detached (host-side)",
  help: "phoebe start — bring the deployment container up detached\n\nSee `phoebe start --help`.\n",
  async run(argv) {
    await runStartCli(argv);
    return process.exitCode === undefined ? 0 : Number(process.exitCode);
  },
};
