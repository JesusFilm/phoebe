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
    case "pair":
      return pairOutcomeReading(outcome.outcome);
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

function pairOutcomeReading(outcome: OutcomeOf<"pair">): string {
  const moved = outcome.movedRelay ? ", moved off the relay it named before" : "";
  return (
    `paired as ${outcome.deploymentName} with ${outcome.relayUrl}${moved} — the token is ` +
    `spendable until ${outcome.expiresAt}`
  );
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
 * Which local installs are the relay rows the console is already drawing, and
 * which rows those are (#526, #558).
 *
 * A paired install is **one** thing on two arms: a folder this machine drives
 * through Compose, and a deployment that dials a relay. The rail shows it once,
 * under This machine, because local is the richer arm — the verbs and the
 * direct writes are there — and the Relay group drops the row it would
 * otherwise draw beside it.
 *
 * The join is the deployment's name on the relay it dials. `deploymentName` is
 * what the deployment tells the relay it is called (#505 §3), read off the same
 * config the deployment reads; the host of `relayUrl` is what says the two are
 * talking about the same relay at all. Hosts rather than whole URLs, because a
 * deployment dials `wss://host/deployments` and an operator signs in at
 * `https://host` — the same relay, spelled for two different protocols.
 *
 * Names are not unique on a relay (#505 §5), so two installs dialling one relay
 * under one name would both claim its row. That is a fleet with two deployments
 * answering to one name, which the relay itself cannot tell apart either; the
 * fix is a `relay.name` on one of them, and the rail saying so is better than
 * the rail hiding it.
 */
export function pairedInstalls(
  installs: readonly LocalInstall[],
  facts: readonly { row: { fingerprint: string; name: string } }[],
  relayUrl: string | null,
): Map<string, string> {
  const paired = new Map<string, string>();
  for (const install of installs) {
    if (!sameRelay(install.relayUrl, relayUrl)) continue;
    const row = facts.find((candidate) => candidate.row.name === install.deploymentName);
    if (row !== undefined) paired.set(install.dir, row.row.fingerprint);
  }
  return paired;
}

/**
 * Do these two addresses name one relay? Compared by host: the deployment's is
 * a `wss://` URL with the deployments path on it and the console's is the
 * `https://` address a person signed in at, and demanding they match as strings
 * would mean no install ever looked paired.
 */
export function sameRelay(dialled: string | null, relay: string | null): boolean {
  if (dialled === null || relay === null) return false;
  try {
    return new URL(dialled).host === new URL(relay).host;
  } catch {
    return false;
  }
}

/**
 * Whether this install can be paired, and what to say when it cannot (#558).
 *
 * Two refusals, both of them states rather than failures: a companion with no
 * relay session has nothing to mint a token on, and a container that is not up
 * is not going to spend one. Each is a sentence on a disabled button, because
 * an operator who presses Pair and gets an error has learnt the same thing one
 * step later.
 */
export type PairReading =
  | { kind: "paired" }
  | { kind: "ready" }
  | { kind: "blocked"; reason: string };

export function pairReading(
  install: LocalInstall,
  arm: { signedIn: boolean; paired: boolean },
): PairReading {
  if (arm.paired) return { kind: "paired" };
  if (!arm.signedIn) {
    return {
      kind: "blocked",
      reason: "Sign in to a relay on the rail first — pairing mints a token on it.",
    };
  }
  if (install.state !== "running") {
    return {
      kind: "blocked",
      reason: "Start this install first — pairing writes a token its next boot spends.",
    };
  }
  return { kind: "ready" };
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
