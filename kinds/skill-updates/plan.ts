// The pure half of the `skill-updates` kind (#877): which ref a source moves to
// next, how the lock's entries group into sources, the marker a PR carries, and
// what to do given the PRs already on a source's branch. No git, no GitHub.

import type { SkillLock, SkillLockEntry } from "../../src/skill-lock.ts";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * How a source is pinned. `tag` moves along semver tags; `commit` follows a
 * branch (the default one when `branch` is absent) and moves to its newest
 * commit that has aged `minAge`.
 */
export type SourcePin =
  | { kind: "tag"; ref: string }
  | { kind: "commit"; branch: string | null; commits: readonly string[] };

/** One upstream source as the lock names it: the skills it vendors and how it is pinned. */
export type SkillSource = {
  source: string;
  sourceType: string | null;
  pin: SourcePin;
  /** The upstream commit the lock is on at the current pin, when an entry records one. */
  lockedCommit: string | null;
  /** Locked skills this kind syncs, sorted. */
  skills: readonly string[];
  /** Locked skills `ignore` names, sorted. They stay as they are. */
  ignored: readonly string[];
};

export type Semver = { major: number; minor: number; patch: number };

const SEMVER_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** A release tag's version, or null for anything else (pre-releases included). */
export function parseTag(tag: string): Semver | null {
  const match = SEMVER_TAG_RE.exec(tag);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Group the lock's entries by source. A source is tag-pinned when any of its
 * synced entries has a release-tag `ref`, and its current ref is the highest of
 * them: an entry the last sync could not move (removed or ambiguous upstream)
 * keeps its old ref, and must not pull the source back to a ref already merged.
 * Otherwise it follows the branch its entries name, or the default one, from
 * the commits its entries are on. A source whose every skill is ignored is
 * left out.
 */
export function groupSources(lock: SkillLock, ignore: readonly string[]): SkillSource[] {
  const bySource = new Map<string, [string, SkillLockEntry][]>();
  for (const [name, entry] of Object.entries(lock.skills)) {
    const list = bySource.get(entry.source) ?? [];
    list.push([name, entry]);
    bySource.set(entry.source, list);
  }
  const sources: SkillSource[] = [];
  for (const [source, entries] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
    const synced = entries.filter(([name]) => !ignore.includes(name));
    if (synced.length === 0) continue;
    const tags = synced
      .map(([, e]) => e.ref)
      .filter((ref): ref is string => ref !== undefined && parseTag(ref) !== null)
      .sort((a, b) => compareSemver(parseTag(a)!, parseTag(b)!));
    const branch = synced.map(([, e]) => e.ref).find((ref) => ref !== undefined) ?? null;
    const pin: SourcePin =
      tags.length > 0
        ? { kind: "tag", ref: tags.at(-1)! }
        : {
            kind: "commit",
            branch,
            commits: [...new Set(synced.map(([, e]) => e.commit).filter((c): c is string => !!c))],
          };
    const atPin = pin.kind === "tag" ? synced.filter(([, e]) => e.ref === pin.ref) : synced;
    sources.push({
      source,
      sourceType: synced[0]![1].sourceType ?? null,
      pin,
      lockedCommit: atPin.map(([, e]) => e.commit).find((c) => !!c) ?? null,
      skills: synced.map(([name]) => name).sort(),
      ignored: entries
        .filter(([name]) => ignore.includes(name))
        .map(([name]) => name)
        .sort(),
    });
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Which ref next
// ---------------------------------------------------------------------------

/**
 * The tags a tag-pinned source would move through from `current`, in order:
 * the newest release of the current major when one is newer, then the newest
 * release of each later major. Every rung is its own PR, so a major is never
 * bundled with the minor before it.
 */
export function tagLadder(current: string, tags: readonly string[]): string[] {
  const from = parseTag(current);
  if (from === null) return [];
  const newestByMajor = new Map<number, { tag: string; version: Semver }>();
  for (const tag of tags) {
    const version = parseTag(tag);
    if (version === null || compareSemver(version, from) <= 0) continue;
    const best = newestByMajor.get(version.major);
    if (best === undefined || compareSemver(version, best.version) > 0) {
      newestByMajor.set(version.major, { tag, version });
    }
  }
  return [...newestByMajor.entries()].sort(([a], [b]) => a - b).map(([, { tag }]) => tag);
}

/**
 * The tag to propose: the first rung of the ladder no closed PR vetoed. A veto
 * holds one exact ref, so a newer release on the same major lifts it, and a
 * vetoed minor does not hold back the major after it.
 */
export function nextTag(
  current: string,
  tags: readonly string[],
  vetoed: ReadonlySet<string>,
): string | null {
  return tagLadder(current, tags).find((tag) => !vetoed.has(tag)) ?? null;
}

/** One commit on the branch a SHA-pinned source follows. */
export type BranchCommit = { sha: string; committedAt: number };

/**
 * The commit to propose for a SHA-pinned source: the newest commit on the
 * branch, newest first in `log`, that is at least `minAgeMs` old and newer than
 * every commit the lock is on. Null when the lock is already there, when every
 * newer commit is still too young, or when the one that qualifies was vetoed:
 * an older commit is never offered instead, so the veto lifts only once a newer
 * commit ages.
 */
export function matureCommit(
  log: readonly BranchCommit[],
  locked: readonly string[],
  nowMs: number,
  minAgeMs: number,
  vetoed: ReadonlySet<string>,
): string | null {
  for (const commit of log) {
    if (locked.includes(commit.sha)) return null;
    if (nowMs - commit.committedAt < minAgeMs) continue;
    return vetoed.has(commit.sha) ? null : commit.sha;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------

export type SkillMarker = { source: string; ref: string };

const MARKER_RE = /<!--\s*phoebe-skills\s+source=(\S+)\s+ref=(\S+)\s*-->/g;
const NEWER_RE = /<!--\s*phoebe-skills-newer\s+source=(\S+)\s+ref=(\S+)\s*-->/g;

/** The line a PR body ends with: `<!-- phoebe-skills source=<source> ref=<ref> -->`. */
export function renderMarker(marker: SkillMarker): string {
  return `<!-- phoebe-skills source=${marker.source} ref=${marker.ref} -->`;
}

/** The source and ref a PR body names, or null. The last marker wins, as it is written last. */
export function parseMarker(body: string): SkillMarker | null {
  const match = [...body.matchAll(MARKER_RE)].at(-1);
  return match === undefined ? null : { source: match[1]!, ref: match[2]! };
}

/** The marker on the comment that says a newer ref is out, so it is posted once per ref. */
export function renderNewerMarker(marker: SkillMarker): string {
  return `<!-- phoebe-skills-newer source=${marker.source} ref=${marker.ref} -->`;
}

function namesNewer(body: string, marker: SkillMarker): boolean {
  return [...body.matchAll(NEWER_RE)].some((m) => m[1] === marker.source && m[2] === marker.ref);
}

/** The stable branch every PR for one source opens from. */
export function sourceBranch(branchPrefix: string, source: string): string {
  const slug = source
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${branchPrefix}skill-updates/${slug}`;
}

// ---------------------------------------------------------------------------
// What to do
// ---------------------------------------------------------------------------

/** A PR on a source's branch, as the scan reads it. */
export type SourcePr = {
  number: number;
  state: "open" | "closed" | "merged";
  body: string;
  isDraft: boolean;
};

/** The refs of `source` that a PR closed unmerged vetoed. */
export function vetoedRefs(prs: readonly SourcePr[], source: string): Set<string> {
  const refs = new Set<string>();
  for (const pr of prs) {
    if (pr.state !== "closed") continue;
    const marker = parseMarker(pr.body);
    if (marker !== null && marker.source === source) refs.add(marker.ref);
  }
  return refs;
}

export type Decision =
  | { action: "nothing"; reason: string }
  | { action: "open" }
  | { action: "refresh"; pr: SourcePr }
  | { action: "notify"; pr: SourcePr };

/**
 * What one scan does for a source with a proposal, given the open PR on its
 * branch (if any), whether that PR carries a commit from someone other than
 * Phoebe, and the comments on it.
 */
export function decide(opts: {
  source: string;
  proposal: string;
  open: SourcePr | null;
  foreign: boolean;
  comments: readonly string[];
}): Decision {
  const { source, proposal, open } = opts;
  if (open === null) return { action: "open" };
  const marker = parseMarker(open.body);
  if (marker?.source === source && marker.ref === proposal) {
    return { action: "nothing", reason: `PR #${open.number} already proposes ${proposal}` };
  }
  if (!opts.foreign) return { action: "refresh", pr: open };
  if (opts.comments.some((body) => namesNewer(body, { source, ref: proposal }))) {
    return {
      action: "nothing",
      reason: `PR #${open.number} has commits from someone else; ${proposal} was already pointed out`,
    };
  }
  return { action: "notify", pr: open };
}
