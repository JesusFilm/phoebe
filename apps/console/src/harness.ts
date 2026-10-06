// The AI harness, as a page says it.
//
// A harness is the agent CLI a provider spawns. The container carries one per
// provider it can run, at whatever version its Dockerfile installed, and each
// tenant's config names the provider it runs. So "which harness, which version"
// is a join: what the Dockerfile and the container say (main's half, as
// `HarnessFacts`) against which configs use which provider (read here, off the
// same field facts the config form draws).
//
// Pure. The section that checks and updates is harness-section.tsx.

import type {
  ConfigFieldFacts,
  HarnessApplyOutcome,
  HarnessFacts,
  HarnessName,
  HarnessPin,
  HarnessReport,
  HarnessUpdateOutcome,
  LauncherFacts,
  LocalInstall,
  LocalReportEvent,
  UpgradeOutcome,
} from "phoebe-agent/contracts";
import type { RailProblem } from "./local-install.ts";

/** Each harness by the name its vendor gives it, not the provider's short one. */
export const HARNESS_LABEL: Record<HarnessName, string> = {
  cursor: "Cursor agent",
  claude: "Claude Code",
  codex: "Codex",
};

const HARNESS_ORDER: readonly HarnessName[] = ["cursor", "claude", "codex"];

/**
 * The provider a config runs, off its field facts: the literal it sets, or the
 * default when it sets none. Null when the file computes it, or cannot be read.
 * An env var that overrides the file is not seen here; this is what the config
 * says, which is what a Dockerfile should be able to satisfy.
 */
export function providerOf(fields: readonly ConfigFieldFacts[] | undefined): HarnessName | null {
  const field = fields?.find((candidate) => candidate.path === "defaultProvider");
  if (field === undefined) return null;
  const value =
    field.state === "set" ? field.value : field.state === "unset" ? field.default : null;
  return HARNESS_ORDER.find((name) => name === value) ?? null;
}

/** A config that runs a harness: a tenant of the workspace, or the solo install itself. */
export type HarnessUser = { dir: string; label: string; harness: HarnessName };

/** Who runs what on one install, in the rail's order. */
export function harnessUsers(install: LocalInstall, event: LocalReportEvent | null): HarnessUser[] {
  if (event === null) return [];
  if (install.workspace === undefined) {
    const harness = providerOf(event.directory.configFields);
    return harness === null ? [] : [{ dir: install.dir, label: install.name, harness }];
  }
  return (event.directory.tenants ?? []).flatMap((tenant) => {
    const harness = providerOf(tenant.configFields);
    return harness === null
      ? []
      : [{ dir: tenant.dir, label: tenant.slug ?? tenant.name, harness }];
  });
}

/** What the install's Dockerfile says about one harness, or null when nothing was read. */
export function harnessPin(
  event: LocalReportEvent | null,
  harness: HarnessName,
): HarnessPin | null {
  return event?.directory.harnessPins?.find((row) => row.harness === harness)?.pin ?? null;
}

/** One harness as a row: main's facts, and the configs that run it. */
export type HarnessRow = HarnessFacts & { label: string; usedBy: string[] };

/**
 * The rows a page draws. From the last check when there is one, else from the
 * pins that came with the install's read, which is enough to list them before
 * anything has been asked. A harness nobody runs and nothing installs is left
 * out, and `only` narrows the list to one tenant's.
 */
export function harnessRows(
  report: HarnessReport | null,
  event: LocalReportEvent | null,
  users: readonly HarnessUser[],
  only: HarnessName | null = null,
): HarnessRow[] {
  const facts: HarnessFacts[] =
    report !== null && report.dockerfile !== null
      ? report.harnesses
      : (event?.directory.harnessPins ?? []).map(({ harness, pin }) => ({
          harness,
          pin,
          running: null,
          latest: report?.harnesses.find((row) => row.harness === harness)?.latest ?? null,
          behind: null,
        }));
  return HARNESS_ORDER.flatMap((harness) => {
    const row = facts.find((candidate) => candidate.harness === harness);
    if (row === undefined) return [];
    const usedBy = users.filter((user) => user.harness === harness).map((user) => user.label);
    if (only !== null ? harness !== only : row.pin.kind === "absent" && usedBy.length === 0) {
      return [];
    }
    return [{ ...row, label: HARNESS_LABEL[harness], usedBy }];
  });
}

/** What the Dockerfile says, in a few words. */
export function pinReading(pin: HarnessPin): string {
  switch (pin.kind) {
    case "pinned":
      return `pinned to ${pin.version}`;
    case "unpinned":
      return "not pinned";
    case "absent":
      return "not installed";
  }
}

/**
 * The line under a harness's name: the pin, what the container has, the latest.
 * A clause is left out when there is nothing to say it by, rather than filled
 * with a dash.
 */
export function harnessReading(
  row: Pick<HarnessFacts, "pin" | "running" | "latest">,
  containerAsked: boolean,
): string {
  const parts = [pinReading(row.pin)];
  if (row.running !== null) parts.push(`the container has ${row.running}`);
  else if (containerAsked && row.pin.kind !== "absent") {
    parts.push("the container does not have it");
  }
  if (row.latest !== null) parts.push(`latest ${row.latest}`);
  return parts.join(" · ");
}

/** The one word beside a harness's name, and its tone. Null when there is nothing to flag. */
export function harnessStanding(
  row: HarnessRow,
): { text: string; tone: "ok" | "warn" | "fail" } | null {
  if (row.pin.kind === "absent") {
    return row.usedBy.length > 0 ? { text: "missing", tone: "fail" } : null;
  }
  // A pin the container has not caught up with outranks how the pin compares:
  // "current" beside a container on an older one would be the wrong word.
  if (needsRebuild(row)) return { text: "needs rebuild", tone: "warn" };
  if (row.behind === true) return { text: "behind", tone: "warn" };
  if (row.behind === false) return { text: "current", tone: "ok" };
  return null;
}

/** What the button that moves a pin is called. */
export function updateVerb(pin: HarnessPin): "Update" | "Pin" | "Install" {
  return pin.kind === "pinned" ? "Update" : pin.kind === "unpinned" ? "Pin" : "Install";
}

/**
 * Whether the container has a different version than the Dockerfile pins: the
 * state a moved pin leaves behind until the image is rebuilt.
 */
export function awaitingRebuild(rows: readonly HarnessRow[]): HarnessRow[] {
  return rows.filter(needsRebuild);
}

/** The same, for one set of facts: a harness's, or the launcher's. */
export function needsRebuild(facts: Pick<HarnessFacts, "pin" | "running">): boolean {
  return (
    facts.pin.kind === "pinned" && facts.running !== null && facts.running !== facts.pin.version
  );
}

// ── Phoebe's own versions: the launcher in the image, the engine in the config ──

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Whether a launcher version is one `upgrade` can name: `X.Y.Z`, with or without the `v`. */
export function launcherVersionOf(typed: string): string | null {
  const bare = typed.trim().replace(/^v/, "");
  return /^\d+\.\d+\.\d+$/.test(bare) ? bare : null;
}

/** What the config says the engine is. */
export type EngineReading =
  | { source: "local" }
  | {
      source: "github";
      ref: string;
      /** A release tag, as opposed to a branch or a commit the engine follows. */
      release: boolean;
      /** The newest release tag, when the launcher's latest has been looked up. */
      latest: string | null;
      behind: boolean | null;
    };

/** Phoebe's two versions on one install. */
export type PhoebeVersions = {
  /** The launcher in the container, or null when the image installs none. */
  launcher: LauncherFacts | null;
  /** Null when the config cannot be read, or computes its engine. */
  engine: EngineReading | null;
};

/** A field's literal: what the file sets, or the default it leaves standing. */
function literalOf(fields: readonly ConfigFieldFacts[] | undefined, path: string): unknown {
  const field = fields?.find((candidate) => candidate.path === path);
  if (field === undefined) return undefined;
  return field.state === "set" ? field.value : field.state === "unset" ? field.default : undefined;
}

/**
 * The launcher and the engine, off the last check and the install's read. The
 * launcher's pin is on the install before any check has answered. The engine's
 * newest release is the launcher's newest version with a `v`: a release is one
 * number for both (docs/releasing.md), so one look-up answers for the two.
 */
export function phoebeVersions(
  install: LocalInstall,
  event: LocalReportEvent | null,
  report: HarnessReport | null,
): PhoebeVersions {
  const checked = report !== null && report.dockerfile !== null ? report.launcher : null;
  const launcher: LauncherFacts | null =
    checked !== null
      ? checked.pin.kind === "absent"
        ? null
        : checked
      : install.containerVersion === null
        ? null
        : {
            pin: { kind: "pinned", version: install.containerVersion },
            running: null,
            latest: report?.launcher.latest ?? null,
            behind: null,
          };

  const fields = event?.directory.configFields;
  const source = literalOf(fields, "engine.source");
  const ref = literalOf(fields, "engine.ref");
  let engine: EngineReading | null = null;
  if (source === "local") engine = { source: "local" };
  else if (source === "github" && typeof ref === "string") {
    const newest = report?.launcher.latest ?? null;
    const latest = newest === null ? null : `v${newest}`;
    const mine = RELEASE_TAG.exec(ref);
    const theirs = latest === null ? null : RELEASE_TAG.exec(latest);
    let behind: boolean | null = null;
    if (mine !== null && theirs !== null) {
      behind = false;
      for (let index = 1; index <= 3; index += 1) {
        if (Number(mine[index]) !== Number(theirs[index])) {
          behind = Number(mine[index]) < Number(theirs[index]);
          break;
        }
      }
    }
    engine = { source: "github", ref, release: mine !== null, latest, behind };
  }
  return { launcher, engine };
}

/** The word beside the launcher's name. */
export function launcherStanding(
  launcher: LauncherFacts,
): { text: string; tone: "ok" | "warn" | "fail" } | null {
  if (needsRebuild(launcher)) return { text: "needs rebuild", tone: "warn" };
  if (launcher.behind === true) return { text: "behind", tone: "warn" };
  if (launcher.behind === false) return { text: "current", tone: "ok" };
  return null;
}

/** The line under the engine's name. */
export function engineReading(engine: EngineReading): string {
  if (engine.source === "local") return "runs from a folder mounted into the container";
  if (!engine.release) return `ref ${engine.ref} · follows that ref as it moves`;
  return engine.latest === null
    ? `ref ${engine.ref}`
    : `ref ${engine.ref} · latest ${engine.latest}`;
}

/** The word beside the engine's name. */
export function engineStanding(
  engine: EngineReading,
): { text: string; tone: "ok" | "warn" | "fail" } | null {
  if (engine.source === "local" || engine.behind === null) return null;
  return engine.behind ? { text: "behind", tone: "warn" } : { text: "current", tone: "ok" };
}

/**
 * What an `upgrade` run came to, one sentence per half it touched. Null for a
 * check, which moves nothing and has its own line on the tab.
 */
export function upgradeReading(
  outcome: UpgradeOutcome,
): { text: string; ok: boolean; rebuild: boolean } | null {
  if (outcome.kind !== "upgraded") return null;
  const parts: string[] = [];
  const { engine, cli } = outcome;
  if (engine !== null) {
    parts.push(
      engine.kind === "moved"
        ? `The engine ref is now ${engine.to}${engine.from === null ? "" : ` (was ${engine.from})`}.`
        : engine.kind === "unchanged"
          ? "The engine is already on that ref."
          : engine.kind === "refused"
            ? `The engine was not moved: its ${engine.stage} step was refused. The console's cli tab says why.`
            : "The engine was left alone.",
    );
  }
  if (cli !== null) {
    parts.push(
      cli.kind === "moved"
        ? `The Dockerfile now pins the launcher at ${cli.to}${cli.from === null ? "" : ` (was ${cli.from})`}. Rebuild to put it in the container.`
        : cli.kind === "unchanged"
          ? cli.reason === "nothing-pinned"
            ? "The Dockerfile pins no launcher version, so there was nothing to move."
            : "The launcher is already at that version."
          : cli.kind === "refused"
            ? "The launcher was not moved: the Dockerfile's pin could not be rewritten. The console's cli tab says why."
            : "The launcher was left alone, because the engine was refused.",
    );
  }
  return { text: parts.join(" "), ok: outcome.ok, rebuild: cli?.kind === "moved" };
}

/** What an update came to, as a sentence. */
export function updateReading(outcome: HarnessUpdateOutcome): string {
  const label = HARNESS_LABEL[outcome.harness];
  switch (outcome.kind) {
    case "moved":
      return (
        `The Dockerfile now pins ${label} ${outcome.to}` +
        (outcome.from === null ? "" : ` (was ${outcome.from})`) +
        "."
      );
    case "unchanged":
      return `${label} is already pinned to ${outcome.version}.`;
    case "refused":
      return (
        `${label} was not moved: ${outcome.why}.` +
        (outcome.instruction === null ? "" : ` ${outcome.instruction}`)
      );
  }
}

/** What putting a harness into the running container came to, as a sentence. */
export function applyReading(outcome: HarnessApplyOutcome): string {
  return outcome.kind === "applied"
    ? `The running container has ${HARNESS_LABEL[outcome.harness]} ${outcome.version} too. ` +
        "A unit in flight finishes on the version it started with, and the next one starts on this."
    : `${HARNESS_LABEL[outcome.harness]} was not put into the running container: ${outcome.why}. ` +
        "A rebuild installs it.";
}

// ── updates on offer: what the automatic check found behind ───────────────

/** One thing an install could move to. */
export type AvailableUpdate =
  | { kind: "harness"; harness: HarnessName; label: string; from: string | null; to: string }
  | { kind: "launcher"; from: string | null; to: string }
  | { kind: "engine"; from: string | null; to: string };

/**
 * What is behind on one install, by its last report: each installed harness the
 * newest version has passed, and Phoebe's own launcher and engine where they
 * are pinned to a release. Nothing before a look-up, since "behind" needs a
 * newest to be behind.
 */
export function availableUpdates(
  install: LocalInstall,
  event: LocalReportEvent | null,
  report: HarnessReport | null,
): AvailableUpdate[] {
  if (report === null || report.dockerfile === null) return [];
  const updates: AvailableUpdate[] = [];
  for (const row of harnessRows(report, event, harnessUsers(install, event))) {
    if (row.pin.kind !== "absent" && row.behind === true && row.latest !== null) {
      updates.push({
        kind: "harness",
        harness: row.harness,
        label: row.label,
        // What it is on now: the pin, or what the container has when nothing is pinned.
        from: row.pin.kind === "pinned" ? row.pin.version : row.running,
        to: row.latest,
      });
    }
  }
  const { launcher, engine } = phoebeVersions(install, event, report);
  if (launcher !== null && launcher.pin.kind === "pinned" && launcher.behind === true) {
    if (launcher.latest !== null) {
      updates.push({ kind: "launcher", from: launcher.pin.version, to: launcher.latest });
    }
  }
  if (engine !== null && engine.source === "github" && engine.behind === true) {
    if (engine.latest !== null) {
      updates.push({ kind: "engine", from: engine.ref, to: engine.latest });
    }
  }
  return updates;
}

/** One update, named: `Claude Code 2.1.288`. */
function updateName(update: AvailableUpdate): string {
  return update.kind === "harness"
    ? `${update.label} ${update.to}`
    : update.kind === "launcher"
      ? `the Phoebe launcher ${update.to}`
      : `the Phoebe engine ${update.to}`;
}

/** One update as a move: `Claude Code 2.1.269 → 2.1.288`. */
export function updateArrow(update: AvailableUpdate): string {
  const name =
    update.kind === "harness"
      ? update.label
      : update.kind === "launcher"
        ? "Phoebe launcher"
        : "Phoebe engine";
  return update.from === null ? `${name} ${update.to}` : `${name} ${update.from} → ${update.to}`;
}

/** Several things as a phrase: `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Everything on offer, as the object of "can move to". */
export function updatesReading(updates: readonly AvailableUpdate[]): string {
  return listed(updates.map(updateName));
}

/** What is on offer, as a string to compare: dismissing one set does not dismiss the next. */
export function updatesSignature(updates: readonly AvailableUpdate[]): string {
  return updates
    .map((update) => `${update.kind === "harness" ? update.harness : update.kind}@${update.to}`)
    .join(",");
}

/** What became of one harness update taken from the alert. */
export type TakenUpdate = {
  label: string;
  to: string;
  /** Why it did not go all the way, or null when it did. */
  why: string | null;
  /** Whether a running container has it now. */
  applied: boolean;
};

/** What pressing Update came to, as a sentence or two. */
export function takenReading(results: readonly TakenUpdate[], running: boolean): string {
  const went = results.filter((result) => result.why === null);
  const failed = results.filter((result) => result.why !== null);
  const parts: string[] = [];
  if (went.length > 0) {
    parts.push(
      `${listed(went.map((result) => `${result.label} ${result.to}`))} ${went.length === 1 ? "is" : "are"} pinned in the Dockerfile` +
        (running
          ? " and in the running container. A unit in flight finishes on the version it started with, and the next one starts on the new."
          : ". The next build of the image installs " + (went.length === 1 ? "it." : "them.")),
    );
  }
  for (const result of failed) parts.push(`${result.label}: ${result.why}.`);
  return parts.join(" ");
}

// ── a container that runs as root ─────────────────────────────────────────

/**
 * What it means that an install's container runs as root, or null when it does
 * not, or nothing could be asked.
 *
 * Claude Code refuses `--dangerously-skip-permissions` under uid 0, and the
 * engine always passes it, so a root container fails every unit on that
 * provider. It gets there by being started from an image built before the
 * Dockerfile dropped privileges: `start` does not rebuild an image that is
 * already there, however old. So this is an error where a config runs claude
 * and a warning where none does, and the remedy is a rebuild when the
 * Dockerfile would produce something else.
 */
export function rootReading(
  install: LocalInstall,
  event: LocalReportEvent | null,
  report: HarnessReport | null,
): { level: "error" | "warning"; text: string; rebuild: boolean } | null {
  if (report === null || report.user.root !== true) return null;
  const claude = harnessUsers(install, event).some((user) => user.harness === "claude");
  const consequence = claude
    ? "Claude Code refuses to run as root, so every unit on the claude provider fails."
    : "Claude Code refuses to run as root, so no unit could run on that provider.";
  return {
    level: claude ? "error" : "warning",
    text: report.user.dockerfileDrops
      ? `${consequence} Its image was built before container/Dockerfile dropped to an unprivileged user, and a start does not rebuild an image that is already there. Rebuild it.`
      : `${consequence} Its Dockerfile has no USER line, so a rebuild will not change that: compare it with a freshly scaffolded container/Dockerfile.`,
    rebuild: report.user.dockerfileDrops,
  };
}

/** The same, as the one line a rail badge and the console's header carry. */
export function rootProblem(
  install: LocalInstall,
  event: LocalReportEvent | null,
  report: HarnessReport | null,
): RailProblem[] {
  const reading = rootReading(install, event, report);
  if (reading === null) return [];
  return [
    {
      level: reading.level,
      text: reading.rebuild
        ? "its container runs as root, which Claude Code refuses: its image predates its Dockerfile, so rebuild"
        : "its container runs as root, which Claude Code refuses: its Dockerfile has no USER line",
    },
  ];
}
