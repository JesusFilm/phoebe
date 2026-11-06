// OSV: which of a set of package versions carry advisories, with each
// advisory's severity and first fixed version. `querybatch` answers with only
// an id and a `modified` stamp per advisory, so the detail comes from
// `GET /v1/vulns/{id}`, cached by id and `modified` so an advisory that has
// not changed costs nothing on the next pass
// (docs/research/renovate-extraction-spike.md, question 5).

import type { Advisory, Severity } from "../candidate.ts";
import {
  requestJson,
  systemClock,
  type Clock,
  type Fetch,
  type RegistryFailure,
  type RegistryResult,
} from "./http.ts";
import { compareVersions, type VersionScheme } from "./versions.ts";

/** OSV's own ecosystem strings for the native rows. */
export type OsvEcosystem = "npm" | "crates.io" | "PyPI" | "GitHub Actions";

/**
 * One package version to check. GitHub Actions advisories match by commit
 * and not by tag, so an action is asked about by the SHA its ref resolves to;
 * the name still says which package's fixed version to report.
 */
export type OsvQuery =
  | { ecosystem: OsvEcosystem; name: string; version: string }
  | { ecosystem: "GitHub Actions"; name: string; commit: string };

export type OsvClient = {
  /** The advisories affecting each query, in the order the queries came. */
  advisories(queries: readonly OsvQuery[]): Promise<RegistryResult<Advisory[][]>>;
};

export const OSV_BASE_URL = "https://api.osv.dev/v1";

/** The server rejects a batch of more than 1,000 queries; its docs name no cap. */
export const MAX_BATCH_QUERIES = 1_000;
/** Advisory detail requests in flight at once. */
export const VULN_CONCURRENCY = 8;
/**
 * The severity an advisory gets when it carries no rating this client reads.
 * It sits below the default `minSeverity`, so an unrated advisory rides its
 * candidate rather than filing an issue of its own.
 */
export const UNRATED_SEVERITY: Severity = "moderate";

const SCHEME: Record<OsvEcosystem, VersionScheme> = {
  npm: "semver",
  "crates.io": "semver",
  PyPI: "pep440",
  "GitHub Actions": "semver",
};

type Ref = { id: string; modified: string };

type RawRange = { type?: unknown; events?: { fixed?: unknown }[] };
type RawAffected = {
  package?: { ecosystem?: unknown; name?: unknown };
  ranges?: RawRange[];
  ecosystem_specific?: { severity?: unknown };
  database_specific?: { severity?: unknown };
};
type RawVuln = {
  id?: unknown;
  severity?: { type?: unknown; score?: unknown }[];
  affected?: RawAffected[];
  database_specific?: { severity?: unknown };
};

function queryKey(query: OsvQuery): string {
  return JSON.stringify(
    "commit" in query
      ? [query.ecosystem, query.name, "commit", query.commit]
      : [query.ecosystem, query.name, "version", query.version],
  );
}

function queryBody(query: OsvQuery, pageToken: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> =
    "commit" in query
      ? { commit: query.commit }
      : { package: { ecosystem: query.ecosystem, name: query.name }, version: query.version };
  if (pageToken !== undefined) body.page_token = pageToken;
  return body;
}

function sameName(ecosystem: OsvEcosystem, a: string, b: string): boolean {
  if (ecosystem === "PyPI") {
    const norm = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");
    return norm(a) === norm(b);
  }
  return ecosystem === "GitHub Actions" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function matchingAffected(vuln: RawVuln, query: OsvQuery): RawAffected[] {
  return (vuln.affected ?? []).filter(
    (a) =>
      a?.package?.ecosystem === query.ecosystem &&
      typeof a.package.name === "string" &&
      sameName(query.ecosystem, a.package.name, query.name),
  );
}

const SEVERITY_WORDS: Record<string, Severity> = {
  low: "low",
  moderate: "moderate",
  medium: "moderate",
  high: "high",
  critical: "critical",
};

function severityWord(value: unknown): Severity | null {
  return typeof value === "string" ? (SEVERITY_WORDS[value.toLowerCase()] ?? null) : null;
}

const CVSS3_WEIGHTS: Record<string, Record<string, number>> = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  C: { H: 0.56, L: 0.22, N: 0 },
  I: { H: 0.56, L: 0.22, N: 0 },
  A: { H: 0.56, L: 0.22, N: 0 },
};

/** CVSS 3.x's Roundup: the smallest one-decimal number not below the input. */
function roundUp(value: number): number {
  const scaled = Math.round(value * 100_000);
  return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10;
}

/** The base score of a `CVSS:3.x/…` vector, or null when it is not one. */
export function cvss3BaseScore(vector: string): number | null {
  const parts = vector.split("/");
  if (!/^CVSS:3\.[01]$/.test(parts[0] ?? "")) return null;
  const metrics = new Map(parts.slice(1).map((part) => part.split(":") as [string, string]));
  const scope = metrics.get("S");
  const pr = metrics.get("PR");
  const weight = (name: string): number | undefined => CVSS3_WEIGHTS[name]![metrics.get(name)!];
  const prWeight =
    pr === "N"
      ? 0.85
      : pr === "L"
        ? scope === "C"
          ? 0.68
          : 0.62
        : pr === "H"
          ? scope === "C"
            ? 0.5
            : 0.27
          : undefined;
  const [av, ac, ui, c, i, a] = ["AV", "AC", "UI", "C", "I", "A"].map(weight);
  if ((scope !== "U" && scope !== "C") || prWeight === undefined) return null;
  if ([av, ac, ui, c, i, a].some((w) => w === undefined)) return null;
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av! * ac! * prWeight * ui!;
  const total = scope === "U" ? impact + exploitability : 1.08 * (impact + exploitability);
  return roundUp(Math.min(total, 10));
}

function scoreSeverity(score: number): Severity {
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "moderate" : "low";
}

/**
 * The advisory's own rating word (GHSA's `database_specific.severity`), else
 * one on the queried package's entry, else the highest CVSS 3 base score
 * among its vectors, else {@link UNRATED_SEVERITY}.
 */
function readSeverity(vuln: RawVuln, affected: RawAffected[]): Severity {
  const word =
    severityWord(vuln.database_specific?.severity) ??
    affected
      .map(
        (a) =>
          severityWord(a.ecosystem_specific?.severity) ??
          severityWord(a.database_specific?.severity),
      )
      .find((s) => s !== null);
  if (word !== undefined && word !== null) return word;
  const scores = (vuln.severity ?? [])
    .map((s) => (typeof s?.score === "string" ? cvss3BaseScore(s.score) : null))
    .filter((s): s is number => s !== null);
  return scores.length > 0 ? scoreSeverity(Math.max(...scores)) : UNRATED_SEVERITY;
}

/**
 * The first fixed version above the queried one among the package's version
 * ranges, or the lowest fixed version for a commit query, which names no
 * version to compare. Null when no fix has shipped past the queried version.
 */
function readFixedIn(affected: RawAffected[], query: OsvQuery): string | null {
  const scheme = SCHEME[query.ecosystem];
  const fixes = affected
    .flatMap((a) => a.ranges ?? [])
    .filter((r) => r?.type === "SEMVER" || r?.type === "ECOSYSTEM")
    .flatMap((r) => r.events ?? [])
    .map((e) => e?.fixed)
    .filter((fixed): fixed is string => typeof fixed === "string" && fixed !== "")
    .filter((fixed) => "commit" in query || compareVersions(scheme, fixed, query.version) > 0)
    .sort((a, b) => compareVersions(scheme, a, b));
  return fixes[0] ?? null;
}

function readRefs(raw: unknown): Ref[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v: { id?: unknown; modified?: unknown }) =>
    typeof v?.id === "string"
      ? [{ id: v.id, modified: typeof v.modified === "string" ? v.modified : "" }]
      : [],
  );
}

/** Run `task` over `items`, at most `limit` at a time, and stop at the first failure. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<RegistryFailure | null>,
): Promise<RegistryFailure | null> {
  let next = 0;
  let failure: RegistryFailure | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const result = await task(items[next++]!);
      if (result !== null) failure ??= result;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return failure;
}

/**
 * An OSV client. Within one call a query asked twice is sent once; across
 * calls the client keeps advisory detail by id and `modified`, so keep one per
 * process. Any request that fails after back-off fails the whole call.
 */
export function createOsvClient(
  deps: { fetch?: Fetch; clock?: Clock; baseUrl?: string } = {},
): OsvClient {
  const fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const clock = deps.clock ?? systemClock;
  const baseUrl = deps.baseUrl ?? OSV_BASE_URL;
  const http = { fetch, clock, source: "osv" as const };
  const vulns = new Map<string, Promise<RegistryResult<RawVuln>>>();

  function vuln(ref: Ref): Promise<RegistryResult<RawVuln>> {
    const key = `${ref.id}\u0000${ref.modified}`;
    const seen = vulns.get(key);
    if (seen !== undefined) return seen;
    const url = `${baseUrl}/vulns/${encodeURIComponent(ref.id)}`;
    const loaded = requestJson(http, url).then((answer): RegistryResult<RawVuln> => {
      if (!answer.ok) {
        vulns.delete(key);
        return answer;
      }
      return { ok: true, value: answer.value.body as RawVuln };
    });
    vulns.set(key, loaded);
    return loaded;
  }

  /** Every advisory ref for each query, following page tokens. */
  async function batch(queries: readonly OsvQuery[]): Promise<RegistryResult<Ref[][]>> {
    const refs: Ref[][] = queries.map(() => []);
    let pending = queries.map((query, index) => ({
      index,
      query,
      token: undefined as string | undefined,
    }));
    while (pending.length > 0) {
      const following: typeof pending = [];
      for (let start = 0; start < pending.length; start += MAX_BATCH_QUERIES) {
        const chunk = pending.slice(start, start + MAX_BATCH_QUERIES);
        const answer = await requestJson(http, `${baseUrl}/querybatch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ queries: chunk.map((p) => queryBody(p.query, p.token)) }),
        });
        if (!answer.ok) return answer;
        const results = (answer.value.body as { results?: unknown } | null)?.results;
        if (!Array.isArray(results) || results.length !== chunk.length) {
          return {
            ok: false,
            source: "osv",
            error: "querybatch: results do not match the queries",
          };
        }
        chunk.forEach((p, i) => {
          const result = results[i] as { vulns?: unknown; next_page_token?: unknown } | null;
          refs[p.index]!.push(...readRefs(result?.vulns));
          const token = result?.next_page_token;
          if (typeof token === "string" && token !== "") following.push({ ...p, token });
        });
      }
      pending = following;
    }
    return { ok: true, value: refs };
  }

  return {
    async advisories(queries) {
      const unique = new Map<string, OsvQuery>();
      for (const query of queries) unique.set(queryKey(query), query);
      const asked = [...unique.values()];
      const found = await batch(asked);
      if (!found.ok) return found;

      const refs = new Map<string, Ref>();
      for (const ref of found.value.flat()) refs.set(`${ref.id}\u0000${ref.modified}`, ref);
      const details = new Map<string, RawVuln>();
      const failure = await eachLimited(
        [...refs.entries()],
        VULN_CONCURRENCY,
        async ([key, ref]) => {
          const detail = await vuln(ref);
          if (!detail.ok) return detail;
          details.set(key, detail.value);
          return null;
        },
      );
      if (failure !== null) return failure;

      const byQuery = new Map<string, Advisory[]>();
      asked.forEach((query, index) => {
        const seen = new Set<string>();
        const advisories: Advisory[] = [];
        for (const ref of found.value[index]!) {
          if (seen.has(ref.id)) continue;
          seen.add(ref.id);
          const detail = details.get(`${ref.id}\u0000${ref.modified}`)!;
          const affected = matchingAffected(detail, query);
          advisories.push({
            id: ref.id,
            severity: readSeverity(detail, affected),
            fixedIn: readFixedIn(affected, query),
          });
        }
        byQuery.set(queryKey(query), advisories);
      });
      return { ok: true, value: queries.map((query) => byQuery.get(queryKey(query))!) };
    },
  };
}
