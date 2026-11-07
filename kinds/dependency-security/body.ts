// The body of a dependency-security issue (ADR 0003). A routed issue is a
// table of fixes the `dependencies` kind applies; a tracking issue is the same
// package with no fix to apply yet. Both say how each occurrence is reached,
// because a transitive package is in no manifest and is fixed another way.
// Rendered from the bundle alone, reading no clock, so the same bundle always
// renders the same bytes.

import { compareCandidates, type Candidate, type Severity } from "../dependencies/candidate.ts";
import { bundleKey, fingerprint, renderMarker } from "../dependencies/fingerprint.ts";
import type { Bundle } from "../dependencies/grouping.ts";
import { cell, code, plain, renderAdvisories } from "../dependencies/issue-body.ts";

export type SecurityBodyOptions = {
  /** Whether a fix exists, so the issue routes to the `dependencies` kind. */
  routed: boolean;
  minSeverity: Severity;
  /** The routing label a tracking issue gains once a fix ships. */
  routingLabel: string;
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
  const severity = code(options.minSeverity);
  const lines: string[] = [];

  if (options.routed) {
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
          hasFix(c) ? cell(plain(c.target)) : "no fix released; leave it",
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
