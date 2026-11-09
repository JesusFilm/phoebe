// What every row family shares: reading the tools' JSON, walking the checkout
// for projects, collecting audit findings, and reading the SemVer ranges npm
// and Cargo advisories are written in.

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Advisory } from "../candidate.ts";
import { compareVersions } from "../registry/versions.ts";
import type { AuditFinding, Manifest, RowDeps, RowResult, ToolOutput } from "./row.ts";

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-blank string field, trimmed. */
export function str(record: Json, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** A path under the checkout as the contract writes it: relative, with `/`. */
export function checkoutPath(checkout: string, absolute: string): string | null {
  const rel = toPosix(relative(checkout, absolute));
  return rel === ".." || rel.startsWith("../") ? null : rel;
}

/** `dir/file`, or `file` for the checkout's own root. */
export function fileIn(dir: string, file: string): string {
  return dir === "" || dir === "." ? file : `${dir}/${file}`;
}

/** The directory a manifest path names, `""` for the root. */
export function dirOf(manifestPath: string): string {
  const slash = manifestPath.lastIndexOf("/");
  return slash < 0 ? "" : manifestPath.slice(0, slash);
}

/**
 * Every directory under the checkout `isProject` accepts, relative to it (`""`
 * for the root), in path order, so a workspace root comes before its members.
 * Dot directories, `node_modules` and the names in `skip` are not searched.
 */
export function findDirs(
  checkout: string,
  isProject: (dir: string) => boolean,
  skip: readonly string[] = [],
): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (isProject(dir)) found.push(toPosix(relative(checkout, dir)));
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === "node_modules" ||
        entry.name.startsWith(".") ||
        skip.includes(entry.name)
      ) {
        continue;
      }
      walk(join(dir, entry.name));
    }
  };
  walk(checkout);
  return found.sort();
}

type Unavailable = { missing: boolean; problem: string };

export type RootProbe = {
  /** The manifest file at each root: `package.json`, `Cargo.toml`. */
  manifest: string;
  /** Runs the row's tool in the root, as `<tool> --version` does. */
  probe: (root: string) => Promise<ToolOutput>;
  /**
   * The root's workspace manifests, given the probe's trimmed stdout. Null for
   * a root that turns out to belong to another project, which is skipped.
   */
  workspacesOf: (root: string, probed: string) => Promise<RowResult<string[] | null>>;
};

/**
 * Claim each project root whose tool runs, with its workspace manifests. A
 * tool that will not run claims nothing and is logged once for the whole
 * checkout, so its manifests go to the agent fallback.
 */
export async function detectRoots(
  deps: RowDeps,
  rowName: string,
  checkout: string,
  roots: readonly string[],
  { manifest, probe, workspacesOf }: RootProbe,
): Promise<Manifest[]> {
  const manifests: Manifest[] = [];
  const unavailable: Unavailable[] = [];
  const failed: string[] = [];
  let skipped = 0;
  for (const root of roots) {
    const probed = await probe(root);
    if (!probed.ok) {
      unavailable.push(probed);
      // Missing is missing everywhere; a pinned version that will not fetch is per project.
      if (probed.missing) break;
      continue;
    }
    const path = fileIn(root, manifest);
    const workspaces = await workspacesOf(root, probed.stdout.trim());
    if (!workspaces.ok) {
      failed.push(`${path}: ${workspaces.problem}`);
      continue;
    }
    if (workspaces.value === null) {
      skipped += 1;
      continue;
    }
    const rest = workspaces.value.filter((w) => w !== path).sort();
    manifests.push({ checkout, path, workspaces: [path, ...new Set(rest)] });
  }
  if (unavailable.length > 0) {
    const missing = unavailable.find((u) => u.missing);
    const left = roots.length - manifests.length - failed.length - skipped;
    deps.log(
      `${rowName} row: ${missing?.problem ?? unavailable[0]!.problem}; ` +
        `${left} project(s) left to the agent fallback.`,
    );
  }
  for (const line of failed) {
    deps.log(
      `${rowName} row: could not read the workspaces of ${line}; left to the agent fallback.`,
    );
  }
  return manifests;
}

/** A JSON document, or why the tool's output is not one. */
export function parseJson(output: ToolOutput, what: string): RowResult<unknown> {
  if (!output.ok) return { ok: false, problem: output.problem };
  try {
    return { ok: true, value: JSON.parse(output.stdout) as unknown };
  } catch (error) {
    return {
      ok: false,
      problem: `${what} is not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/**
 * One log line counting the declared dependencies a listing found no version
 * for, since a declared dependency the lockfile lacks means the lockfile is out
 * of date.
 */
export function logUnresolved(
  log: RowDeps["log"],
  rowName: string,
  root: string,
  unresolved: readonly string[],
): void {
  if (unresolved.length === 0) return;
  log(
    `${rowName} row: ${unresolved.length} declared dependenc${unresolved.length === 1 ? "y" : "ies"} ` +
      `with no resolved version under ${root} (${unresolved.slice(0, 3).join(", ")}` +
      `${unresolved.length > 3 ? ", …" : ""}).`,
  );
}

/** Findings, one per package, version and advisory id, in the order first seen. */
export class FindingSet {
  private readonly byKey = new Map<string, AuditFinding>();
  dropped = 0;

  /** Record a finding; the same one added twice keeps the first advisory and every ancestor. */
  add(pkg: string, version: string, advisory: Advisory, ancestors?: readonly string[]): void {
    const key = JSON.stringify([pkg, version, advisory.id]);
    const seen = this.byKey.get(key);
    const finding: AuditFinding = seen ?? { package: pkg, version, advisory };
    if (ancestors !== undefined) {
      finding.ancestors = [...new Set([...(finding.ancestors ?? []), ...ancestors])];
    }
    if (seen === undefined) this.byKey.set(key, finding);
  }

  get findings(): AuditFinding[] {
    return [...this.byKey.values()];
  }
}

// ---------------------------------------------------------------------------
// SemVer ranges

type Comparator = { op: string; version: string };

const COMPARATOR_RE = /(<=|>=|<|>|=)?\s*v?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/g;

function alternatives(range: string): Comparator[][] {
  return range
    .split("||")
    .map((alt) =>
      [...alt.matchAll(COMPARATOR_RE)].map((m) => ({ op: m[1] ?? "=", version: m[2]! })),
    )
    .filter((alt) => alt.length > 0);
}

function satisfies(alt: readonly Comparator[], version: string): boolean {
  return alt.every(({ op, version: bound }) => {
    const order = compareVersions("semver", version, bound);
    if (op === "<") return order < 0;
    if (op === "<=") return order <= 0;
    if (op === ">") return order > 0;
    if (op === ">=") return order >= 0;
    return order === 0;
  });
}

/** Whether a version is in a range, or null for a range this cannot read. */
export function inRange(range: string, version: string): boolean | null {
  const alts = alternatives(range);
  return alts.length === 0 ? null : alts.some((alt) => satisfies(alt, version));
}

/**
 * The first fixed version from a vulnerable range: the exclusive upper bound
 * of the part the installed version falls in. `<=` names the last vulnerable
 * version and no fix, which is how GitHub writes an advisory with none.
 */
export function fixedFromVulnerable(range: string, version: string): string | null {
  const alt = alternatives(range).find((a) => satisfies(a, version));
  return alt?.find((c) => c.op === "<")?.version ?? null;
}

/**
 * The first fixed version from a patched range: its lowest lower bound past
 * the installed one. A Cargo requirement's `^1.6.1` reads as the bound 1.6.1.
 */
export function fixedFromPatched(range: string, version: string): string | null {
  const bounds = alternatives(range)
    .flatMap((alt) => alt.filter((c) => c.op === ">=" || c.op === "="))
    .map((c) => c.version)
    .filter((bound) => compareVersions("semver", bound, version) > 0)
    .sort((a, b) => compareVersions("semver", a, b));
  return bounds[0] ?? null;
}
