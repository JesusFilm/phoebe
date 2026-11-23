// The body of a dependency-security issue (ADR 0003). A routed issue is a
// table of fixes the `dependencies` kind applies; a tracking issue is the same
// package with no fix to apply yet. Both say how each occurrence is reached,
// because a transitive package is in no manifest and is fixed another way.
// Rendered from the bundle alone, reading no clock, so the same bundle always
// renders the same bytes.
//
// The transitive bundle (ADR 0005) has a body of its own: one row per package
// and version, whatever the workspaces, and the instruction to make lockfile
// fixes only.

import { byText, compareCandidates, type Candidate } from "../dependencies/candidate.ts";
import { bundleKey, fingerprint, renderMarker } from "../dependencies/fingerprint.ts";
import type { Bundle } from "../dependencies/grouping.ts";
import {
  cell,
  code,
  plain,
  renderAdvisories,
  renderCodeList,
  STAYS_CELL,
} from "../dependencies/issue-body.ts";
import type { MinSeverity } from "../dependencies/policy.ts";

export type SecurityBodyOptions = {
  /** Whether a fix exists, so the issue routes to the `dependencies` kind. */
  routed: boolean;
  minSeverity: MinSeverity;
  /** The routing label a tracking issue gains once a fix ships. */
  routingLabel: string;
  /**
   * The PR or issue whose implementer dropped a row of this package from the
   * transitive bundle, when one did: the row needs a manifest fix.
   */
  droppedFrom?: number;
};

/** Whether a candidate is a fix to apply, as opposed to an occurrence still waiting on one. */
export function hasFix(candidate: Candidate): boolean {
  return candidate.target !== candidate.current;
}

/** Whether a body is a tracking issue's: written while no fix was released. */
export function isTrackingBody(body: string): boolean {
  return body.startsWith("Tracking ");
}

/** One table row from its cells, the package and workspace first as the other bodies have them. */
function row(c: Candidate, ...rest: string[]): string {
  return ["", cell(code(c.package)), cell(code(c.workspace)), c.depType, ...rest, ""]
    .join(" | ")
    .trim();
}

function reachedThrough(candidate: Candidate): string {
  if (candidate.via === undefined) return "not known";
  if (candidate.via.length === 0) return "direct";
  return `transitive, through ${candidate.via.map(code).join(", ")}`;
}

/**
 * The threshold as a body names it: the one severity when both sides share
 * it, and each side's when a development dependency answers to another.
 */
function thresholdPhrase(minSeverity: MinSeverity): string {
  return minSeverity.prod === minSeverity.dev
    ? code(minSeverity.prod)
    : `the threshold for its dependency type (${code(minSeverity.prod)} for production, ` +
        `${code(minSeverity.dev)} for development)`;
}

/** The title, the same for a tracking issue and the routed issue it becomes. */
export function renderSecurityTitle(bundle: Bundle): string {
  const name = bundle.candidates[0]!.package.replace(/[\r\n]+/g, " ");
  return `Security advisories in ${name} (${bundle.manager})`;
}

/** The issue body for one package's advisories, ending in the marker the next pass reads back. */
export function renderSecurityBody(bundle: Bundle, options: SecurityBodyOptions): string {
  const candidates = [...bundle.candidates].sort(compareCandidates);
  const pkg = code(candidates[0]!.package);
  const manager = code(bundle.manager);
  const severity = thresholdPhrase(options.minSeverity);
  const lines: string[] = [];

  if (options.routed) {
    if (options.droppedFrom !== undefined) {
      lines.push(`Dropped from #${options.droppedFrom}; it needs more than a lockfile fix.`, "");
    }
    lines.push(
      `Security fix for ${pkg} under ${manager}. A fix is released for its advisories at or ` +
        `above ${severity}, though it may not cover every one. Move each row to the version in its ` +
        "To column.",
      "",
      "| Package | Workspace | Type | From | To | Reached through |",
      "| --- | --- | --- | --- | --- | --- |",
      ...candidates.map((c) =>
        row(
          c,
          cell(plain(c.current)),
          hasFix(c) ? cell(plain(c.target)) : STAYS_CELL,
          cell(reachedThrough(c)),
        ),
      ),
    );
    if (candidates.some((c) => hasFix(c) && c.via === undefined)) {
      lines.push(
        "",
        "A row marked not known has no recorded route to the package. Check the manifests and the " +
          "lockfile to see whether it is declared directly or pulled in by another dependency " +
          "before choosing how to move it.",
      );
    }
    if (candidates.some((c) => hasFix(c) && c.via !== undefined && c.via.length > 0)) {
      lines.push(
        "",
        "A transitive row names a package no manifest declares. Fix it with a bump of " +
          "the dependency that pulls it in, to a release that brings the fixed version. When no " +
          "such release exists, pin it to the fixed version with the package manager's override " +
          "instead, which is `pnpm.overrides`, npm `overrides`, yarn `resolutions`, a Cargo " +
          "`[patch]` or a pip constraint.",
      );
    }
  } else {
    lines.push(
      `Tracking ${pkg} under ${manager}. Its advisories at or above ${severity} have no fixed ` +
        "version released yet. Phoebe checks again every pass. Once a fix ships it rewrites this issue to " +
        `propose it and adds the ${code(options.routingLabel)} label, which hands it to the ` +
        "`dependencies` kind.",
      "",
      "| Package | Workspace | Type | Version | Reached through |",
      "| --- | --- | --- | --- | --- |",
      ...candidates.map((c) => row(c, cell(plain(c.current)), cell(reachedThrough(c)))),
    );
  }

  lines.push("", ...renderAdvisories(candidates));
  lines.push("", renderMarker({ key: bundleKey(bundle), fingerprint: fingerprint(bundle) }), "");
  return lines.join("\n");
}

/** The transitive bundle's title, the same whatever rows it holds. */
export function renderTransitiveTitle(bundle: Bundle): string {
  return `Security fixes for transitive packages (${bundle.manager})`;
}

/** One table row of the transitive bundle: a package at one version moving to one fix. */
export type TransitiveRow = { package: string; current: string; target: string };

/** The rows the transitive bundle's table has, in the order it lists them. */
export function transitiveRows(candidates: readonly Candidate[]): TransitiveRow[] {
  const rows = new Map<string, TransitiveRow>();
  for (const c of [...candidates].sort(compareCandidates)) {
    const key = JSON.stringify([c.package, c.current, c.target]);
    if (!rows.has(key)) rows.set(key, { package: c.package, current: c.current, target: c.target });
  }
  return [...rows.values()];
}

/**
 * The body of the transitive bundle: every transitive package of one manager
 * with a fix released. One table row stands for a package at one version in
 * every workspace that has it, and `readIssueRows` reads it back as a row per
 * workspace. The implementer makes lockfile fixes only; a row that needs more
 * comes back as a per-package issue.
 */
export function renderTransitiveBody(
  bundle: Bundle,
  options: Pick<SecurityBodyOptions, "minSeverity">,
): string {
  const candidates = [...bundle.candidates].sort(compareCandidates);
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort(byText);
  const lines: string[] = [
    `Security fixes for transitive packages under ${code(bundle.manager)}. No manifest declares ` +
      "these packages, and each has a fix released for its advisories at or above " +
      `${thresholdPhrase(options.minSeverity)}.`,
    "",
    "Make lockfile fixes only. For each row, run the package manager's own update for that " +
      "package and check that the lockfile now resolves the version in its To column or a " +
      "newer one. Do not edit a manifest and do not add an override. A row the lockfile cannot " +
      "bring that far is dropped with the `(needs override)` tag, and Phoebe files it again on " +
      "its own.",
    "",
    "| Package | Workspace | Type | From | To | Reached through |",
    "| --- | --- | --- | --- | --- | --- |",
    ...transitiveRows(candidates).map((row) => {
      const occurrences = candidates.filter(
        (c) => c.package === row.package && c.current === row.current && c.target === row.target,
      );
      return [
        "",
        cell(code(row.package)),
        cell(renderCodeList(sorted(occurrences.map((c) => c.workspace)))),
        sorted(occurrences.map((c) => c.depType)).join(", "),
        cell(plain(row.current)),
        cell(plain(row.target)),
        cell(renderCodeList(sorted(occurrences.flatMap((c) => c.via ?? [])))),
        "",
      ]
        .join(" | ")
        .trim();
    }),
    "",
    ...renderAdvisories(candidates),
    "",
    renderMarker({ key: bundleKey(bundle), fingerprint: fingerprint(bundle) }),
    "",
  ];
  return lines.join("\n");
}

/**
 * What the transitive bundle's issue says once every row it listed has moved
 * to an issue of its own. It lists no rows, so closing it vetoes none of them.
 */
export function renderEmptiedTransitiveBody(manager: string, group: string): string {
  const bundle: Bundle = { manager, group, candidates: [] };
  return [
    `Security fixes for transitive packages under ${code(manager)}. Every row this issue listed ` +
      "needed more than a lockfile fix, so Phoebe filed each on its own.",
    "",
    renderMarker({ key: bundleKey(bundle), fingerprint: fingerprint(bundle) }),
    "",
  ].join("\n");
}
