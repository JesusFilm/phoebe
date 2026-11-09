// The body of the issue a bundle files (ADR 0003). Rendered from the bundle
// and the policy alone, reading no clock, so the same bundle always renders
// the same bytes.

import { byText, compareCandidates, repositoryWebUrl, type Candidate } from "./candidate.ts";
import { bundleKey, fingerprint, renderMarker } from "./fingerprint.ts";
import type { Bundle } from "./grouping.ts";
import { MATURITY_DEFAULTS, selectionReason, type MaturityPolicy } from "./policy.ts";

// Every value below except the policy's own words comes from a package
// source: a registry, deps.dev, OSV, Renovate or the agent fallback. The body
// is what the implementer agent reads, so nothing a source supplied may turn
// into markup, least of all an HTML comment, which GitHub hides from the
// person looking at the issue and still hands to the agent.

/** One line of source-supplied text: no line break, and no `<`, `>` or `&` left to start markup. */
export function plain(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Source-supplied text as a code span. The fence is one backtick longer than
 * the longest run inside, so a backtick in a name cannot close the span early,
 * and inside a span `<` is text, not markup.
 */
export function code(text: string): string {
  const inner = text.replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...(inner.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = inner.startsWith("`") || inner.endsWith("`") ? " " : "";
  return `${fence}${pad}${inner}${pad}${fence}`;
}

/** A table cell: a pipe would end the cell early. */
export function cell(text: string): string {
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

/**
 * The issue title for one bundle: the package and its version when the bundle
 * moves one package to one version, else a count. A title is plain text, so
 * only line breaks need removing.
 */
export function renderIssueTitle(bundle: Bundle): string {
  const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");
  const packages = [...new Set(bundle.candidates.map((c) => c.package))];
  const targets = [...new Set(bundle.candidates.map((c) => c.target))];
  if (packages.length === 1) {
    const name = oneLine(packages[0]!);
    return targets.length === 1 ? `Update ${name} to ${oneLine(targets[0]!)}` : `Update ${name}`;
  }
  return oneLine(`Update ${packages.length} ${bundle.manager} dependencies (${bundle.group})`);
}

/**
 * The `## Advisories` section: one line per advisory and package, linked to
 * OSV, sorted by id. Empty when no candidate carries one.
 */
export function renderAdvisories(candidates: readonly Candidate[]): string[] {
  const advisories = new Map<string, string>();
  for (const c of candidates) {
    for (const a of c.advisories) {
      const fix = a.fixedIn === null ? "no fix released" : `fixed in ${plain(a.fixedIn)}`;
      const id = plain(a.id).replace(/[[\]]/g, "\\$&");
      advisories.set(
        JSON.stringify([a.id, c.package]),
        `- [${id}](${advisoryUrl(a.id)}): ${plain(a.severity)}, in ${code(c.package)}, ${fix}`,
      );
    }
  }
  if (advisories.size === 0) return [];
  return [
    "## Advisories",
    "",
    ...[...advisories].sort(([a], [b]) => byText(a, b)).map(([, line]) => line),
  ];
}

/** The issue body for one bundle, ending in the marker the next cycle reads back. */
export function renderIssueBody(
  bundle: Bundle,
  policy: MaturityPolicy = MATURITY_DEFAULTS,
): string {
  const candidates = [...bundle.candidates].sort(compareCandidates);
  const lines: string[] = [
    `Dependency updates for ${code(bundle.manager)}, bundle ${code(bundle.group)}.`,
    "",
    "| Package | Workspace | Type | From | To | Update | Published | Selected because |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...candidates.map((c) =>
      [
        "",
        cell(code(c.package)),
        cell(code(c.workspace)),
        c.depType,
        cell(plain(c.current)),
        cell(plain(c.target)),
        c.updateType,
        cell(published(c)),
        cell(plain(selectionReason(c, policy))),
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
    lines.push(`- ${code(pkg)}: ${url ?? "no source repository known"}`);
  }

  const advisories = renderAdvisories(candidates);
  if (advisories.length > 0) lines.push("", ...advisories);

  lines.push("", renderMarker({ key: bundleKey(bundle), fingerprint: fingerprint(bundle) }), "");
  return lines.join("\n");
}
