// The native source (ADR 0003): the rows list each project's direct
// dependencies with the manager's own tooling, deps.dev says what is newer and
// when it shipped, and OSV says what is vulnerable, with the manager's own
// audit unioned in where the row has one. A row never asks what is newer;
// this module does, once per package, through the process's shared clients.
//
// Detection runs first and on its own, because the agent fallback is told
// which manifests the rows claimed before either source starts.

import { byText, type Advisory, type Candidate, type UpdateType } from "../candidate.ts";
import type { DepsDevClient, DepsDevSystem, PackageVersion } from "../registry/deps-dev.ts";
import type { RegistryResult } from "../registry/http.ts";
import type { OsvClient, OsvQuery } from "../registry/osv.ts";
import { compareVersions, type VersionScheme } from "../registry/versions.ts";
import {
  unionAdvisories,
  type AuditFinding,
  type ListedDependency,
  type Manifest,
  type Row,
  type RowResult,
} from "../rows/row.ts";
import type { SourceResult } from "./source.ts";

/** The name the detectors' `sources` option lists this source by. */
export const NATIVE_SOURCE_NAME = "native";

/** deps.dev requests in flight at once. */
export const DEPS_DEV_CONCURRENCY = 8;

/** One project a row claimed. */
export type NativeProject = { row: Row; manifest: Manifest };

export type NativeDetection = {
  projects: NativeProject[];
  /** Every manifest the rows list, for the agent fallback to skip. */
  claimed: string[];
};

export type NativeSourceDeps = {
  depsDev: DepsDevClient;
  osv: OsvClient;
  log: (line: string) => void;
};

const SCHEME: Record<DepsDevSystem, VersionScheme> = {
  npm: "semver",
  cargo: "semver",
  pypi: "pep440",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ask every row which projects it lists in the checkout. A row that throws
 * claims nothing, so its manifests fall to the agent fallback like those of a
 * row whose tool is missing.
 */
export async function detectNative(
  rows: readonly Row[],
  checkout: string,
  log: (line: string) => void,
): Promise<NativeDetection> {
  const projects: NativeProject[] = [];
  for (const row of rows) {
    try {
      for (const manifest of await row.detect(checkout)) projects.push({ row, manifest });
    } catch (error) {
      log(`${row.name} row: detection failed (${errorText(error)}); left to the agent fallback.`);
    }
  }
  const claimed = [...new Set(projects.flatMap((p) => p.manifest.workspaces))];
  return { projects, claimed };
}

/** A pre-release under the scheme: a SemVer `-tag`, or a PEP 440 a/b/rc/dev segment. */
function isPrerelease(scheme: VersionScheme, version: string): boolean {
  return scheme === "pep440"
    ? /\d(?:[-_.]?(?:a|alpha|b|beta|c|rc|pre|preview|dev)\d*)/i.test(version)
    : /^v?\d+(?:\.\d+)*-/.test(version);
}

function segments(version: string): number[] {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  return match === null ? [] : match.slice(1).map((part) => Number(part ?? 0));
}

/** The size of a move by the first numeric segment that differs; `patch` when there is none. */
export function moveOf(current: string, target: string): UpdateType {
  const from = segments(current);
  const to = segments(target);
  if (from.length === 0 || to.length === 0 || from[0] !== to[0]) return "major";
  return from[1] !== to[1] ? "minor" : "patch";
}

/**
 * The versions to propose for one dependency: the newest release on the
 * current major, the newest overall when that is a major move, and the
 * release that fixes each advisory on the current version. The fix release
 * is its own proposal because only it skips the maturity wait (policy.ts), so
 * a fix can ship while the newest release is still ageing. Deprecated
 * releases are never proposed, nor pre-releases unless the current version
 * is one.
 */
export function chooseTargets(
  scheme: VersionScheme,
  current: string,
  versions: readonly PackageVersion[],
  fixes: readonly string[],
): PackageVersion[] {
  const allowPre = isPrerelease(scheme, current);
  const newer = versions.filter(
    (v) =>
      !v.isDeprecated &&
      compareVersions(scheme, v.version, current) > 0 &&
      (allowPre || !isPrerelease(scheme, v.version)),
  );
  const chosen = new Map<string, PackageVersion>();
  const major = segments(current)[0];
  const sameMajor = newer.filter((v) => segments(v.version)[0] === major);
  const newestSameMajor = sameMajor.at(-1);
  if (newestSameMajor !== undefined) chosen.set(newestSameMajor.version, newestSameMajor);
  const newest = newer.at(-1);
  if (newest !== undefined && segments(newest.version)[0] !== major) {
    chosen.set(newest.version, newest);
  }
  for (const fix of fixes) {
    const release = newer.find((v) => compareVersions(scheme, v.version, fix) === 0);
    if (release !== undefined) chosen.set(release.version, release);
  }
  return [...chosen.values()].sort((a, b) => compareVersions(scheme, a.version, b.version));
}

/** Run `task` over `items`, at most `limit` at a time. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

type Listed = { row: Row; manifest: Manifest; dependency: ListedDependency };

/** What the rows hand back for every claimed project: the listing and the audits. */
type Listing = {
  listed: Listed[];
  audits: { project: NativeProject; findings: AuditFinding[] }[];
};

/**
 * List and audit every claimed project. A project that will not list and an
 * audit that fails each cost a log line, and an audit runs whether or not its
 * project listed. Fails only when there were projects and none of them listed.
 */
async function listProjects(
  projects: readonly NativeProject[],
  log: (line: string) => void,
): Promise<RowResult<Listing>> {
  const listing: Listing = { listed: [], audits: [] };
  let listedProjects = 0;
  for (const project of projects) {
    const { row, manifest } = project;
    const result = await row.list(manifest);
    if (result.ok) {
      listedProjects += 1;
      listing.listed.push(...result.value.map((dependency) => ({ row, manifest, dependency })));
    } else {
      log(`${row.name} row: could not list ${manifest.path} (${result.problem}).`);
    }
    if (row.audit === undefined) continue;
    const audit = await row.audit(manifest);
    if (audit.ok) listing.audits.push({ project, findings: audit.value });
    else log(`${row.name} row: audit of ${manifest.path} failed (${audit.problem}).`);
  }
  if (projects.length > 0 && listedProjects === 0) {
    return { ok: false, problem: "no project the rows claimed could be listed" };
  }
  return { ok: true, value: listing };
}

/**
 * One OSV batch over every listed dependency's current version, unioned with
 * the audits: a lookup from a listed dependency to its advisories. A failed
 * OSV call costs a log line, and the audits stand alone.
 */
async function lookupAdvisories(
  listing: Listing,
  deps: Pick<NativeSourceDeps, "osv" | "log">,
): Promise<{ advisoriesOf: (l: Listed) => Advisory[]; osvFailed: boolean }> {
  const queryKey = (l: Listed) =>
    JSON.stringify([l.row.ecosystem, l.dependency.package, l.dependency.current]);
  const queries = [...new Map(listing.listed.map((l) => [queryKey(l), l])).values()];
  const osvQueries: OsvQuery[] = queries.map((l) => ({
    ecosystem: l.row.ecosystem,
    name: l.dependency.package,
    version: l.dependency.current,
  }));
  const osv = osvQueries.length > 0 ? await deps.osv.advisories(osvQueries) : null;
  if (osv !== null && !osv.ok) {
    deps.log(`native source: OSV failed (${osv.error}); advisories come from the audits alone.`);
  }
  const osvByQuery = new Map(
    osv?.ok === true ? queries.map((l, i) => [queryKey(l), osv.value[i]!]) : [],
  );
  const audited = new Map<string, Advisory[]>();
  for (const { project, findings } of listing.audits) {
    for (const finding of findings) {
      const key = JSON.stringify([project.row.ecosystem, finding.package, finding.version]);
      audited.set(key, [...(audited.get(key) ?? []), finding.advisory]);
    }
  }
  const advisoriesOf = (l: Listed): Advisory[] =>
    unionAdvisories([
      osvByQuery.get(queryKey(l)) ?? [],
      audited.get(JSON.stringify([l.row.ecosystem, l.dependency.package, l.dependency.current])) ??
        [],
    ]);
  return { advisoriesOf, osvFailed: osv !== null && !osv.ok };
}

/**
 * List every claimed project, ask deps.dev and OSV about what was listed, and
 * return a candidate per proposed version. A project that will not list, a
 * package deps.dev cannot answer for and a failed OSV call each cost a log
 * line and leave the rest standing. The source fails only when there were
 * projects and none of them listed.
 */
export async function runNativeSource(
  projects: readonly NativeProject[],
  deps: NativeSourceDeps,
): Promise<SourceResult> {
  const listing = await listProjects(projects, deps.log);
  if (!listing.ok) return { ok: false, problem: listing.problem };
  const { listed } = listing.value;

  const versions = new Map<string, RegistryResult<PackageVersion[]>>();
  const packageKey = (l: Listed) => JSON.stringify([l.row.system, l.dependency.package]);
  const packages = [...new Map(listed.map((l) => [packageKey(l), l])).values()];
  await eachLimited(packages, DEPS_DEV_CONCURRENCY, async (l) => {
    versions.set(packageKey(l), await deps.depsDev.versions(l.row.system, l.dependency.package));
  });
  const { advisoriesOf } = await lookupAdvisories(listing.value, deps);

  const candidates: Candidate[] = [];
  const unanswered = new Set<string>();
  for (const l of listed) {
    const { row, dependency } = l;
    const answer = versions.get(packageKey(l));
    if (answer === undefined || !answer.ok) {
      unanswered.add(dependency.package);
      continue;
    }
    const advisories = advisoriesOf(l);
    const fixes = advisories.flatMap((a) => (a.fixedIn === null ? [] : [a.fixedIn]));
    for (const target of chooseTargets(
      SCHEME[row.system],
      dependency.current,
      answer.value,
      fixes,
    )) {
      const candidate: Candidate = {
        manager: row.manager,
        package: dependency.package,
        current: dependency.current,
        target: target.version,
        updateType: moveOf(dependency.current, target.version),
        depType: dependency.depType,
        workspace: dependency.workspace,
        advisories,
        peers: [],
        via: [],
      };
      if (target.publishedAt !== undefined) candidate.publishedAt = target.publishedAt;
      candidates.push(candidate);
    }
  }
  if (unanswered.size > 0) {
    const names = [...unanswered];
    deps.log(
      `native source: deps.dev could not answer for ${names.length} package(s) ` +
        `(${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}); they are skipped this pass.`,
    );
  }
  return { ok: true, candidates };
}

/**
 * The highest version above `current` that fixes one of the advisories, or
 * `current` when none does. A fix at or below the installed version, which an
 * agent source can report, is no upgrade target and is ignored.
 */
export function fixTarget(
  scheme: VersionScheme,
  current: string,
  advisories: readonly Advisory[],
): string {
  const fixes = advisories
    .flatMap((a) => (a.fixedIn === null ? [] : [a.fixedIn]))
    .filter((fix) => compareVersions(scheme, fix, current) > 0)
    .sort((a, b) => compareVersions(scheme, a, b));
  return fixes.at(-1) ?? current;
}

/** A dependency carrying advisories, as the security pass proposes it. */
function securityCandidate(
  row: Row,
  occurrence: Pick<Candidate, "package" | "current" | "depType" | "workspace">,
  advisories: readonly Advisory[],
  via: readonly string[] | undefined,
): Candidate {
  const target = fixTarget(SCHEME[row.system], occurrence.current, advisories);
  const candidate: Candidate = {
    manager: row.manager,
    ...occurrence,
    target,
    updateType: moveOf(occurrence.current, target),
    advisories,
    peers: [],
  };
  if (via !== undefined) candidate.via = via;
  return candidate;
}

/**
 * The native source as the hourly security pass runs it: the rows' listing,
 * one OSV batch over what they listed, and the audits, with no deps.dev call
 * (docs/research/renovate-extraction-spike.md, question 5). Each dependency
 * with an advisory is one candidate targeting the highest version that fixes
 * one, or its own version when none does; the kind decides what to file.
 *
 * An audit finding for a version no workspace lists directly is transitive.
 * It is proposed against each workspace whose direct dependencies the audit's
 * paths name, `via` those; when the paths name none, against the project's
 * root manifest with `via` left out.
 */
export async function runNativeSecuritySource(
  projects: readonly NativeProject[],
  deps: Pick<NativeSourceDeps, "osv" | "log">,
): Promise<SourceResult> {
  const listing = await listProjects(projects, deps.log);
  if (!listing.ok) return { ok: false, problem: listing.problem };
  const { advisoriesOf, osvFailed } = await lookupAdvisories(listing.value, deps);
  const auditable = projects.filter((p) => p.row.audit !== undefined).length;
  if (osvFailed && auditable > 0 && listing.value.audits.length === 0) {
    return { ok: false, problem: "OSV and every audit failed; no advisory source answered" };
  }
  if (osvFailed && auditable === 0) {
    return { ok: false, problem: "OSV failed and no row audits; no advisory source answered" };
  }

  const candidates: Candidate[] = [];
  for (const l of listing.value.listed) {
    const advisories = advisoriesOf(l);
    if (advisories.length > 0)
      candidates.push(securityCandidate(l.row, l.dependency, advisories, []));
  }

  for (const { project, findings } of listing.value.audits) {
    const listed = listing.value.listed.filter((l) => l.manifest === project.manifest);
    const versionKey = (pkg: string, version: string) => JSON.stringify([pkg, version]);
    const direct = new Set(
      listed.map((l) => versionKey(l.dependency.package, l.dependency.current)),
    );
    const grouped = new Map<string, AuditFinding[]>();
    for (const finding of findings) {
      const key = versionKey(finding.package, finding.version);
      grouped.set(key, [...(grouped.get(key) ?? []), finding]);
    }
    for (const [key, group] of grouped) {
      const { package: pkg, version } = group[0]!;
      const advisories = unionAdvisories(group.map((f) => [f.advisory]));
      const ancestors = new Set(group.flatMap((f) => f.ancestors ?? []));
      const declaring = new Set(
        listed
          .filter((l) => versionKey(l.dependency.package, l.dependency.current) === key)
          .map((l) => l.dependency.workspace),
      );
      const parents = listed.filter(
        (l) => ancestors.has(l.dependency.package) && !declaring.has(l.dependency.workspace),
      );
      if (direct.has(key) && parents.length === 0) continue;
      if (parents.length === 0) {
        const workspace = project.manifest.path;
        const occurrence = { package: pkg, current: version, depType: "prod" as const, workspace };
        candidates.push(securityCandidate(project.row, occurrence, advisories, undefined));
        continue;
      }
      const byWorkspace = new Map<string, Listed[]>();
      for (const parent of parents) {
        const ws = parent.dependency.workspace;
        byWorkspace.set(ws, [...(byWorkspace.get(ws) ?? []), parent]);
      }
      for (const [workspace, through] of byWorkspace) {
        const depType = through.some((p) => p.dependency.depType !== "dev") ? "prod" : "dev";
        const via = [...new Set(through.map((p) => p.dependency.package))].sort(byText);
        candidates.push(
          securityCandidate(
            project.row,
            { package: pkg, current: version, depType, workspace },
            advisories,
            via,
          ),
        );
      }
    }
  }
  return { ok: true, candidates };
}
