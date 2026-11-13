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

/** The To cell of a security row whose package has no fix to move to: the row stays at From. */
export const STAYS_CELL = "no fix released; leave it";

/** One row a filed issue lists, read back from its body. */
export type FiledRow = {
  package: string;
  workspace: string;
  target: string;
  /** The advisory ids the issue listed against the row's package. */
  advisories: readonly string[];
};

/** A table line's cells, split on the pipes `cell` left unescaped. */
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replaceAll("\\|", "|"));
}

/** The text inside a code span `code` rendered, or null when `text` is not one. */
function uncode(text: string): string | null {
  const match = /^(`+)(.*)\1$/s.exec(text);
  if (match === null) return null;
  const inner = match[2]!;
  const padded =
    inner.length >= 2 &&
    inner.startsWith(" ") &&
    inner.endsWith(" ") &&
    (inner[1] === "`" || inner.at(-2) === "`");
  return padded ? inner.slice(1, -1) : inner;
}

/** The code span `text` opens with, unwrapped, or null. */
function leadingCode(text: string): string | null {
  const fence = /^`+/.exec(text)?.[0];
  if (fence === undefined) return null;
  const close = new RegExp(`(?<!\`)${fence}(?!\`)`, "g");
  close.lastIndex = fence.length;
  const match = close.exec(text);
  return match === null ? null : uncode(text.slice(0, match.index + fence.length));
}

function unplain(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

const ADVISORY_LINE_RE = /^- \[.*\]\(https:\/\/osv\.dev\/vulnerability\/(\S+?)\): [a-z]+, in (.+)$/;

/** Advisory ids by package, from the `## Advisories` lines `renderAdvisories` wrote. */
function advisoriesByPackage(lines: readonly string[]): Map<string, Set<string>> {
  const byPackage = new Map<string, Set<string>>();
  for (const line of lines) {
    const match = ADVISORY_LINE_RE.exec(line);
    if (match === null) continue;
    const pkg = leadingCode(match[2]!);
    if (pkg === null) continue;
    let id: string;
    try {
      id = decodeURIComponent(match[1]!);
    } catch {
      continue;
    }
    const ids = byPackage.get(pkg) ?? new Set<string>();
    ids.add(id);
    byPackage.set(pkg, ids);
  }
  return byPackage;
}

/**
 * The rows an issue body lists, as the person who read it saw them: the first
 * table with a Package, a Workspace and a To or Version column, each row with
 * the advisories listed against its package. Reads what `renderIssueBody` and
 * the security bodies write; a row it cannot read is skipped, and a body with
 * no such table gives none.
 */
export function readIssueRows(body: string): FiledRow[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.startsWith("|") && cellsOf(l)[0] === "Package");
  if (start < 0) return [];
  const header = cellsOf(lines[start]!);
  const workspaceAt = header.indexOf("Workspace");
  const fromAt = header.indexOf("From");
  const targetAt = header.includes("To") ? header.indexOf("To") : header.indexOf("Version");
  if (workspaceAt < 0 || targetAt < 0) return [];

  const advisories = advisoriesByPackage(lines);
  const rows: FiledRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = cellsOf(line);
    const pkg = uncode(cells[0] ?? "");
    const workspace = uncode(cells[workspaceAt] ?? "");
    const to = cells[targetAt];
    const target = to === STAYS_CELL && fromAt >= 0 ? cells[fromAt] : to;
    if (pkg === null || workspace === null || target === undefined) continue;
    rows.push({
      package: pkg,
      workspace,
      target: unplain(target),
      advisories: [...(advisories.get(pkg) ?? [])],
    });
  }
  return rows;
}
