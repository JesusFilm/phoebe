// The candidate contract (ADR 0003): one shape every dependency source yields
// and every dependency kind reads. Policy, grouping and filing never learn
// which source produced a candidate, so a field a source cannot fill is
// optional here rather than guessed.

/**
 * What kind of move a candidate is. `lockfile` is a newer version the
 * manifest's range already allows, so only the lockfile moves; `pin` and
 * `digest` name no new version at all.
 */
export const UPDATE_TYPES = ["patch", "minor", "major", "pin", "digest", "lockfile"] as const;
export type UpdateType = (typeof UPDATE_TYPES)[number];

export const DEP_TYPES = ["prod", "dev", "optional", "peer"] as const;
export type DepType = (typeof DEP_TYPES)[number];

/** Advisory severities, lowest first. */
export const SEVERITIES = ["low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type Advisory = {
  /** The advisory's id as its database names it — `GHSA-…`, `RUSTSEC-…`, `CVE-…`. */
  id: string;
  severity: Severity;
  /** The first version that fixes it; null when no fix has shipped. */
  fixedIn: string | null;
};

export type Candidate = {
  /** The ecosystem's manager — `npm`, `cargo`, `pip_requirements`, `dockerfile`. */
  manager: string;
  package: string;
  current: string;
  target: string;
  updateType: UpdateType;
  /** When `target` was published, ISO 8601. Absent when the source reports none. */
  publishedAt?: string;
  depType: DepType;
  /** The owning workspace package: its manifest path, relative to the checkout. */
  workspace: string;
  advisories: readonly Advisory[];
  /** The package's declared peer dependencies, read by `by-relation` grouping. */
  peers: readonly string[];
  /** The package's source repository, read by `by-relation` grouping. */
  repositoryUrl?: string;
  /**
   * The direct dependencies the package is reached through: empty for a
   * direct dependency, absent when the source cannot say. Native rows fill it
   * from the listing and the audit's paths; Renovate never reports a
   * transitive package, so its candidates leave it out.
   */
  via?: readonly string[];
  /**
   * Set when the entry is a package manager override, not a declared
   * dependency: `overrides` in `package.json` or `pnpm-workspace.yaml`,
   * `pnpm.overrides`, or yarn `resolutions`. It pins a package that other
   * packages pull in, and those packages declare the range it belongs in, so
   * `dependency-updates` never proposes moving it. Only `dependency-security`
   * does, to the fix an advisory names.
   */
  override?: true;
};

/** Code-unit order, so the same input sorts the same under any locale. */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Two records are the same occurrence when all six of these match. The same
 * package wanted by two workspace packages stays two candidates, and a minor
 * and a major proposal for one package stay two candidates.
 */
function occurrenceKey(c: Candidate): string {
  return JSON.stringify([c.manager, c.package, c.current, c.target, c.depType, c.workspace]);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byText);
}

/**
 * The first record wins every scalar it has; a later record only fills what
 * the first left out. Advisories union by id, and peers and `via` by name.
 * The union is an override only when both records are: a declared dependency
 * at the same occurrence has its own range in the manifest.
 */
function merge(a: Candidate, b: Candidate): Candidate {
  const advisories = new Map(a.advisories.map((advisory) => [advisory.id, advisory]));
  for (const advisory of b.advisories) {
    if (!advisories.has(advisory.id)) advisories.set(advisory.id, advisory);
  }
  const merged: Candidate = {
    ...a,
    advisories: [...advisories.values()].sort((x, y) => byText(x.id, y.id)),
    peers: uniqueSorted([...a.peers, ...b.peers]),
  };
  const publishedAt = a.publishedAt ?? b.publishedAt;
  if (publishedAt !== undefined) merged.publishedAt = publishedAt;
  const repositoryUrl = a.repositoryUrl ?? b.repositoryUrl;
  if (repositoryUrl !== undefined) merged.repositoryUrl = repositoryUrl;
  if (a.via !== undefined || b.via !== undefined) {
    merged.via = uniqueSorted([...(a.via ?? []), ...(b.via ?? [])]);
  }
  if (a.override !== true || b.override !== true) delete merged.override;
  return merged;
}

/**
 * The union of every source's list, one candidate per occurrence, in the
 * order each occurrence was first seen. Earlier lists win conflicts, so the
 * caller passes sources in order of trust.
 */
export function unionCandidates(lists: readonly (readonly Candidate[])[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const list of lists) {
    for (const candidate of list) {
      const key = occurrenceKey(candidate);
      const seen = byKey.get(key);
      byKey.set(key, seen === undefined ? candidate : merge(seen, candidate));
    }
  }
  return [...byKey.values()];
}

/** Candidates by package, then workspace, target, current and dependency type. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    byText(a.package, b.package) ||
    byText(a.workspace, b.workspace) ||
    byText(a.target, b.target) ||
    byText(a.current, b.current) ||
    byText(a.depType, b.depType)
  );
}

// The host and path accept URL characters only, so the URL this returns can
// go into an issue body as it is. A repository field comes from a package's
// own manifest, which its publisher controls, and anything else in it (a
// space, `<`, a backtick) is either broken or an attempt to write markup.
const REPOSITORY_RE =
  /^(?:git\+)?(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?|git@)([A-Za-z0-9.-]+)[/:]([A-Za-z0-9._~/-]+?)(?:\.git)?\/*(?:#\S*)?$/;

/**
 * A manifest's repository URL as a browsable `https://` URL —
 * `git+https://github.com/x/y.git` and `git@github.com:x/y.git` both become
 * `https://github.com/x/y` — or null when it is not a URL this can read,
 * including one carrying anything but URL characters. A `#readme` fragment is
 * dropped.
 */
export function repositoryWebUrl(url: string): string | null {
  const match = REPOSITORY_RE.exec(url.trim());
  return match === null ? null : `https://${match[1]}/${match[2]}`;
}
