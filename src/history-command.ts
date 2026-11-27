// `phoebe history` (#930, decided in #918): the unit records a deployment
// holds, newest first, as a table or as the `HistoryPage` `GET /api/history`
// returns.
//
// **Either side of the wall, like `status`.** Inside the container it reads
// the deployment report for the cells, then each cell's history files
// directly, so it answers while the bootstrapper is down. On the host it execs
// itself in the running container with the same flags, stdio passed through.
//
// `--json` prints the page `queryHistory` built, the same object the route
// serializes, so a local console and a remote one read one shape.

import type { DeploymentReport } from "./contracts/deployment.ts";
import type {
  HistoryPage,
  HistoryQuery,
  HistoryRecord,
  HistoryTotals,
} from "./contracts/history.ts";
import {
  HISTORY_EXPORT_FORMATS,
  historyExportHead,
  historyExportLines,
  type HistoryExportFormat,
} from "./contracts/history-export.mjs";
import { runningDeployment, type ContainerExecDeps } from "./container-exec.ts";
import { deploymentReportPath } from "../bootstrap/deployment-report.ts";
import { runCompose } from "./deployment-compose.ts";
import { isInsideContainer } from "./execution-gate.ts";
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  historySourcesOf,
  parseHistoryQuery,
  queryHistory,
  type HistorySource,
  type RawHistoryQuery,
  type ReadText,
} from "./history.ts";
import { resolveDataBase } from "./paths.ts";
import { formatAge } from "./pipeline-listing.ts";
import { PHOEBE_SERVICE, readReportFile } from "./status.ts";

export const HISTORY_HELP_TEXT = `phoebe history — the units this deployment ran, newest first

Usage:
  phoebe history [filters] [--limit <n>] [--before <cursor>] [--json]
  phoebe history [filters] [--before <cursor>] --export csv|jsonl

Filters (all optional, combined with AND):
  --tenant <owner/repo>   One tenant's cells
  --pipeline <name>       One pipeline, in every tenant that has it
  --cell <id>             One cell, by the report's <tenantId>#<pipeline>
  --kind <kind>           issues, reviews, checks, ...
  --outcome <outcome>     completed, unproductive, failed, timed-out or abandoned
  --provider <name>       claude, cursor or codex
  --model <model>         The model the unit was configured to run on
  --since <date>          Units that started at or after a date or ISO timestamp

Paging:
  --limit <n>             Units on one page: ${HISTORY_DEFAULT_LIMIT} by default, at most ${HISTORY_MAX_LIMIT}
  --before <cursor>       The next page: the cursor the last one printed

Cost reads $0.42 for API spend, "$0.42 est." for a subscription estimate, and
— when none was reported. A + after the tokens means a run's usage is partial.

--json prints one HistoryPage object, the same one GET /api/history answers.

--export writes every unit the filters match to stdout, walking every page, in
the format the console's History tab exports too. csv is one row per unit with
its usage summed across agent runs, API cost and estimated cost in columns of
their own. jsonl is one full record per line. The count goes to stderr.

Each pipeline keeps about two thousand units before its oldest rotate out; the
footer says how far back each cell's history reaches. Run it either side of the
container wall: inside, it reads the files; on the host, it execs itself in the
running container.
`;

export type ParsedHistoryArgs = {
  help: boolean;
  json: boolean;
  /** `--export`: write every matching record in this format, not one page. */
  export?: HistoryExportFormat;
  tenant?: string;
  pipeline?: string;
  /** The query fields, raw, as the flags gave them. */
  query: RawHistoryQuery;
};

/** Flags that take a value and land in the query as they are. */
const QUERY_FLAGS = [
  "cell",
  "kind",
  "outcome",
  "provider",
  "model",
  "since",
  "before",
  "limit",
] as const;

function flagValue(argv: readonly string[], i: number, name: string): [string, number] {
  const arg = argv[i]!;
  const inline = arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : undefined;
  const value = inline ?? argv[i + 1];
  if (
    value === undefined ||
    value.length === 0 ||
    (inline === undefined && value.startsWith("-"))
  ) {
    throw new Error(`\`--${name}\` needs a value. See \`phoebe history --help\`.`);
  }
  return [value, inline === undefined ? 1 : 0];
}

function flagNamed(arg: string, names: readonly string[]): string | undefined {
  return names.find((name) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

/** Parse the argv after `history`. The query fields are checked here too, so a typo fails on the host. */
export function parseHistoryArgs(argv: readonly string[]): ParsedHistoryArgs {
  const parsed: ParsedHistoryArgs = { help: false, json: false, query: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    const name = flagNamed(arg, [...QUERY_FLAGS, "tenant", "pipeline", "export"]);
    if (name === undefined) {
      throw new Error(
        `Unknown ${arg.startsWith("-") ? "flag" : "argument"} \`${arg}\` for \`phoebe history\`. ` +
          "See `phoebe history --help`.",
      );
    }
    const [value, skip] = flagValue(argv, i, name);
    i += skip;
    if (name === "export") parsed.export = exportFormatOf(value);
    else if (name === "tenant") parsed.tenant = value;
    else if (name === "pipeline") parsed.pipeline = value;
    else parsed.query[name as (typeof QUERY_FLAGS)[number]] = value;
  }
  if (
    parsed.query.cell !== undefined &&
    (parsed.tenant !== undefined || parsed.pipeline !== undefined)
  ) {
    throw new Error(
      "`--cell` names one cell already; it does not combine with `--tenant` or `--pipeline`.",
    );
  }
  if (parsed.export !== undefined && parsed.json) {
    throw new Error("`--json` prints one page and `--export` writes every page; pick one.");
  }
  if (parsed.export !== undefined && parsed.query.limit !== undefined) {
    throw new Error("`--export` writes every matching unit, so it takes no `--limit`.");
  }
  parseHistoryQuery(parsed.query);
  return parsed;
}

function exportFormatOf(value: string): HistoryExportFormat {
  const format = HISTORY_EXPORT_FORMATS.find((known) => known === value);
  if (format === undefined) {
    throw new Error(
      `\`--export\` is one of ${HISTORY_EXPORT_FORMATS.join(", ")} (got \`${value}\`).`,
    );
  }
  return format;
}

/** The flags the in-container run is handed, rebuilt rather than forwarded raw. */
export function historyExecArgv(parsed: ParsedHistoryArgs): string[] {
  const argv = ["exec", "-T", PHOEBE_SERVICE, "phoebe", "history"];
  if (parsed.tenant !== undefined) argv.push("--tenant", parsed.tenant);
  if (parsed.pipeline !== undefined) argv.push("--pipeline", parsed.pipeline);
  for (const name of QUERY_FLAGS) {
    const value = parsed.query[name];
    if (value !== undefined) argv.push(`--${name}=${value}`);
  }
  if (parsed.export !== undefined) argv.push(`--export=${parsed.export}`);
  if (parsed.json) argv.push("--json");
  return argv;
}

/**
 * Narrow the report's cells to `--tenant` and `--pipeline`. Naming a tenant or
 * a pipeline the deployment does not have is an error, not an empty page: an
 * empty page would read as "nothing ran".
 */
export function narrowSources(
  report: DeploymentReport,
  sources: readonly HistorySource[],
  opts: { tenant?: string; pipeline?: string },
): HistorySource[] {
  if (opts.tenant === undefined && opts.pipeline === undefined) return [...sources];
  const wanted = new Set(
    report.fleet.cells
      .filter(
        (cell) =>
          (opts.tenant === undefined || cell.tenant.slug === opts.tenant) &&
          (opts.pipeline === undefined || cell.pipeline === opts.pipeline),
      )
      .map((cell) => cell.id),
  );
  if (wanted.size === 0) {
    const named = [
      ...(opts.tenant !== undefined ? [`tenant ${opts.tenant}`] : []),
      ...(opts.pipeline !== undefined ? [`pipeline ${opts.pipeline}`] : []),
    ].join(" and ");
    const known = report.fleet.cells
      .map((cell) => `${cell.tenant.slug ?? cell.tenant.path} ${cell.pipeline}`)
      .join(", ");
    throw new Error(
      `This deployment has no cell for ${named}. It has: ${known.length > 0 ? known : "none"}.`,
    );
  }
  return sources.filter((source) => wanted.has(source.cell));
}

// ───────────────────────────── the table ─────────────────────────────

function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** `1.2k`, `3.4M`: tokens at a glance. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A unit's cost: `$0.42`, `$0.42 est.` for a subscription estimate, `—` when none was reported. */
export function formatRecordCost(record: HistoryRecord): string {
  let api: number | null = null;
  let estimate: number | null = null;
  for (const run of record.agentRuns) {
    if (run.costUsd === null) continue;
    if (run.costBasis === "subscription-estimate") estimate = (estimate ?? 0) + run.costUsd;
    else api = (api ?? 0) + run.costUsd;
  }
  const parts = [
    ...(api !== null ? [dollars(api)] : []),
    ...(estimate !== null ? [`${dollars(estimate)} est.`] : []),
  ];
  return parts.length === 0 ? "—" : parts.join(" + ");
}

/** Tokens in and out across a unit's agent runs, `—` for a side no run reported. */
export function formatRecordTokens(record: HistoryRecord): string {
  const sum = (values: readonly (number | null)[]): string => {
    const known = values.filter((value): value is number => value !== null);
    return known.length === 0 ? "—" : compactCount(known.reduce((a, b) => a + b, 0));
  };
  const input = sum(record.agentRuns.map((run) => run.inputTokens));
  const output = sum(record.agentRuns.map((run) => run.outputTokens));
  const partial = record.agentRuns.some((run) => !run.usageComplete);
  return `${input}/${output}${partial ? "+" : ""}`;
}

function refOf(record: HistoryRecord): string {
  const id = /^\d+$/.test(record.unit.id) ? `#${record.unit.id}` : record.unit.id;
  return `${record.unit.kind} ${id}`;
}

function outcomeOf(record: HistoryRecord): string {
  return record.quarantined ? `${record.outcome} (quarantined)` : record.outcome;
}

/** One line of totals: counts by outcome, then cost by basis. */
export function formatHistoryTotals(totals: HistoryTotals): string {
  const counts = [
    `${totals.units} unit${totals.units === 1 ? "" : "s"}`,
    ...(
      [
        ["completed", "completed"],
        ["unproductive", "unproductive"],
        ["failed", "failed"],
        ["timed-out", "timed out"],
        ["abandoned", "abandoned"],
      ] as const
    )
      .filter(([key]) => totals.byOutcome[key] > 0)
      .map(([key, label]) => `${totals.byOutcome[key]} ${label}`),
  ];
  if (totals.quarantined > 0) counts.push(`${totals.quarantined} quarantined`);
  const costs: string[] = [];
  if (totals.costUsd.api > 0) costs.push(`${dollars(totals.costUsd.api)} api`);
  if (totals.costUsd.subscriptionEstimate > 0) {
    costs.push(`${dollars(totals.costUsd.subscriptionEstimate)} est.`);
  }
  const notes: string[] = [];
  if (totals.unitsWithoutCost > 0) notes.push(`${totals.unitsWithoutCost} without cost`);
  if (totals.unitsWithPartialUsage > 0) {
    notes.push(`${totals.unitsWithPartialUsage} with partial usage`);
  }
  return [
    counts.join(", "),
    ...(costs.length > 0 ? [costs.join(" + ")] : []),
    ...(notes.length > 0 ? [`(${notes.join(", ")})`] : []),
  ].join("  ");
}

/** The text view: one row per record, then the summary, how far back each cell reaches, and the next page. */
export function formatHistoryPage(page: HistoryPage, now: number): string {
  const lines: string[] = [];
  if (page.records.length === 0) {
    lines.push("[phoebe] no units match.");
  } else {
    const tenants = new Set(page.records.map((record) => record.tenant));
    const rows = page.records.map((record) => [
      `${formatAge(now - Date.parse(record.startedAt))} ago`,
      tenants.size > 1 ? `${record.tenant} ${record.pipeline}` : record.pipeline,
      refOf(record),
      outcomeOf(record),
      record.model ?? "—",
      record.durationMs === null ? "—" : formatAge(record.durationMs),
      formatRecordCost(record),
      formatRecordTokens(record),
    ]);
    const header = ["age", "pipeline", "unit", "outcome", "model", "took", "cost", "tokens in/out"];
    const widths = header.map((title, column) =>
      Math.max(title.length, ...rows.map((row) => row[column]!.length)),
    );
    const render = (row: readonly string[]): string =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join("  ");
    lines.push(render(header), ...rows.map(render));
  }
  lines.push("", `[phoebe] matched   ${formatHistoryTotals(page.summary)}`);
  const cells = Object.entries(page.retained);
  for (const [cell, oldest] of cells) {
    const reach =
      oldest === null
        ? "no units recorded"
        : `since ${oldest} (${formatAge(now - Date.parse(oldest))} ago)`;
    lines.push(`[phoebe] retained  ${cell}  ${reach}`);
  }
  if (page.nextBefore !== null) {
    lines.push(`[phoebe] more      phoebe history --before ${page.nextBefore}  (same filters)`);
  }
  return lines.join("\n");
}

// ───────────────────────────── the verb ─────────────────────────────

type HistoryIo = {
  stdout: (text: string) => void;
  stderr: (line: string) => void;
};

export type HistoryDeps = Partial<ContainerExecDeps> & {
  inContainer?: boolean;
  /** Reads `state/deployment.json` and each history file; throwing means "not there". */
  read?: ReadText;
  now?: number;
  io?: Partial<HistoryIo>;
};

function historyIo(deps: HistoryDeps | undefined): HistoryIo {
  return {
    stdout: deps?.io?.stdout ?? ((text) => process.stdout.write(text)),
    stderr: deps?.io?.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
  };
}

/** The in-container arm's read: the report names the cells, the files hold the records. */
function containerHistory(
  parsed: ParsedHistoryArgs,
  deps: HistoryDeps | undefined,
): { query: HistoryQuery; read: (query: HistoryQuery) => HistoryPage } {
  const dataBase = resolveDataBase(deps?.env ?? process.env);
  const path = deploymentReportPath(dataBase);
  const file = deps?.read !== undefined ? readReportFile(path, deps.read) : readReportFile(path);
  if (file === null) {
    throw new Error(
      "No deployment report, so no list of cells to read history from: the bootstrapper " +
        `has not booted on this volume (${path}).`,
    );
  }
  const sources = narrowSources(file.report, historySourcesOf(file.report, dataBase), parsed);
  const read = deps?.read;
  return {
    query: parseHistoryQuery(parsed.query),
    read: (query) =>
      read !== undefined ? queryHistory(sources, query, read) : queryHistory(sources, query),
  };
}

/** The in-container arm: one page. */
export function runHistoryInContainer(parsed: ParsedHistoryArgs, deps?: HistoryDeps): HistoryPage {
  const { query, read } = containerHistory(parsed, deps);
  return read(query);
}

/**
 * The in-container arm of `--export`: the head, then every page under the
 * same filters, the largest a page holds, until the cursor runs out. Returns
 * how many records it wrote.
 */
export function exportHistoryInContainer(
  parsed: ParsedHistoryArgs,
  format: HistoryExportFormat,
  write: (text: string) => void,
  deps?: HistoryDeps,
): number {
  const { query, read } = containerHistory(parsed, deps);
  write(historyExportHead(format));
  let written = 0;
  let before = query.before;
  for (;;) {
    const page = read({
      ...query,
      limit: HISTORY_MAX_LIMIT,
      ...(before !== undefined ? { before } : {}),
    });
    if (page.records.length > 0) write(historyExportLines(format, page.records));
    written += page.records.length;
    if (page.nextBefore === null || page.records.length === 0) return written;
    before = page.nextBefore;
  }
}

/** `phoebe history`. */
export async function runHistoryCli(argv: readonly string[], deps?: HistoryDeps): Promise<void> {
  const parsed = parseHistoryArgs(argv);
  const io = historyIo(deps);
  if (parsed.help) {
    io.stdout(HISTORY_HELP_TEXT);
    return;
  }
  if (deps?.inContainer ?? isInsideContainer()) {
    if (parsed.export !== undefined) {
      const written = exportHistoryInContainer(parsed, parsed.export, io.stdout, deps);
      io.stderr(`[phoebe] exported ${written} unit${written === 1 ? "" : "s"}.`);
      return;
    }
    const page = runHistoryInContainer(parsed, deps);
    io.stdout(
      parsed.json
        ? `${JSON.stringify(page)}\n`
        : `${formatHistoryPage(page, deps?.now ?? Date.now())}\n`,
    );
    return;
  }
  const execDeps: ContainerExecDeps = { ...deps, cwd: deps?.cwd ?? process.cwd() };
  const deployment = await runningDeployment("history", execDeps);
  const result = await runCompose({
    deployment,
    args: historyExecArgv(parsed),
    inheritStdio: true,
    ...(deps?.runner !== undefined ? { runner: deps.runner } : {}),
  });
  if (result.code !== 0) process.exitCode = result.code;
}
