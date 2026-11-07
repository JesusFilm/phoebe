// The native source (ADR 0003): the rows list each project's direct
// dependencies with the manager's own tooling, deps.dev says what is newer and
// when it shipped, and OSV says what is vulnerable, with the manager's own
// audit unioned in where the row has one. A row never asks what is newer;
// this module does, once per package, through the process's shared clients.
//
// Detection runs first and on its own, because the agent fallback is told
// which manifests the rows claimed before either source starts.

import type { Candidate, UpdateType } from "../candidate.ts";
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

/** The size of a move by the first numeric segment that differs. */
function moveOf(current: string, target: string): UpdateType {
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

type Listed = { row: Row; dependency: ListedDependency };

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
  const listed: Listed[] = [];
  const findings: AuditFinding[] = [];
  let listedProjects = 0;
  for (const { row, manifest } of projects) {
    const result = await row.list(manifest);
    if (!result.ok) {
      deps.log(`${row.name} row: could not list ${manifest.path} (${result.problem}).`);
      continue;
    }
    listedProjects += 1;
    listed.push(...result.value.map((dependency) => ({ row, dependency })));
    if (row.audit === undefined) continue;
    const audit = await row.audit(manifest);
    if (audit.ok) findings.push(...audit.value);
    else deps.log(`${row.name} row: audit of ${manifest.path} failed (${audit.problem}).`);
  }
  if (projects.length > 0 && listedProjects === 0) {
    return { ok: false, problem: "no project the rows claimed could be listed" };
  }

  const versions = new Map<string, RegistryResult<PackageVersion[]>>();
  const packageKey = (l: Listed) => JSON.stringify([l.row.system, l.dependency.package]);
  const packages = [...new Map(listed.map((l) => [packageKey(l), l])).values()];
  await eachLimited(packages, DEPS_DEV_CONCURRENCY, async (l) => {
    versions.set(packageKey(l), await deps.depsDev.versions(l.row.system, l.dependency.package));
  });

  const queryKey = (l: Listed) =>
    JSON.stringify([l.row.ecosystem, l.dependency.package, l.dependency.current]);
  const queries = [...new Map(listed.map((l) => [queryKey(l), l])).values()];
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
  const audited = new Map<string, AuditFinding["advisory"][]>();
  for (const finding of findings) {
    const key = JSON.stringify([finding.package, finding.version]);
    audited.set(key, [...(audited.get(key) ?? []), finding.advisory]);
  }

  const candidates: Candidate[] = [];
  const unanswered = new Set<string>();
  for (const l of listed) {
    const { row, dependency } = l;
    const answer = versions.get(packageKey(l));
    if (answer === undefined || !answer.ok) {
      unanswered.add(dependency.package);
      continue;
    }
    const advisories = unionAdvisories([
      osvByQuery.get(queryKey(l)) ?? [],
      audited.get(JSON.stringify([dependency.package, dependency.current])) ?? [],
    ]);
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
