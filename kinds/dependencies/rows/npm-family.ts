// What the pnpm, npm and yarn rows share. A project is a directory holding a
// package.json and a lockfile, and its manager is the one `packageManager`
// names, else the one whose lockfile is there. The manifests say which
// dependencies are direct and of what type; the manager's tool says which
// version the lockfile resolved each to. Every listing runs off the lockfile,
// because a detector's checkout is read-only and nothing installs into it.
//
// All three managers audit against the same GitHub advisory database, in three
// output shapes, normalised here to the candidate's advisory with its GHSA id,
// the id OSV reports these advisories under, so the two union by id.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SEVERITIES, type Advisory, type DepType, type Severity } from "../candidate.ts";
import { UNRATED_SEVERITY } from "../registry/osv.ts";
import { compareVersions } from "../registry/versions.ts";
import type {
  AuditFinding,
  ListedDependency,
  Manifest,
  RowDeps,
  RowResult,
  ToolOutput,
} from "./row.ts";

export type NpmManager = "pnpm" | "npm" | "yarn";

/** Renovate's manager for every package.json, whichever tool installs it. */
export const NPM_MANAGER = "npm";

/** Lockfiles in the order that settles a directory holding more than one. */
const LOCKFILES: readonly (readonly [string, NpmManager])[] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const SECTIONS: readonly (readonly [string, DepType])[] = [
  ["dependencies", "prod"],
  ["devDependencies", "dev"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
];

/** A version a registry serves, as opposed to `link:../..` or a git ref. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** A path under the checkout as the contract writes it: relative, with `/`. */
export function checkoutPath(checkout: string, absolute: string): string | null {
  const rel = toPosix(relative(checkout, absolute));
  return rel.startsWith("..") ? null : rel;
}

/** `dir/package.json`, or `package.json` for the checkout's own root. */
export function manifestIn(dir: string): string {
  return dir === "" || dir === "." ? "package.json" : `${dir}/package.json`;
}

/** The directory a manifest path names, `""` for the root. */
export function dirOf(manifestPath: string): string {
  const slash = manifestPath.lastIndexOf("/");
  return slash < 0 ? "" : manifestPath.slice(0, slash);
}

function readJson(path: string): Json | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The manager a project directory belongs to, or null when it is not one. */
function managerOf(dir: string): NpmManager | null {
  const manifest = readJson(join(dir, "package.json"));
  if (manifest === null) return null;
  const lockfiles = LOCKFILES.filter(([file]) => existsSync(join(dir, file)));
  if (lockfiles.length === 0) return null;
  const pinned = typeof manifest["packageManager"] === "string" ? manifest["packageManager"] : "";
  const named = LOCKFILES.find(([, manager]) => pinned.startsWith(`${manager}@`));
  return named?.[1] ?? lockfiles[0]![1];
}

/**
 * Every project directory under the checkout that `manager` owns, relative to
 * it (`""` for the root), in path order. Installed packages and dot
 * directories are not searched.
 */
export function findProjects(checkout: string, manager: NpmManager): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (managerOf(dir) === manager) found.push(toPosix(relative(checkout, dir)));
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      walk(join(dir, entry.name));
    }
  };
  walk(checkout);
  return found.sort();
}

/** Whether a project's manifest declares workspaces, as npm and yarn read it. */
export function declaresWorkspaces(checkout: string, root: string): boolean {
  const workspaces = readJson(join(checkout, manifestIn(root)))?.["workspaces"];
  return Array.isArray(workspaces) || isRecord(workspaces);
}

/** One manifest's package name and declared dependencies. */
type Declared = {
  name: string | undefined;
  dependencies: { name: string; package: string; depType: DepType }[];
};

/**
 * The registry package a declaration resolves to, or null for one no registry
 * serves: `workspace:`, `link:`, `file:`, a git URL, a `user/repo` shorthand.
 * An `npm:` alias resolves to the package it names.
 */
export function registryPackage(name: string, spec: string): string | null {
  const value = spec.trim();
  if (value.startsWith("npm:")) {
    const target = value.slice("npm:".length);
    const at = target.indexOf("@", target.startsWith("@") ? 1 : 0);
    return at > 0 ? target.slice(0, at) : name;
  }
  if (value.startsWith("catalog:")) return name;
  return value.includes(":") || value.includes("/") ? null : name;
}

function readDeclared(checkout: string, manifestPath: string): Declared | null {
  const manifest = readJson(join(checkout, manifestPath));
  if (manifest === null) return null;
  const dependencies: Declared["dependencies"] = [];
  for (const [section, depType] of SECTIONS) {
    const declared = manifest[section];
    if (!isRecord(declared)) continue;
    for (const [name, spec] of Object.entries(declared)) {
      if (typeof spec !== "string") continue;
      const pkg = registryPackage(name, spec);
      if (pkg !== null) dependencies.push({ name, package: pkg, depType });
    }
  }
  const name = typeof manifest["name"] === "string" ? manifest["name"] : undefined;
  return { name, dependencies };
}

/** A workspace package as the version lookup sees it. */
export type WorkspaceRef = { path: string; name: string | undefined; root: boolean };

/**
 * The manifest's declared dependencies with the version the tool resolved for
 * each. A dependency on another workspace package of the same project is not
 * listed, nor is one the tool resolved to no registry version; the second
 * is counted in one log line, since a declared dependency the lockfile lacks
 * means the lockfile is out of date.
 */
export function listDeclared(
  manifest: Manifest,
  versionOf: (workspace: WorkspaceRef, name: string) => string | undefined,
  log: RowDeps["log"],
  rowName: string,
): RowResult<ListedDependency[]> {
  const declared = new Map<string, Declared>();
  for (const path of manifest.workspaces) {
    const read = readDeclared(manifest.checkout, path);
    if (read === null) return { ok: false, problem: `${path} is not a readable package.json` };
    declared.set(path, read);
  }
  const siblings = new Set([...declared.values()].flatMap((d) => (d.name ? [d.name] : [])));
  const listed: ListedDependency[] = [];
  const unresolved: string[] = [];
  for (const [path, { name, dependencies }] of declared) {
    const ref: WorkspaceRef = { path, name, root: path === manifest.path };
    for (const dependency of dependencies) {
      if (siblings.has(dependency.package)) continue;
      const version = versionOf(ref, dependency.name);
      if (version === undefined || !VERSION_RE.test(version)) {
        if (dependency.depType !== "peer") unresolved.push(`${path}: ${dependency.name}`);
        continue;
      }
      listed.push({
        package: dependency.package,
        current: version,
        depType: dependency.depType,
        workspace: path,
      });
    }
  }
  if (unresolved.length > 0) {
    log(
      `${rowName} row: ${unresolved.length} declared dependenc${unresolved.length === 1 ? "y" : "ies"} ` +
        `with no resolved version under ${manifest.path} (${unresolved.slice(0, 3).join(", ")}` +
        `${unresolved.length > 3 ? ", …" : ""}).`,
    );
  }
  return { ok: true, value: listed };
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

/** One JSON value per line, as yarn prints. Lines that are not JSON are skipped. */
export function parseJsonLines(output: ToolOutput): RowResult<unknown[]> {
  if (!output.ok) return { ok: false, problem: output.problem };
  const values: unknown[] = [];
  for (const line of output.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // A progress line or a warning, not a record.
    }
  }
  return { ok: true, value: values };
}

/** The error a tool reported in its JSON output, as pnpm and npm do. */
export function reportedError(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value["error"])) return null;
  const error = value["error"];
  const message = typeof error["message"] === "string" ? error["message"] : undefined;
  const code = typeof error["code"] === "string" ? error["code"] : undefined;
  return [code, message].filter(Boolean).join(": ") || "an error with no message";
}

type Unavailable = { missing: boolean; problem: string };

/**
 * The detect every npm-family row runs: find the manager's projects, check its
 * tool runs in each, and ask for each project's workspace packages. A tool
 * that will not run claims nothing and is logged once for the whole checkout,
 * so its manifests go to the agent fallback.
 */
export async function detectProjects(
  deps: RowDeps,
  manager: NpmManager,
  checkout: string,
  workspacesOf: (root: string, version: string) => Promise<RowResult<string[]>>,
): Promise<Manifest[]> {
  const roots = findProjects(checkout, manager);
  const manifests: Manifest[] = [];
  const unavailable: Unavailable[] = [];
  const failed: string[] = [];
  for (const root of roots) {
    const version = await deps.run(manager, ["--version"], join(checkout, root));
    if (!version.ok) {
      unavailable.push(version);
      // Missing is missing everywhere; a pinned version that will not fetch is per project.
      if (version.missing) break;
      continue;
    }
    const workspaces = await workspacesOf(root, version.stdout.trim());
    if (!workspaces.ok) {
      failed.push(`${manifestIn(root)}: ${workspaces.problem}`);
      continue;
    }
    const path = manifestIn(root);
    const rest = workspaces.value.filter((w) => w !== path).sort();
    manifests.push({ checkout, path, workspaces: [path, ...new Set(rest)] });
  }
  if (unavailable.length > 0) {
    const missing = unavailable.find((u) => u.missing);
    const left = roots.length - manifests.length - failed.length;
    deps.log(
      `${manager} row: ${missing?.problem ?? unavailable[0]!.problem}; ` +
        `${left} project(s) left to the agent fallback.`,
    );
  }
  for (const line of failed) {
    deps.log(
      `${manager} row: could not read the workspaces of ${line}; left to the agent fallback.`,
    );
  }
  return manifests;
}

// ---------------------------------------------------------------------------
// Advisories

/** The GHSA id, which is what OSV lists these advisories under. */
function ghsaId(record: Json, urlKey: string, idKey?: string): string | null {
  const id = idKey !== undefined ? record[idKey] : undefined;
  if (typeof id === "string" && id.startsWith("GHSA-")) return id;
  const url = record[urlKey];
  if (typeof url !== "string") return null;
  return /\/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})\b/.exec(url)?.[1] ?? null;
}

/** npm's severity words, `info` included, as the contract's. */
function severity(value: unknown): Severity {
  if (typeof value !== "string") return UNRATED_SEVERITY;
  const word = value.toLowerCase();
  if (word === "info") return "low";
  return (SEVERITIES as readonly string[]).includes(word) ? (word as Severity) : UNRATED_SEVERITY;
}

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

/** The first fixed version from a patched range: its lowest lower bound past the installed one. */
export function fixedFromPatched(range: string, version: string): string | null {
  const bounds = alternatives(range)
    .flatMap((alt) => alt.filter((c) => c.op === ">=" || c.op === "="))
    .map((c) => c.version)
    .filter((bound) => compareVersions("semver", bound, version) > 0)
    .sort((a, b) => compareVersions("semver", a, b));
  return bounds[0] ?? null;
}

function str(record: Json, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Findings, one per package, version and advisory id, in the order first seen. */
export class FindingSet {
  private readonly byKey = new Map<string, AuditFinding>();
  dropped = 0;

  add(pkg: string, version: string, advisory: Advisory): void {
    const key = JSON.stringify([pkg, version, advisory.id]);
    if (!this.byKey.has(key)) this.byKey.set(key, { package: pkg, version, advisory });
  }

  get findings(): AuditFinding[] {
    return [...this.byKey.values()];
  }
}

/**
 * The advisory shape the old npm audit endpoint answers with, which `pnpm
 * audit` and `yarn audit` (classic) print: a module, its vulnerable and patched
 * ranges, and a finding per installed version.
 */
export function addNpmAdvisory(set: FindingSet, advisory: unknown): void {
  if (!isRecord(advisory)) return;
  const pkg = str(advisory, "module_name");
  const id = ghsaId(advisory, "url", "github_advisory_id");
  if (pkg === undefined || id === null) {
    set.dropped += 1;
    return;
  }
  const findings = Array.isArray(advisory["findings"]) ? advisory["findings"] : [];
  const patched = str(advisory, "patched_versions");
  const vulnerable = str(advisory, "vulnerable_versions");
  for (const finding of findings) {
    const version = isRecord(finding) ? str(finding, "version") : undefined;
    if (version === undefined) continue;
    const fixedIn =
      patched !== undefined
        ? fixedFromPatched(patched, version)
        : vulnerable !== undefined
          ? fixedFromVulnerable(vulnerable, version)
          : null;
    set.add(pkg, version, { id, severity: severity(advisory["severity"]), fixedIn });
  }
}

/**
 * `npm audit --json` (report version 2): advisories hang off each vulnerable
 * package's `via`, and its installed versions are the lockfile's entries for
 * the `nodes` it names.
 */
export function addNpmAuditReport(
  set: FindingSet,
  vulnerabilities: Json,
  lockPackages: Json,
): void {
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!isRecord(entry)) continue;
    const nodes = Array.isArray(entry["nodes"]) ? entry["nodes"] : [];
    const versions = new Set<string>();
    for (const node of nodes) {
      const locked = typeof node === "string" ? lockPackages[node] : undefined;
      const version = isRecord(locked) ? str(locked, "version") : undefined;
      if (version !== undefined) versions.add(version);
    }
    const via = Array.isArray(entry["via"]) ? entry["via"] : [];
    for (const source of via) {
      // A string names another vulnerable package this one depends on.
      if (!isRecord(source) || str(source, "name") !== name) continue;
      const id = ghsaId(source, "url");
      const range = str(source, "range");
      if (id === null || range === undefined) {
        set.dropped += 1;
        continue;
      }
      for (const version of versions) {
        if (inRange(range, version) === false) continue;
        set.add(name, version, {
          id,
          severity: severity(source["severity"]),
          fixedIn: fixedFromVulnerable(range, version),
        });
      }
    }
  }
}

/** One record of `yarn npm audit --json` (yarn 4): a package and the versions in the tree. */
export function addYarnAuditRecord(set: FindingSet, record: unknown): void {
  if (!isRecord(record) || !isRecord(record["children"])) return;
  const pkg = str(record, "value");
  const detail = record["children"];
  const id = ghsaId(detail, "URL");
  const range = str(detail, "Vulnerable Versions");
  if (pkg === undefined || id === null || range === undefined) {
    set.dropped += 1;
    return;
  }
  const versions = Array.isArray(detail["Tree Versions"]) ? detail["Tree Versions"] : [];
  for (const version of versions) {
    if (typeof version !== "string") continue;
    set.add(pkg, version, {
      id,
      severity: severity(detail["Severity"]),
      fixedIn: fixedFromVulnerable(range, version),
    });
  }
}

/** The audit's findings, logging any advisory it could not read. */
export function auditResult(
  set: FindingSet,
  log: RowDeps["log"],
  rowName: string,
): RowResult<AuditFinding[]> {
  if (set.dropped > 0) {
    log(
      `${rowName} row: dropped ${set.dropped} audit advisory record(s) with no GHSA id or range.`,
    );
  }
  return { ok: true, value: set.findings };
}
