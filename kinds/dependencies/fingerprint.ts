// The dependency watermark (ADR 0003), shaped like the Sentry kind's. GitHub
// is the record: every issue a dependency kind files carries an HTML marker
// naming its bundle and the fingerprint of what the bundle proposes. The
// filing step reads them back to decide: same fingerprint, leave the issue;
// new fingerprint, update it. A closed issue's veto is read from its rows,
// not its fingerprint (filing.ts). This module only renders and reads them.

import { createHash } from "node:crypto";
import { byText } from "./candidate.ts";
import type { Bundle } from "./grouping.ts";

/** The word the cycle's one GitHub search looks for. */
export const MARKER_TEXT = "phoebe-dependencies";

const MARKER_RE = /<!--\s*phoebe-dependencies\s+bundle=(\S+)\s+fingerprint=([0-9a-f]+)\s*-->/g;

/** What stays put across cycles: the manager and the group, never a version. */
export function bundleKey(bundle: Pick<Bundle, "manager" | "group">): string {
  return `${bundle.manager}:${bundle.group}`;
}

/**
 * The first 12 hex characters of a sha256 over the bundle's sorted
 * package-version pairs and its sorted advisory ids. A newer version moves
 * it, and so does a new advisory on an unchanged version.
 */
export function fingerprint(bundle: Pick<Bundle, "candidates">): string {
  const pairs = new Set(bundle.candidates.map((c) => `${c.package}@${c.target}`));
  const advisories = new Set(bundle.candidates.flatMap((c) => c.advisories.map((a) => a.id)));
  const payload = JSON.stringify([[...pairs].sort(byText), [...advisories].sort(byText)]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

export type Marker = { key: string; fingerprint: string };

/**
 * The marker a filed issue carries:
 * `<!-- phoebe-dependencies bundle=<key> fingerprint=<hex> -->`. The key is
 * URI-encoded, so a workspace path with a space cannot break the comment.
 */
export function renderMarker(marker: Marker): string {
  return `<!-- ${MARKER_TEXT} bundle=${encodeURIComponent(marker.key)} fingerprint=${marker.fingerprint} -->`;
}

/**
 * The bundle key and fingerprint an issue body names, or null when it carries
 * no marker. The last marker wins: the renderer writes it after everything a
 * package source supplied, so a marker planted earlier in the body, in a
 * changelog URL say, never decides which bundle an issue is.
 */
export function parseMarker(body: string): Marker | null {
  const match = [...body.matchAll(MARKER_RE)].at(-1);
  if (match === undefined) return null;
  try {
    return { key: decodeURIComponent(match[1]!), fingerprint: match[2]! };
  } catch {
    return null;
  }
}
