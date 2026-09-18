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
  OutcomeOf,
  RunExit,
  RunLine,
  VerbOutcome,
  VerbRun,
} from "phoebe-agent/contracts";

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

/**
 * The two versions the install tab states, side by side (#525 §6).
 *
 * **Nothing refuses on a difference.** The companion drives this install; it
 * does not have to agree with it, and a window that locked its buttons because
 * a pin was a patch behind would be a window that stopped an operator from
 * running the very verb that fixes it. So this is a reading, and `Check for
 * upgrades` sits a few lines above it.
 */
export type VersionReading = {
  /** `container x.y.z · companion a.b.c`, with whichever halves are known. */
  text: string;
  /** Something to say beyond the two numbers, or null when there is not. */
  note: string | null;
};

export function versionReading(
  install: LocalInstall,
  environment: CompanionEnvironment | null,
): VersionReading {
  const companion = environment === null ? null : environment.companionVersion;
  const halves = [
    install.containerVersion === null ? "container —" : `container ${install.containerVersion}`,
    companion === null ? "companion —" : `companion ${companion}`,
  ];
  return { text: halves.join(" · "), note: versionNote(install, companion) };
}

function versionNote(install: LocalInstall, companion: string | null): string | null {
  if (install.state === "not-initialised") {
    return "This folder has no container yet, so there is no version in it to report.";
  }
  if (install.containerVersion === null) {
    return (
      "This install's Dockerfile pins no phoebe-agent version, so its build takes whatever " +
      "npm published last. Check for upgrades writes a pin."
    );
  }
  if (companion === null || companion === install.containerVersion) return null;
  return (
    `This install runs phoebe-agent ${install.containerVersion} and the companion is ${companion}. ` +
    "Nothing here refuses on that — Check for upgrades moves the install."
  );
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
