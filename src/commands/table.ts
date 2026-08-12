// The one command table (#73): every named `phoebe <command>`, keyed by the
// leading argv token that routes to it. Declaration order is display order —
// `phoebe --help`'s root usage list (../commands/engine.ts, `buildHelpText`,
// #74) renders each entry's `summary` in this order, so adding a command here
// is the one edit that both wires dispatch (`index.ts`) and lists it in help.
//
// Split out of `index.ts` so `engine.ts` (which builds that root usage text)
// can import the table without a cycle: `index.ts` imports `engine.ts` for
// `engineCommand`/`buildHelpText`, so `engine.ts` cannot import `index.ts` back.

import { configResolveCommand } from "./config-resolve.ts";
import { doctorCommand } from "./doctor.ts";
import { initCommand } from "./init.ts";
import { listCommand } from "./list.ts";
import { purgeCommand } from "./purge.ts";
import { serveCommand } from "./serve.ts";
import { setupCommand } from "./setup.ts";
import { startCommand } from "./start.ts";
import { statusCommand } from "./status.ts";
import { stopCommand } from "./stop.ts";
import { upgradeCommand } from "./upgrade.ts";
import type { Command } from "./types.ts";

export const COMMAND_TABLE: Readonly<Record<string, Command>> = {
  setup: setupCommand,
  init: initCommand,
  list: listCommand,
  purge: purgeCommand,
  upgrade: upgradeCommand,
  doctor: doctorCommand,
  stop: stopCommand,
  start: startCommand,
  serve: serveCommand,
  config: configResolveCommand,
  status: statusCommand,
};
