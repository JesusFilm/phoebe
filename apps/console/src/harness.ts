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
  LocalInstall,
  LocalReportEvent,
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
export function harnessReading(row: HarnessRow, containerAsked: boolean): string {
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
  if (awaitingRebuild([row]).length > 0) return { text: "needs rebuild", tone: "warn" };
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
  return rows.filter(
    (row) => row.pin.kind === "pinned" && row.running !== null && row.running !== row.pin.version,
  );
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
