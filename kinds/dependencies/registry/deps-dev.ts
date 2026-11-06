// deps.dev v3 `GetPackage`: a package's versions with their publish dates. The
// native source reads its target version and `publishedAt` from here. v3 has
// no batch form, so a pass costs one GET per package; the response says
// `cache-control: public, max-age=3600`, and the cache honours it, so the
// hourly security pass and the daily updates pass share one GET per package
// per hour (docs/research/renovate-extraction-spike.md, question 5).

import {
  requestJson,
  systemClock,
  maxAgeMs,
  type Clock,
  type Fetch,
  type RegistryResult,
} from "./http.ts";
import { compareVersions, type VersionScheme } from "./versions.ts";

/** The systems a native row asks about. deps.dev has no GitHub Actions system. */
export type DepsDevSystem = "npm" | "cargo" | "pypi";

export type PackageVersion = {
  version: string;
  /** ISO 8601. deps.dev reports it "if available"; a version without one is not yet mature. */
  publishedAt?: string;
  isDefault: boolean;
  isDeprecated: boolean;
};

export type DepsDevClient = {
  /** Every version of the package, oldest first by the ecosystem's own order. */
  versions(system: DepsDevSystem, name: string): Promise<RegistryResult<PackageVersion[]>>;
};

export const DEPS_DEV_BASE_URL = "https://api.deps.dev/v3";

/** How long an answer stays fresh when the response carries no `max-age`: the hour deps.dev sends. */
export const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

const SCHEME: Record<DepsDevSystem, VersionScheme> = {
  npm: "semver",
  cargo: "semver",
  pypi: "pep440",
};

/** PEP 503: lower case, and every run of `-`, `_` and `.` becomes one `-`. */
function normaliseName(system: DepsDevSystem, name: string): string {
  return system === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}

type RawVersion = {
  versionKey?: { version?: unknown };
  publishedAt?: unknown;
  isDefault?: unknown;
  isDeprecated?: unknown;
};

function readVersions(body: unknown, scheme: VersionScheme): PackageVersion[] | null {
  const raw = (body as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(raw)) return null;
  const versions: PackageVersion[] = [];
  for (const entry of raw as RawVersion[]) {
    const version = entry?.versionKey?.version;
    if (typeof version !== "string" || version === "") continue;
    const read: PackageVersion = {
      version,
      isDefault: entry.isDefault === true,
      isDeprecated: entry.isDeprecated === true,
    };
    if (typeof entry.publishedAt === "string" && entry.publishedAt !== "") {
      read.publishedAt = entry.publishedAt;
    }
    versions.push(read);
  }
  return versions.sort((a, b) => compareVersions(scheme, a.version, b.version));
}

type Entry = { expiresAt: number; result: Promise<RegistryResult<PackageVersion[]>> };

/**
 * A deps.dev client with its own cache, keyed on system and package. Keep one
 * per process: an answer is reused until its `max-age` runs out, a package
 * asked twice while the first request is in flight shares that request, and
 * a failure is never cached.
 */
export function createDepsDevClient(
  deps: { fetch?: Fetch; clock?: Clock; baseUrl?: string } = {},
): DepsDevClient {
  const fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const clock = deps.clock ?? systemClock;
  const baseUrl = deps.baseUrl ?? DEPS_DEV_BASE_URL;
  const cache = new Map<string, Entry>();

  async function load(
    system: DepsDevSystem,
    name: string,
    entry: Entry,
  ): Promise<RegistryResult<PackageVersion[]>> {
    const url = `${baseUrl}/systems/${system}/packages/${encodeURIComponent(name)}`;
    const answer = await requestJson({ fetch, clock, source: "deps.dev" }, url);
    if (!answer.ok) return answer;
    const versions = readVersions(answer.value.body, SCHEME[system]);
    if (versions === null) {
      return { ok: false, source: "deps.dev", error: `${url}: no versions in the response` };
    }
    entry.expiresAt = clock.now() + (maxAgeMs(answer.value.headers) ?? DEFAULT_MAX_AGE_MS);
    return { ok: true, value: versions };
  }

  return {
    versions(system, name) {
      const normalised = normaliseName(system, name);
      const key = `${system}\u0000${normalised}`;
      const seen = cache.get(key);
      if (seen !== undefined && clock.now() < seen.expiresAt) return seen.result;
      const entry = { expiresAt: Infinity } as Entry;
      entry.result = load(system, normalised, entry).then((result) => {
        if (!result.ok && cache.get(key) === entry) cache.delete(key);
        return result;
      });
      cache.set(key, entry);
      return entry.result;
    },
  };
}
