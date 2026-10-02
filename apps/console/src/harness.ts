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
            ? `The engine was not moved: its ${engine.stage} step was refused. The output below says why.`
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
            ? "The launcher was not moved: the Dockerfile's pin could not be rewritten. The output below says why."
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
        ". The container keeps the one it was built with until the image is rebuilt."
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
