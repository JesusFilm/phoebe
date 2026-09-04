// The two value flags every `phoebe` subcommand parser needs (#460): `--config`
// (with `-c`) and `--pipeline`. Each parser owns its own argv loop — they accept
// different words and word different unknown-argument errors — but the flags
// themselves have to mean one thing across all of them. Held apart, they drifted:
// `--pipeline --dry-run` was a name in `parseCliArgs` and an error in
// `parsePipelineName`, and nothing said which was the contract.
//
// So the loops stay where they are and the flags move here, as matchers a loop
// asks about one argv position. A matcher returns what it consumed rather than
// mutating an index, which is what lets `parseCliArgs` forward the original
// words on to the engine while `parsePipelineName` reads the value out of them.

/** A value flag matched at one argv position: its value, and how many words it ate. */
export type FlagMatch = { value: string; consumed: 1 | 2 };

type ValueFlagSpec = {
  /** The `--long` form, which also fixes the `--long=<value>` spelling. */
  long: string;
  /** The single-letter alias, where the flag has one. */
  short?: string;
  /** What the value is, for the error: "a path argument (e.g. `--config x.ts`)". */
  requirement: string;
};

/**
 * Match `spec` at `argv[index]`, or return undefined when a different word sits
 * there. A value that starts with `-` is refused rather than taken: the next
 * flag is never the value, and swallowing it silently drops the flag the user
 * did type. An empty `--long=` is refused for the same reason.
 */
function matchValueFlag(
  spec: ValueFlagSpec,
  argv: readonly string[],
  index: number,
): FlagMatch | undefined {
  const arg = argv[index];
  if (arg === undefined) return undefined;
  if (arg === spec.long || (spec.short !== undefined && arg === spec.short)) {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new Error(`\`${arg}\` requires ${spec.requirement}.`);
    }
    return { value: next, consumed: 2 };
  }
  const inline = `${spec.long}=`;
  if (arg.startsWith(inline)) {
    const value = arg.slice(inline.length);
    if (value.length === 0) throw new Error(`\`${arg}\` requires ${spec.requirement}.`);
    return { value, consumed: 1 };
  }
  return undefined;
}

const CONFIG_FLAG: ValueFlagSpec = {
  long: "--config",
  short: "-c",
  requirement: "a path argument (e.g. `--config phoebe.config.ts`)",
};

const PIPELINE_FLAG: ValueFlagSpec = {
  long: "--pipeline",
  requirement: "a pipeline name (e.g. `--pipeline work`)",
};

/** `--config <path>` / `-c <path>` / `--config=<path>` at `argv[index]`. */
export function matchConfigFlag(argv: readonly string[], index: number): FlagMatch | undefined {
  return matchValueFlag(CONFIG_FLAG, argv, index);
}

/** `--pipeline <name>` / `--pipeline=<name>` at `argv[index]`. */
export function matchPipelineFlag(argv: readonly string[], index: number): FlagMatch | undefined {
  return matchValueFlag(PIPELINE_FLAG, argv, index);
}
