// `phoebe upgrade` — advance the pinned engine ref and/or the npm CLI (#169).
// `runUpgradeCli` predates the ctx-based Command shape and still reads
// `process.*` directly (git/npm calls, not just stdio) — this wrapper only
// bridges its `process.exitCode` side effect into the return value dispatch
// expects, rather than re-plumbing its internals through `ctx`.

import { runUpgradeCli } from "../upgrade.ts";
import type { Command } from "./types.ts";

export const upgradeCommand: Command = {
  name: "upgrade",
  summary:
    "phoebe upgrade [ref] [--engine|--cli|--both]\n" +
    "                                   Advance the pinned engine ref and/or the npm CLI\n" +
    "  phoebe upgrade --check [--json]  Report current vs latest; exit 1 when behind",
  help: "phoebe upgrade — advance the pinned engine ref and/or the npm CLI\n\nSee `phoebe upgrade --help`.\n",
  async run(argv) {
    await runUpgradeCli(argv);
    return process.exitCode === undefined ? 0 : Number(process.exitCode);
  },
};
