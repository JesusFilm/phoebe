// The local arm, as the page holds it (#555).
//
// The console bundle has two arms and one shape for each. The relay's arm is a
// fleet of deployments with connection verdicts on them (fleet-state.ts); this
// one is the installs on this machine, whose states Compose answers directly.
// No dark, no unseen, no "maybe replaced" — those are a remote reader's guesses
// about silence, and there is no silence here.
//
// What lives in this module is the part with no React in it: the words the rail
// puts under a name, the reducers a run's events drive, and the one line an
// outcome reads as. Everything that renders takes the result as a prop.

import { MAX_RUN_LINES } from "phoebe-agent/contracts";
import type {
  CompanionEnvironment,
  LocalInstall,
  LocalReportEvent,
  OutcomeOf,
  RunExit,
  RunLine,
  StoredReport,
  VerbOutcome,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import type { ConfigReading, ConnectionCard, DeploymentTab } from "./tabs.ts";

// ── the two write verbs, as requests (#557) ───────────────────────────────

/**
 * A JSON literal, or a refusal naming what a config leaf may be.
 *
 * Typed as JSON rather than guessed at, because `300000` and `"300000"` are
 * different values and a form that decided for the operator would be the one
 * place a number quietly became a string. Objects and arrays are refused here
 * rather than by the writer: the writer's own refusal for one is about splicing,
 * and this one is about what somebody meant by putting a brace in a text field.
 */
export function readLiteral(raw: string): string | number | boolean | null {
  const text = raw.trim();
  if (text.length === 0) throw new Error("A value is a JSON literal; this box is empty.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${text} is not a JSON literal. A string needs its quotes: "main", not main.`);
  }
  if (parsed === null) return null;
  if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
    return parsed;
  }
  throw new Error("Only one leaf moves at a time, so the value has to be a scalar or null.");
}

/**
 * The `config set` run one form submission is (#527 §11).
 *
 * The fingerprint is not an input and never was: it is whatever config this arm
 * read, carried with the edit so the writer can refuse `stale` when the file has
 * moved since. That is the whole of the concurrency story, and it is the same on
 * both arms — which is why it is built here, beside the reading, rather than
 * inside a component.
 */
export function configSetRequest(opts: {
  install: LocalInstall;
  config: ConfigReading;
  path: string;
  literal: string;
}): VerbRunRequest {
  if (opts.config.kind === "absent") {
    throw new Error(`There is no ${opts.config.path} to change.`);
  }
  const path = opts.path.trim();
  if (path.length === 0) throw new Error("Name the field to change, as a dotted path.");
  return {
    install: opts.install.dir,
    verb: "config set",
    path,
    value: readLiteral(opts.literal),
    fingerprint: opts.config.fingerprint,
  };
}

/**
 * The `secret set` run one form submission is (#527 §7).
 *
 * The value rides in the request and nowhere else — no envelope, no relay, and
 * no copy kept anywhere this function can see. An empty tenant box is omitted
 * rather than sent blank, because the install decides for itself when nobody
 * names one.
 */
export function secretSetRequest(opts: {
  install: LocalInstall;
  key: string;
  value: string;
  tenant?: string;
}): VerbRunRequest {
  const key = opts.key.trim();
  if (key.length === 0) throw new Error("Name the key to set.");
  if (opts.value.length === 0) {
    throw new Error("A blank is not a secret. Clear it in a terminal to hand the key back.");
  }
  const tenant = (opts.tenant ?? "").trim();
  return {
    install: opts.install.dir,
    verb: "secret set",
    key,
    value: opts.value,
    ...(tenant.length === 0 ? {} : { tenant }),
  };
}

/** How the rail reads one install: a mark, and the sentence beside it. */
export function installReading(install: LocalInstall): { tone: string; text: string } {
  const text =
    install.state === "running"
      ? "running"
      : install.state === "stopped"
        ? "stopped"
        : "not initialised";
  return {
    tone: install.state,
    text: install.detail === undefined ? text : `${text} · ${install.detail}`,
  };
}

/** A line, applied to the run it belongs to. Events for other runs are ignored. */
export function applyRunLine(run: VerbRun | null, line: RunLine): VerbRun | null {
  if (run === null || run.runId !== line.runId) return run;
  const lines = [...run.lines, line];
  // The same bound main keeps, held here too: a page that sat through a long
  // migrate should not hold more of it than the process that produced it.
  return { ...run, lines: lines.length > MAX_RUN_LINES ? lines.slice(-MAX_RUN_LINES) : lines };
}

/** An exit, applied to the run it ends. */
export function applyRunExit(run: VerbRun | null, exit: RunExit): VerbRun | null {
  if (run === null || run.runId !== exit.runId) return run;
  return { ...run, exit };
}

/**
 * What a finished verb decided, in one line.
 *
 * Read off the typed outcome rather than scraped from the output, which is the
 * whole point of a run carrying one (#527 §4). A verb that printed nothing —
 * `doctor`, `migrate` — still has something to say here.
 *
 * One reader per verb, so each stays a total function over its own union and
 * the type-checker is the thing that notices when an outcome gains an arm.
 */
export function outcomeReading(outcome: VerbOutcome): string {
  switch (outcome.verb) {
    case "init":
      return initReading(outcome.outcome);
    case "start":
      return startReading(outcome.outcome);
    case "stop":
      return stopReading(outcome.outcome);
    case "upgrade":
      return upgradeReading(outcome.outcome);
    case "migrate":
      return migrateReading(outcome.outcome);
    case "doctor":
      return doctorReading(outcome.outcome);
    case "config set":
      return receiptReading(outcome.outcome);
    case "secret set":
      return secretSetReading(outcome.outcome);
  }
}

function initReading({ created, updated, skipped }: OutcomeOf<"init">): string {
  return [
    `${created.length} file${created.length === 1 ? "" : "s"} created`,
    `${updated.length} updated`,
    `${skipped.length} left alone`,
  ].join(", ");
}

function startReading(outcome: OutcomeOf<"start">): string {
  switch (outcome.kind) {
    case "started":
      return "started";
    case "already-running":
      return "already running";
    case "exited-immediately":
      return `the container exited immediately (code ${outcome.exitCode ?? "unknown"})`;
  }
}

function stopReading(outcome: OutcomeOf<"stop">): string {
  switch (outcome.kind) {
    case "stopped":
      return "stopped";
    case "stopped-now":
      return "stopped, the in-flight unit abandoned";
    case "already-stopped":
      return "already stopped";
    case "no-container":
      return "there was no container to stop";
    case "killed-mid-run":
      return "killed after the drain grace — a unit was still running";
    case "abandoned-now":
      return "abandoned after the short grace";
  }
}

function upgradeReading(outcome: OutcomeOf<"upgrade">): string {
  if (outcome.kind === "checked") {
    return outcome.ok ? "both halves are current" : "a half is behind its latest";
  }
  return outcome.ok ? `upgraded ${outcome.target}` : "the upgrade was refused";
}

function migrateReading({ rootReport, tenantEntries }: OutcomeOf<"migrate">): string {
  const applied = rootReport.results.filter((result) => result.state === "applied").length;
  const children = tenantEntries.filter((entry) => entry.verdict === "migrated").length;
  if (applied === 0 && children === 0) return "nothing to migrate";
  const childClause = children > 0 ? `, ${children} child(ren) migrated` : "";
  return `${applied} migration(s) applied${childClause}`;
}

/**
 * The receipt, in one line — the same words on both arms (#527 §11, §16).
 *
 * A refusal reads as its reason and its `why`, because those are the two halves
 * an operator acts on: which kind of no it was, and what about this config made
 * it one. The instruction is longer than a line and is rendered beside the
 * receipt rather than inside it.
 */
export function receiptReading(receipt: OutcomeOf<"config set">): string {
  return receipt.state === "written"
    ? `wrote ${receipt.path} = ${JSON.stringify(receipt.value)}`
    : `refused (${receipt.reason}): ${receipt.why}`;
}

/**
 * Which writer took the secret (#527 §8). The one thing this outcome is for:
 * a value in the `.env` and a value in the tenant store are in different
 * places with different reach, and an operator who meant one and got the other
 * has a secret somewhere they did not choose.
 */
export function secretSetReading(outcome: OutcomeOf<"secret set">): string {
  const where =
    outcome.writer === "container"
      ? `through the container, into ${outcome.target}`
      : `into ${outcome.target} on this machine`;
  const tenant = outcome.tenant === null ? "" : ` for ${outcome.tenant}`;
  return `set ${outcome.key}${tenant} ${where}`;
}

/**
 * Which writer a secret is about to reach, said before it is pasted (#527 §8).
 *
 * The same rule the companion applies, in the operator's words rather than in
 * its own: a running container has a tenant store to put the value in, and
 * anything else has the deployment `.env` on this machine.
 */
export function secretWriterReading(install: LocalInstall): string {
  return install.state === "running"
    ? "This container is up, so the value goes through it into the tenant secret store on the data volume. The running engine picks it up on its next relaunch."
    : "Nothing is running, so the value goes into this install's deployment `.env` on this machine — the file you would have opened in an editor. It reaches the engine the next time this install starts.";
}

function doctorReading({ checks }: OutcomeOf<"doctor">): string {
  const failed = checks.filter((check) => check.state === "fail").length;
  const warned = checks.filter((check) => check.state === "warn").length;
  if (failed > 0) return `${failed} check(s) failed, ${warned} warned`;
  return warned > 0 ? `${warned} check(s) warned` : "every check passed";
}

/**
 * What the install tab says about Docker (#522 §2, #527 §15).
 *
 * Four readings rather than a boolean, because they are four different things to
 * do: wait, install Docker, start Docker, get on with it. The companion checks
 * and never installs, so the missing arm is a sentence and a link.
 */
export type DockerReading =
  | { kind: "probing" }
  | { kind: "missing" }
  | { kind: "daemon-down" }
  | { kind: "ready"; text: string };

export function dockerReading(environment: CompanionEnvironment | null): DockerReading {
  if (environment === null) return { kind: "probing" };
  if (!environment.docker.present) return { kind: "missing" };
  if (!environment.docker.daemonRunning) return { kind: "daemon-down" };
  const compose =
    environment.docker.composeVersion === null
      ? ""
      : ` · Compose ${environment.docker.composeVersion}`;
  return {
    kind: "ready",
    text: `Docker is running${compose} · companion ${environment.companionVersion} on ${environment.platform}`,
  };
}

/** Which verbs an install in this state can be asked for. */
export function offeredVerbs(install: LocalInstall): {
  init: boolean;
  start: boolean;
  stop: boolean;
  upgrade: boolean;
  doctor: boolean;
} {
  const initialised = install.state !== "not-initialised";
  return {
    // Init is offered on an un-initialised folder and nowhere else: a folder
    // that already carries a config is adopted as it stands (#555), and init
    // over the top of one is a button whose best outcome is doing nothing.
    init: !initialised,
    start: initialised && install.state !== "running",
    stop: initialised && install.state === "running",
    upgrade: initialised,
    doctor: initialised && install.state === "running",
  };
}

// ── the local read loop, as the page reads it (#556) ──────────────────────

/**
 * What the overview's connection card says about a local install.
 *
 * The card is the one place on the five tabs where the arm shows, and it has to:
 * "connected for 3 h" under a fingerprint means something different from a
 * container on this machine that the window can start and stop. Everything below
 * the card renders the report and never asks where it came from.
 */
export function localConnection(install: LocalInstall): ConnectionCard {
  const state =
    install.state === "running"
      ? "its container is up"
      : install.state === "stopped"
        ? "its container is not up"
        : "it has no Phoebe install in it yet";
  return {
    arm: "Local install",
    detail: install.dir,
    note: `Read over the desktop bridge: the companion asks this machine's Docker directly, so ${state}. No relay is involved and nothing listens on a port.`,
  };
}

/**
 * The report this page may render, which is not the same as the last one it was
 * handed.
 *
 * A stopped install shows config and the stopped fact, never a report with an
 * age on it (#526). The loop keeps reading and the window keeps the last event
 * it received, so without this rule a container stopped ten minutes ago would
 * still be drawing pipelines that are not running.
 */
export function renderableReport(
  install: LocalInstall,
  event: LocalReportEvent | null,
): StoredReport | null {
  if (event === null || event.install !== install.dir) return null;
  return install.state === "running" ? event.report : null;
}

/**
 * Which tab an install opens on.
 *
 * A not-initialised folder lands on install, because that is where the button
 * that initialises it is and the rest of the page is empty (#526). A stopped one
 * lands on config, the only tab it can fill. A running one lands on overview,
 * like a remote deployment.
 */
export function landingTab(install: LocalInstall): DeploymentTab | "install" {
  if (install.state === "not-initialised") return "install";
  return install.state === "running" ? "overview" : "config";
}

/** The config as the directory facts hand it over (#527 §6). */
export function localConfig(event: LocalReportEvent | null): ConfigReading | null {
  if (event === null) return null;
  const { configPath, configText, configFingerprint } = event.directory;
  if (configText === null || configFingerprint === null)
    return { kind: "absent", path: configPath };
  return { kind: "file", path: configPath, text: configText, fingerprint: configFingerprint };
}
