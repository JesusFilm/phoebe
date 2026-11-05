// The body of the issue a bundle files (ADR 0003). Rendered from the bundle
// and the policy alone, reading no clock, so the same bundle always renders
// the same bytes.

import { byText, compareCandidates, repositoryWebUrl, type Candidate } from "./candidate.ts";
import { bundleKey, fingerprint, renderMarker } from "./fingerprint.ts";
import type { Bundle } from "./grouping.ts";
import { MATURITY_DEFAULTS, selectionReason, type MaturityPolicy } from "./policy.ts";

/** A table cell: a pipe would end the cell early. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function published(candidate: Candidate): string {
  const ms = Date.parse(candidate.publishedAt ?? "");
  return Number.isNaN(ms) ? "publish date unknown" : new Date(ms).toISOString().slice(0, 10);
}

/** Where to read what changed: a GitHub repository's releases, else the repository itself. */
function changelogUrl(candidate: Candidate): string | null {
  if (candidate.repositoryUrl === undefined) return null;
  const web = repositoryWebUrl(candidate.repositoryUrl);
  if (web === null) return null;
  return web.startsWith("https://github.com/") ? `${web}/releases` : web;
}

/** OSV resolves every id an advisory source hands back — GHSA, CVE, RUSTSEC, PYSEC. */
function advisoryUrl(id: string): string {
  return `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
}

/** The issue body for one bundle, ending in the marker the next cycle reads back. */
export function renderIssueBody(
  bundle: Bundle,
  policy: MaturityPolicy = MATURITY_DEFAULTS,
): string {
  const candidates = [...bundle.candidates].sort(compareCandidates);
  const lines: string[] = [
    `Dependency updates for \`${bundle.manager}\`, bundle \`${bundle.group}\`.`,
    "",
    "| Package | Workspace | Type | From | To | Update | Published | Selected because |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...candidates.map((c) =>
      [
        "",
        `\`${cell(c.package)}\``,
        `\`${cell(c.workspace)}\``,
        c.depType,
        cell(c.current),
        cell(c.target),
        c.updateType,
        cell(published(c)),
        cell(selectionReason(c, policy)),
        "",
      ]
        .join(" | ")
        .trim(),
    ),
  ];

  const changelogs = new Map<string, string | null>();
  for (const c of candidates) {
    if (!changelogs.has(c.package) || changelogs.get(c.package) === null) {
      changelogs.set(c.package, changelogUrl(c));
    }
  }
  lines.push("", "## Changelogs", "");
  for (const [pkg, url] of changelogs) {
    lines.push(`- \`${pkg}\`: ${url ?? "no source repository known"}`);
  }

  const advisories = new Map<string, string>();
  for (const c of candidates) {
    for (const a of c.advisories) {
      const fix = a.fixedIn === null ? "no fix released" : `fixed in ${a.fixedIn}`;
      advisories.set(
        JSON.stringify([a.id, c.package]),
        `- [${a.id}](${advisoryUrl(a.id)}): ${a.severity}, in \`${c.package}\`, ${fix}`,
      );
    }
  }
  if (advisories.size > 0) {
    lines.push("", "## Advisories", "");
    lines.push(...[...advisories].sort(([a], [b]) => byText(a, b)).map(([, line]) => line));
  }

  lines.push("", renderMarker({ key: bundleKey(bundle), fingerprint: fingerprint(bundle) }), "");
  return lines.join("\n");
}
