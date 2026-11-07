// Version order per ecosystem. deps.dev lists a package's versions in no
// particular order, so the client sorts them with the ecosystem's own rule:
// SemVer 2.0 for npm, Cargo and GitHub Actions tags, PEP 440 for PyPI.

import { byText } from "../candidate.ts";

export type VersionScheme = "semver" | "pep440";

type Key = readonly (number | string)[];

/** Numbers before text; numbers by value, text by code unit. */
function compareParts(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return byText(a, b);
}

function compareKeys(a: Key, b: Key): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const order = compareParts(a[i]!, b[i]!);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

// A leading `v` and missing minor or patch are allowed, so `v4` and `v4.1`
// (GitHub Actions tags) read as 4.0.0 and 4.1.0.
const SEMVER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function compareSemver(a: string, b: string): number | null {
  const x = SEMVER_RE.exec(a.trim());
  const y = SEMVER_RE.exec(b.trim());
  if (x === null || y === null) return null;
  const core = (m: RegExpExecArray): Key => [1, 2, 3].map((i) => Number(m[i] ?? 0));
  const order = compareKeys(core(x), core(y));
  if (order !== 0) return order;
  // A release outranks every pre-release of it.
  if (x[4] === undefined || y[4] === undefined) {
    return (x[4] === undefined ? 1 : 0) - (y[4] === undefined ? 1 : 0);
  }
  const pre = (tag: string): Key =>
    tag.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return compareKeys(pre(x[4]), pre(y[4]));
}

const PEP440_RE =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;

const PRE_PHASE: Record<string, number> = {
  a: 0,
  alpha: 0,
  b: 1,
  beta: 1,
  c: 2,
  rc: 2,
  pre: 2,
  preview: 2,
};

/**
 * A PEP 440 version as a sort key: epoch, release with trailing zeros
 * dropped, then pre, post, dev and local. A dev release of a final sorts
 * before its pre-releases, and a final after them.
 */
function pep440Key(version: string): Key[] | null {
  const m = PEP440_RE.exec(version.trim());
  if (m === null) return null;
  const release = m[2]!.split(".").map(Number);
  while (release.length > 1 && release.at(-1) === 0) release.pop();
  const [, epoch, , phase, preN, postDash, postN, devN, local] = m;
  const hasPost = postDash !== undefined || postN !== undefined;
  const hasDev = devN !== undefined;
  const pre: Key =
    phase !== undefined
      ? [PRE_PHASE[phase.toLowerCase()]!, Number(preN || 0)]
      : hasDev && !hasPost
        ? [-Infinity]
        : [Infinity];
  const post: Key = hasPost ? [Number(postDash ?? (postN || 0))] : [-Infinity];
  const dev: Key = hasDev ? [Number(devN || 0)] : [Infinity];
  const localKey: Key =
    local === undefined
      ? []
      : local
          .toLowerCase()
          .split(/[-_.]/)
          .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return [[Number(epoch ?? 0)], release, pre, post, dev, localKey];
}

function comparePep440(a: string, b: string): number | null {
  const x = pep440Key(a);
  const y = pep440Key(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < x.length; i += 1) {
    const order = compareKeys(x[i]!, y[i]!);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Ascending order under the scheme. A version the scheme cannot read sorts
 * below every version it can, and such versions order among themselves by
 * text, so the newest readable release is always last.
 */
export function compareVersions(scheme: VersionScheme, a: string, b: string): number {
  const order = scheme === "pep440" ? comparePep440(a, b) : compareSemver(a, b);
  if (order !== null) return order;
  const readable = (v: string): boolean =>
    (scheme === "pep440" ? comparePep440(v, v) : compareSemver(v, v)) !== null;
  return Number(readable(a)) - Number(readable(b)) || byText(a, b);
}

/** The scheme a candidate's manager versions by: PEP 440 for the Python managers, SemVer for the rest. */
export function managerScheme(manager: string): VersionScheme {
  return /^(?:pip|pep|poetry|pipenv|setup|pdm|uv)/.test(manager) ? "pep440" : "semver";
}
