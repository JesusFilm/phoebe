// `phoebe status` — the one verb that answers "is it alive, and what is it
// doing" (#533, decisions in #508, map #497).
//
// It is a **reader**, and that is the whole design. The bootstrapper writes one
// deployment report (`state/deployment.json`, #532) with every derived answer
// already in it; this module renders that file and derives nothing. A pipeline's
// state and its `wedged?` verdict are the report's, the doctor verdict is the
// report's, the crash-loop record is the report's. So `phoebe status`, the web
// console and the companion cannot disagree about a deployment, because only one
// of them ever decides anything (#501).
//
// **One verb, either side of the wall.** The data volume is a named Compose
// volume, so the host has no path into `state/`. Inside the container status
// reads the file directly; on the host it drives Compose the way `stop` and
// `start` do and execs *itself* in the container, flags and exit code passed
// through. The host arm is a thin exec and never a second reader (#508 §1).
//
// **A missing or old report is a fact, not a state** (#508 §4). In the container
// the one thing status can ask for itself is whether `phoebe boot` is the
// process holding the container open. It is not alive → a header saying so with
// the age of the last report, and the report beneath it. There is no file →
// "no deployment report". Neither is dressed up as a deployment state, and there
// is no staleness threshold: "the bootstrapper is not running" and "the report
// is 3h old" are both facts an operator can act on, while "stale" is a guess.
//
// `--json` prints the file byte for byte — not a re-serialization of it, which
// would let this renderer's idea of the report drift from the bootstrapper's.

import { readFileSync } from "node:fs";
import type {
  ChildLiveness,
  DeploymentReport,
  FleetCell,
  RelayReport,
  TenantFacts,
} from "./contracts/deployment.ts";
import type { DoctorSection } from "./contracts/doctor.ts";
import { deploymentReportPath } from "../bootstrap/deployment-report.ts";
import type { DeploymentField } from "./config-schema.ts";
import { readDeploymentCommands } from "./deployment-command.ts";
import {
  composeFailureError,
  dockerOnPath,
  findPhoebeService,
  formatResolveFailure,
  isContainerRunning,
  noDockerMessage,
  parseComposePsJson,
  resolveDeploymentCompose,
  runCompose,
  type CommandRunner,
  type DeploymentCompose,
} from "./deployment-compose.ts";
import { bootIsMainProcess, isInsideContainer } from "./execution-gate.ts";
import { resolveDataBase } from "./paths.ts";
import { formatAge } from "./pipeline-listing.ts";

/** The Compose service the container runs under — the one `stop`/`start` probe. */
export const PHOEBE_SERVICE = "phoebe";

/** Which verb the operator typed. `list` is the deprecated alias (#508 §3). */
export type StatusVerb = "status" | "list";

export type ParsedStatusArgs = {
  help: boolean;
  /** Print `state/deployment.json` verbatim. */
  json: boolean;
  /** Inline the whole doctor table under the doctor line. */
  verbose: boolean;
  /** Exit 1 on anything worth a look — see {@link statusFindings}. */
  check: boolean;
};

export function parseStatusArgs(
  argv: readonly string[],
  verb: StatusVerb = "status",
): ParsedStatusArgs {
  const parsed: ParsedStatusArgs = { help: false, json: false, verbose: false, check: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--verbose") parsed.verbose = true;
    else if (arg === "--check") parsed.check = true;
    else {
      throw new Error(
        `Unknown flag \`${arg}\` for \`phoebe ${verb}\`. See \`phoebe ${verb} --help\`.`,
      );
    }
  }
  return parsed;
}

export const STATUS_HELP_TEXT = `phoebe status — what this deployment is doing, from its own report

Usage:
  phoebe status              The text view (bootstrapper, relay, fleet, doctor)
  phoebe status --verbose    ...with doctor's full table inlined
  phoebe status --json       Print state/deployment.json verbatim
  phoebe status --check      Exit 1 when something needs a look

Reads the deployment report the bootstrapper keeps on the data volume and
renders it — every state and verdict in the view is the report's, derived once
there so that this command, the console and the companion cannot disagree.

Run it either side of the container wall. Inside, it reads the file. On the
host it drives the deployment's container/compose.yml and execs itself in the
container, passing flags and exit code through; a container that is not running
is reported before any exec.

--check exits 1 on: a wedged or crash-looping pipeline, a failing doctor check
in the report, a held tenant, no bootstrapper, or no report. Doctor warnings and
stale pipeline directories do not trip it.
`;

export const LIST_HELP_TEXT = `phoebe list — deprecated alias for the fleet section of \`phoebe status\`

Usage:
  phoebe list [--json] [--check] [--verbose]

Prints \`phoebe status\`'s fleet section and nothing else. Every flag behaves as
it does there, --json included: it prints the whole deployment report verbatim.
Use \`phoebe status\`; this alias goes away at the next major.
`;

/** The one-line notice `phoebe list` prints before its output (#508 §3). */
export const LIST_DEPRECATION_NOTICE =
  "[phoebe] `phoebe list` is deprecated: `phoebe status` shows this same fleet section " +
  "plus the bootstrapper, relay and doctor lines. The alias goes away at the next major.";

/** The report as it sits on disk: the parsed object and the bytes it came from. */
export type ReportFile = { raw: string; report: DeploymentReport };

/**
 * Read the report, or null when there is none. The raw text is kept because
 * `--json` prints the file rather than a re-serialization of it.
 *
 * An unreadable file is null too, and for the same reason a missing one is: both
 * mean this command has nothing to render, and the header it prints instead says
 * so. A parse failure throws — a file that exists but is not a report is a fault
 * worth a non-zero exit, not a deployment state.
 */
export function readReportFile(
  path: string,
  read: (target: string) => string = (target) => readFileSync(target, "utf8"),
): ReportFile | null {
  let raw: string;
  try {
    raw = read(path);
  } catch {
    return null;
  }
  return { raw, report: JSON.parse(raw) as DeploymentReport };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * How long something has been the case: `3h`, or `unknown` for a stamp that will
 * not parse. Used for a state a thing is still in — running since, connected
 * since — where "ago" would read as though it had ended.
 */
function sinceOf(stamp: string, now: number): string {
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? formatAge(now - at) : "unknown";
}

/** `N ago` for something that already happened: a write, an exit, a close. */
function ageOf(stamp: string, now: number): string {
  const since = sinceOf(stamp, now);
  return since === "unknown" ? since : `${since} ago`;
}

/**
 * The bootstrapper line: which engine is running, whether it is the one the
 * config names, whether a relaunch is under way, and how old the report is
 * (#508 §2). The report age is dropped when the header above already carries it
 * — a bootstrapper that is not running has one age, not two.
 */
export function formatBootstrapperLine(
  report: DeploymentReport,
  opts: { now: number; withReportAge: boolean },
): string {
  const { bootstrapper } = report;
  const ref = bootstrapper.engineRef ?? "unknown ref";
  const sha = bootstrapper.engineSha === null ? null : shortSha(bootstrapper.engineSha);
  const parts = [`engine ${ref}${sha === null ? "" : ` → ${sha}`}`];
  if (bootstrapper.quarantinedSha !== null) {
    parts.push(`quarantined (avoiding ${shortSha(bootstrapper.quarantinedSha)})`);
  } else if (bootstrapper.crashLoop.failingSha !== null) {
    parts.push(
      `crash-loop (${shortSha(bootstrapper.crashLoop.failingSha)} ×${bootstrapper.crashLoop.failureCount})`,
    );
  }
  if (bootstrapper.reconcile.phase === "reconciling") {
    parts.push(`reconciling (${bootstrapper.reconcile.reason})`);
  }
  parts.push(`slots ${bootstrapper.slots.inUse}/${bootstrapper.slots.capacity}`);
  if (opts.withReportAge) parts.push(`report ${ageOf(report.updatedAt, opts.now)}`);
  return `[phoebe] bootstrapper  ${parts.join("  ")}`;
}

/**
 * The relay line, or null when this deployment has no relay. Facts only — what
 * the relay itself makes of the connection is the relay's to say (#507 §8), and
 * whether the pairing is healthy is doctor's.
 */
export function formatRelayLine(
  relay: RelayReport | undefined,
  name: string,
  now: number,
): string | null {
  if (relay === undefined || !relay.configured) return null;
  // The section is stamped when it moves, so its `updatedAt` is the age of the
  // word beside it — there is no second clock to read.
  const parts = [`${relay.state} ${sinceOf(relay.updatedAt, now)}`];
  if (relay.state === "reconnecting" && relay.nextRetryAt !== null) {
    const at = Date.parse(relay.nextRetryAt);
    parts.push(Number.isFinite(at) ? `next retry in ${formatAge(at - now)}` : "next retry unknown");
  }
  if (relay.lastClose !== null) {
    parts.push(`last close ${relay.lastClose.code} ${ageOf(relay.lastClose.at, now)}`);
  }
  // The deployment's own name, not a second one: the relay keys on the
  // deployment's key and never on a name, so there is only ever one.
  return `[phoebe] relay         ${name}  ${parts.join("  ")}`;
}

/** The tenant's own columns, as `phoebe list` has always shown them. */
function formatHealthColumns(tenant: TenantFacts): string {
  const flag = (label: string, on: boolean): string => `${on ? "✓" : "✗"} ${label}`;
  return (
    `${flag("config", tenant.configValid)}  ${flag("env", tenant.envPresent)}  ` +
    `${flag("data", tenant.retainedData)}  arm: ${tenant.arm}`
  );
}

function formatTenantRow(tenant: TenantFacts): string {
  const slugSuffix = tenant.slug !== null ? `  (${tenant.slug})` : "";
  const held = `held — ${tenant.reason ?? "held"}`;
  const detail = !tenant.held
    ? formatHealthColumns(tenant)
    : tenant.slug !== null
      ? `${held}  ${formatHealthColumns(tenant)}`
      : held;
  return `  ${tenant.path}${slugSuffix}\n      ${detail}`;
}

/** Where the cell came from, or that the pipeline is switched off. */
function formatCellMark(cell: FleetCell): string {
  if (cell.source === "stale") return "  (stale)";
  if (cell.source === "disk") return "  (from disk)";
  return cell.disabled ? "  (disabled)" : "";
}

/**
 * The process line — the bootstrapper's half of a pipeline (#507 §2): is there a
 * child, since when, and what it has been doing to itself. A cell with no child
 * entry is not supervised by this bootstrapper at all, which is the honest thing
 * to say about a stale or on-disk cell.
 */
export function formatProcessLine(child: ChildLiveness | undefined, now: number): string {
  if (child === undefined) return "not supervised";
  const parts: string[] = [];
  if (child.state === "exited") {
    const exit = child.lastExit;
    const how =
      exit === null
        ? "exited"
        : exit.signal !== null
          ? `exited on ${exit.signal}`
          : `exited (code ${exit.code ?? "unknown"})`;
    parts.push(`${how} ${ageOf(child.since, now)}`);
  } else {
    // Still in this state, so the clock is a duration and not an "ago".
    parts.push(`${child.state} ${sinceOf(child.since, now)}`);
  }
  if (child.restarts > 0) {
    parts.push(`${child.restarts} restart${child.restarts === 1 ? "" : "s"}`);
  }
  if (child.crashLooping) parts.push("crash-looping");
  return parts.join(", ");
}

/**
 * The state line — what the pipeline's own snapshot last said, as the report
 * derived it, with the wedged verdict beside it. `k/N` counts the units the
 * snapshot carries against the pipeline's declared concurrency; nothing here
 * re-derives the state or the verdict.
 *
 * The wedged detail names the clause, and for the pass clause the silence the
 * report stamped. `lastPassAt` itself is never shown as an age (#507 §3): the
 * file is not rewritten per pass, so between writes it is deliberately stale.
 */
export function formatStateLine(cell: FleetCell): string {
  const parts: string[] = [];
  if (cell.state === "working") {
    const units = cell.snapshot?.currentUnits ?? [];
    const capacity =
      cell.concurrency !== null ? `${units.length}/${cell.concurrency}` : String(units.length);
    const refs = units.map((current) => `${current.unit.kind} ${current.unit.id}`).join(", ");
    parts.push(`working ${capacity}${refs.length > 0 ? ` ${refs}` : ""}`);
  } else {
    parts.push(cell.state);
  }
  if (cell.wedged.wedged) {
    parts.push(
      cell.wedged.reason === "unit-overdue"
        ? "wedged? unit past its budget"
        : `wedged? no pass for ${formatAge(cell.wedged.noPassForMs)}`,
    );
  }
  return parts.join("  ");
}

function childrenById(report: DeploymentReport): Map<string, ChildLiveness> {
  return new Map(report.bootstrapper.children.map((child) => [child.id, child]));
}

/**
 * The fleet section: every tenant's row, and under it two lines per pipeline —
 * the process line and the state line (#507 §2). This is the whole of what
 * `phoebe list` prints, which is what makes it an alias rather than a second
 * reader.
 */
export function formatFleetSection(report: DeploymentReport, now: number): string {
  const { fleet } = report;
  const children = childrenById(report);
  const header =
    `[phoebe] fleet         ${fleet.tenants.length} tenant(s), ${fleet.cells.length} pipeline(s)` +
    `  updated ${ageOf(fleet.updatedAt, now)}`;
  const lines: string[] = [header];
  if (fleet.tenants.length === 0) {
    lines.push("  (no tenants — nothing declared here)");
    return lines.join("\n");
  }
  for (const tenant of fleet.tenants) {
    lines.push(formatTenantRow(tenant));
    const cells = fleet.cells.filter((cell) => cell.tenant.id === tenant.id);
    const width = Math.max(0, ...cells.map((cell) => cell.pipeline.length));
    for (const cell of cells) {
      lines.push(
        `        ${cell.pipeline.padEnd(width)}  ${formatProcessLine(children.get(cell.id), now)}` +
          formatCellMark(cell),
      );
      lines.push(`        ${" ".repeat(width)}  ${formatStateLine(cell)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Doctor in one line: the counts and their age, or that a run is in flight, or
 * that the bootstrapper has never run one. "Never run" is a fact about this
 * deployment, not a verdict about its health.
 */
export function formatDoctorLine(section: DoctorSection, now: number): string {
  const prefix = "[phoebe] doctor        ";
  if (section.running !== undefined) {
    return `${prefix}running ${sinceOf(section.running.since, now)} (${section.running.trigger})`;
  }
  // The section is always there; what is absent until the first run lands is
  // the report inside it, which is the honest "never".
  if (section.report === null || section.at === null) return `${prefix}never run`;
  const report = section.report;
  const checks = [...report.checks, ...report.tenants.flatMap((row) => row.checks)];
  const count = (state: string): number => checks.filter((check) => check.state === state).length;
  const fails = count("fail");
  const warns = count("warn");
  const verdict = fails === 0 && warns === 0 ? "healthy" : `${fails} fail, ${warns} warn`;
  const parts = [`${verdict} — ${ageOf(section.at, now)} (${section.trigger})`];
  if (section.lastAttempt !== undefined) {
    parts.push(`last attempt ${section.lastAttempt.outcome} ${ageOf(section.lastAttempt.at, now)}`);
  }
  return `${prefix}${parts.join("  ")}`;
}

/** The header that states a bootstrapper which is not running (#508 §4). */
export function formatDarkHeader(report: DeploymentReport, now: number): string {
  return `[phoebe] bootstrapper not running; last report ${ageOf(report.updatedAt, now)}`;
}

/** What `status` says when the volume carries no report at all (#508 §4). */
export const NO_REPORT_MESSAGE =
  "[phoebe] no deployment report: the bootstrapper has not booted on this volume.";

export type StatusView = {
  report: DeploymentReport;
  now: number;
  /** Is `phoebe boot` the container's main process? */
  bootAlive: boolean;
  /** `list` prints the fleet section alone. */
  section: "all" | "fleet";
  verbose: boolean;
  /** Doctor's own table, for `--verbose`. Injected so this stays a pure render. */
  doctorTable?: (section: DoctorSection) => string;
};

/**
 * The whole text view, in the priority order #508 §2 fixes: what the
 * bootstrapper is doing, then the relay, then the fleet, then doctor. Priority
 * order is the point — an operator reads down until something is wrong and
 * stops.
 */
export function formatStatusReport(view: StatusView): string {
  const { report, now } = view;
  const lines: string[] = [];
  // The header rides above the fleet section too: a bootstrapper that is not
  // running is exactly what makes the cells below it old, and the alias must not
  // be the quieter way to read them.
  if (!view.bootAlive) lines.push(formatDarkHeader(report, now));
  if (view.section === "fleet") {
    lines.push(formatFleetSection(report, now));
    return lines.join("\n");
  }
  lines.push(formatBootstrapperLine(report, { now, withReportAge: view.bootAlive }));
  const relay = formatRelayLine(report.relay, report.identity.name, now);
  if (relay !== null) lines.push(relay);
  lines.push(formatFleetSection(report, now));
  lines.push(formatDoctorLine(report.doctor, now));
  if (view.verbose && report.doctor !== undefined && view.doctorTable !== undefined) {
    lines.push(
      view
        .doctorTable(report.doctor)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
  }
  return lines.join("\n");
}

/**
 * Everything `--check` exits 1 for, named (#508 §5). One list, so a host cron
 * and the console agree on "needs a look": a wedged pipeline, a crash-looping
 * one, a failing doctor check in the cached report, a held tenant, a
 * bootstrapper that is not running, or no report at all. Doctor *warnings* and
 * stale pipeline directories are deliberately not here — neither is a thing to
 * wake anyone for.
 */
export function statusFindings(opts: {
  report: DeploymentReport | null;
  bootAlive: boolean;
}): string[] {
  if (opts.report === null) return ["no deployment report"];
  const findings: string[] = [];
  if (!opts.bootAlive) findings.push("bootstrapper not running");
  for (const cell of opts.report.fleet.cells) {
    if (cell.wedged.wedged) findings.push(`wedged: ${cell.id} (${cell.wedged.reason})`);
  }
  for (const child of opts.report.bootstrapper.children) {
    if (child.crashLooping) findings.push(`crash-looping: ${child.id}`);
  }
  const doctor = opts.report.doctor;
  if (doctor.report !== null && !doctor.report.ok) findings.push("doctor: failing check(s)");
  for (const tenant of opts.report.fleet.tenants) {
    if (tenant.held) findings.push(`held tenant: ${tenant.path}`);
  }
  return findings;
}

type StatusIo = {
  stdout: (text: string) => void;
  stderr: (line: string) => void;
};

export type StatusDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inContainer?: boolean;
  /** Is `phoebe boot` PID 1? Only consulted on the in-container arm. */
  bootAlive?: boolean;
  /** Reads `state/deployment.json`; throwing means "no report". */
  readReport?: (path: string) => string;
  runner?: CommandRunner;
  dockerAvailable?: boolean;
  exists?: (path: string) => boolean;
  /** The `deployment` block, when the config carries one (#261). */
  deploymentCommands?: DeploymentField;
  now?: number;
  io?: Partial<StatusIo>;
};

function statusIo(deps: StatusDeps | undefined): StatusIo {
  return {
    stdout: deps?.io?.stdout ?? ((text) => process.stdout.write(text)),
    stderr: deps?.io?.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
  };
}

/** Doctor's own table, imported only when `--verbose` asks for it. */
async function loadDoctorTable(): Promise<(section: DoctorSection) => string> {
  const { formatDoctorReport } = await import("./doctor.ts");
  return (section) => (section.report === null ? "" : formatDoctorReport(section.report));
}

/**
 * The in-container arm: read the file, render it, and answer `--check`. The one
 * live question it asks is whether `phoebe boot` is still the container's main
 * process — everything else in the view is the report's.
 */
export async function runStatusInContainer(opts: {
  parsed: ParsedStatusArgs;
  verb: StatusVerb;
  deps?: StatusDeps;
}): Promise<number> {
  const deps = opts.deps;
  const io = statusIo(deps);
  const now = deps?.now ?? Date.now();
  const path = deploymentReportPath(resolveDataBase(deps?.env ?? process.env));
  const file =
    deps?.readReport !== undefined ? readReportFile(path, deps.readReport) : readReportFile(path);
  const bootAlive = deps?.bootAlive ?? bootIsMainProcess();

  if (file === null) {
    if (opts.parsed.json) {
      throw new Error(
        "No deployment report to print: the bootstrapper has not booted on this volume, " +
          `so there is no ${path}.`,
      );
    }
    io.stdout(`${NO_REPORT_MESSAGE}\n`);
    return opts.parsed.check ? 1 : 0;
  }

  if (opts.parsed.json) {
    // Byte for byte. A re-serialization here is how a renderer's idea of the
    // report starts to drift from the bootstrapper's.
    io.stdout(file.raw.endsWith("\n") ? file.raw : `${file.raw}\n`);
  } else {
    io.stdout(
      `${formatStatusReport({
        report: file.report,
        now,
        bootAlive,
        section: opts.verb === "list" ? "fleet" : "all",
        verbose: opts.parsed.verbose,
        ...(opts.parsed.verbose && opts.verb === "status"
          ? { doctorTable: await loadDoctorTable() }
          : {}),
      })}\n`,
    );
  }

  if (!opts.parsed.check) return 0;
  const findings = statusFindings({ report: file.report, bootAlive });
  if (findings.length === 0) return 0;
  io.stderr(`[phoebe] needs a look: ${findings.join("; ")}`);
  return 1;
}

/** The flags to hand the in-container run, rebuilt rather than forwarded raw. */
export function statusExecArgv(verb: StatusVerb, parsed: ParsedStatusArgs): string[] {
  const argv = ["exec", "-T", PHOEBE_SERVICE, "phoebe", verb];
  if (parsed.json) argv.push("--json");
  if (parsed.verbose) argv.push("--verbose");
  if (parsed.check) argv.push("--check");
  return argv;
}

async function composePs(
  deployment: DeploymentCompose,
  runner: CommandRunner | undefined,
): Promise<ReturnType<typeof parseComposePsJson>> {
  const result = await runCompose({
    deployment,
    args: ["ps", "-a", "--format", "json"],
    ...(runner !== undefined ? { runner } : {}),
  });
  if (result.code !== 0) throw composeFailureError(result, "ps");
  return parseComposePsJson(result.stdout);
}

/** What the host says when the deployment drives its own runtime (#261). */
export function deploymentBlockMessage(verb: StatusVerb): string {
  return (
    `\`phoebe ${verb}\` reads the deployment report inside the container, and a config with a ` +
    "`deployment` block has no Compose file to exec through. Run it in your own runtime — " +
    `for Docker that is \`docker exec <container> phoebe ${verb}\`.`
  );
}

/**
 * The host arm (#508 §1): a thin exec, never a second reader. Compose answers
 * "is the container running" before any exec, because a stopped container is a
 * fact about the deployment and not a failure of this command to parse
 * something. The exec inherits stdio, so `--json` reaches the operator's pipe
 * unchanged and the in-container exit code is the one that comes back.
 */
export async function runStatusOnHost(opts: {
  parsed: ParsedStatusArgs;
  verb: StatusVerb;
  deps?: StatusDeps;
}): Promise<number> {
  const deps = opts.deps;
  const io = statusIo(deps);
  const cwd = deps?.cwd ?? process.cwd();

  if (deps?.deploymentCommands !== undefined) {
    throw new Error(deploymentBlockMessage(opts.verb));
  }
  if (!(deps?.dockerAvailable ?? dockerOnPath())) throw new Error(noDockerMessage(opts.verb));

  const resolved = resolveDeploymentCompose(cwd, deps?.exists);
  if ("kind" in resolved) throw new Error(formatResolveFailure(resolved));

  const service = findPhoebeService(await composePs(resolved, deps?.runner));
  if (service === undefined || !isContainerRunning(service)) {
    io.stdout("[phoebe] container not running — nothing is reading or writing the report.\n");
    io.stderr("Start it with `phoebe start`, then ask again.");
    return 1;
  }

  const result = await runCompose({
    deployment: resolved,
    args: statusExecArgv(opts.verb, opts.parsed),
    inheritStdio: true,
    ...(deps?.runner !== undefined ? { runner: deps.runner } : {}),
  });
  return result.code;
}

/**
 * `phoebe status` / `phoebe list`. Picks its arm from the container marker — the
 * same fact doctor's `supervisor` check reads — and sets the exit code from
 * whichever arm ran.
 */
export async function runStatusCli(
  argv: readonly string[],
  verb: StatusVerb = "status",
  deps?: StatusDeps,
): Promise<void> {
  const parsed = parseStatusArgs(argv, verb);
  const io = statusIo(deps);
  if (parsed.help) {
    io.stdout(verb === "list" ? LIST_HELP_TEXT : STATUS_HELP_TEXT);
    return;
  }
  if (verb === "list") io.stderr(LIST_DEPRECATION_NOTICE);

  const inContainer = deps?.inContainer ?? isInsideContainer();
  const code = inContainer
    ? await runStatusInContainer({ parsed, verb, ...(deps !== undefined ? { deps } : {}) })
    : await runStatusOnHost({
        parsed,
        verb,
        deps: {
          ...deps,
          ...(deps?.deploymentCommands === undefined
            ? await hostDeploymentCommands(deps?.cwd ?? process.cwd())
            : {}),
        },
      });
  if (code !== 0) process.exitCode = code;
}

/**
 * Read the `deployment` block on the host, as `start` and `stop` do. Reading the
 * config means executing the consumer's TS module, so it happens only on the arm
 * that needs the answer — never inside the container, where the block is
 * irrelevant.
 */
async function hostDeploymentCommands(
  cwd: string,
): Promise<{ deploymentCommands?: DeploymentField }> {
  const commands = await readDeploymentCommands(cwd);
  return commands !== undefined ? { deploymentCommands: commands } : {};
}
