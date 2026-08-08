// The `--config`/`--help` argv surface shared by engine mode (./engine.ts) and
// `phoebe status` (./status.ts). Split out of engine.ts (#74) so status.ts
// doesn't have to import engine.ts — engine.ts imports the command table
// (./table.ts) to build root usage, and the table includes statusCommand, so
// status.ts -> engine.ts would close that back into a cycle.

import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";

export type ParsedCliArgs = { configPath: string | undefined; help: boolean; forward: string[] };

const CLI_SPEC: ArgSpec = {
  booleanFlags: ["help"],
  valueFlags: ["config"],
  aliases: { h: "help", c: "config" },
  onUnknownFlag: "forward",
  missingValue: (arg) => `${arg} requires a path argument (e.g. --config phoebe.config.ts).`,
};

/**
 * Extract `--config <path>` / `--config=<path>` / `-c <path>` and `--help`/`-h`
 * from argv, forwarding everything else on. A minimal parser is enough — the
 * engine handles its own boolean flags (`--run-once`, `--dry-run`) from the
 * forwarded array. Shared by `phoebe status`, which does its own filtering of
 * the rest.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const parsed = parseArgs(argv, CLI_SPEC);
  const configPath = parsed.flags["config"];
  return {
    configPath: typeof configPath === "string" ? configPath : undefined,
    help: parsed.flags["help"] === true,
    forward: parsed.positionals,
  };
}
