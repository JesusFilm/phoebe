// The named commands (`./table.ts`, #73) plus the unnamed default (engine
// mode). `runCli` (../cli.ts) does nothing but look a command up here and call
// it — table lookup, parse, validate, and run all happen inside each
// command's own `run`.

import { buildHelpText, engineCommand, HELP_TEXT, runEngineMode } from "./engine.ts";
import type { Command } from "./types.ts";

export { COMMAND_TABLE } from "./table.ts";

/** The table's unnamed entry — anything not matching a name above. */
export const DEFAULT_COMMAND: Command = engineCommand;

// `buildHelpText`/`runEngineMode` let a caller extend the table with a
// command `src/` cannot own (the dependency direction is one-way — engine
// code never imports the bootstrapper) while still getting one composed
// `--help` and one dispatch (`runCli`'s `extension` parameter, #75).
export { HELP_TEXT, buildHelpText, runEngineMode };

export type { Command } from "./types.ts";
