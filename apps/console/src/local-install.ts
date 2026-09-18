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
} from "phoebe-agent/contracts";
import type { ConfigReading, ConnectionCard, DeploymentTab } from "./tabs.ts";

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
