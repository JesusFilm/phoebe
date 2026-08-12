// `phoebe stop` — drain and stop the deployment container, host-side (#186).
// `runStopCli` predates the ctx-based Command shape and still reads
// `process.*` directly (Docker Compose calls, not just stdio) — this wrapper
// only bridges its `process.exitCode` side effect into the return value
// dispatch expects.

import { runStopCli } from "../stop.ts";
import type { Command } from "./types.ts";

export const stopCommand: Command = {
  name: "stop",
  summary: "phoebe stop [--now]              Drain and stop the deployment container (host-side)",
  help: "phoebe stop — drain and stop the deployment container\n\nSee `phoebe stop --help`.\n",
  async run(argv) {
    await runStopCli(argv);
    return process.exitCode === undefined ? 0 : Number(process.exitCode);
  },
};
