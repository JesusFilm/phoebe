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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES, type DepType, type Severity } from "../candidate.ts";
import { UNRATED_SEVERITY } from "../registry/osv.ts";
import {
  detectRoots,
  findDirs,
  fileIn,
  FindingSet,
  fixedFromPatched,
  fixedFromVulnerable,
  inRange,
  isRecord,
  logUnresolved,
  str,
  type Json,
} from "./common.ts";
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

/** `dir/package.json`, or `package.json` for the checkout's own root. */
export function manifestIn(dir: string): string {
  return fileIn(dir, "package.json");
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
  return findDirs(checkout, (dir) => managerOf(dir) === manager);
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
    return at > 0
      ? target.slice(0, at)
      : /^[\w@]/.test(target) && !/^\d/.test(target)
        ? target
        : name;
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
      if (
        depType !== "optional" &&
        isRecord(manifest["optionalDependencies"]) &&
        name in manifest["optionalDependencies"] &&
        depType !== "peer"
      )
        continue;
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
  logUnresolved(log, rowName, manifest.path, unresolved);
  return { ok: true, value: listed };
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

/**
 * The detect every npm-family row runs: find the manager's projects, check its
 * tool runs in each, and ask for each project's workspace packages.
 */
export function detectProjects(
  deps: RowDeps,
  manager: NpmManager,
  checkout: string,
  workspacesOf: (root: string, version: string) => Promise<RowResult<string[]>>,
): Promise<Manifest[]> {
  return detectRoots(deps, manager, checkout, findProjects(checkout, manager), {
    manifest: "package.json",
    probe: (root) => deps.run(manager, ["--version"], join(checkout, root)),
    workspacesOf,
  });
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

/**
 * Every package on a finding's paths but the last, which is the package
 * itself. pnpm opens each path with the importer (`.`, `apps__web`), yarn
 * classic with the direct dependency; the native source keeps only names the
 * project lists, so the importer drops out there.
 */
function pathAncestors(paths: unknown): string[] | undefined {
  if (!Array.isArray(paths)) return undefined;
  const names = paths
    .filter((path): path is string => typeof path === "string")
    .flatMap((path) =>
      path
        .split(">")
        .map((name) => name.trim())
        .slice(0, -1),
    );
  return [...new Set(names.filter((name) => name !== ""))];
}

/**
 * The advisory shape the old npm audit endpoint answers with, which `pnpm
 * audit` and `yarn audit` (classic) print: a module, its vulnerable and patched
 * ranges, and a finding per installed version with the paths that reach it.
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
    const ancestors = pathAncestors((finding as Json)["paths"]);
    const fixedIn =
      patched !== undefined
        ? fixedFromPatched(patched, version)
        : vulnerable !== undefined
          ? fixedFromVulnerable(vulnerable, version)
          : null;
    set.add(pkg, version, { id, severity: severity(advisory["severity"]), fixedIn }, ancestors);
  }
}

/**
 * Every package npm's report says is vulnerable through `name`: the closure
 * of `effects`, which names the packages that depend on a vulnerable one.
 * npm marks each of them vulnerable in turn, up to the direct dependency.
 */
function effectsClosure(vulnerabilities: Json, name: string): string[] {
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const entry = vulnerabilities[queue.pop()!];
    const effects = isRecord(entry) && Array.isArray(entry["effects"]) ? entry["effects"] : [];
    for (const effect of effects) {
      if (typeof effect === "string" && effect !== name && !seen.has(effect)) {
        seen.add(effect);
        queue.push(effect);
      }
    }
  }
  return [...seen];
}

/**
 * `npm audit --json` (report version 2): advisories hang off each vulnerable
 * package's `via`, its installed versions are the lockfile's entries for the
 * `nodes` it names, and the packages that reach it are its `effects`.
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
    const ancestors = effectsClosure(vulnerabilities, name);
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
        set.add(
          name,
          version,
          {
            id,
            severity: severity(source["severity"]),
            fixedIn: fixedFromVulnerable(range, version),
          },
          ancestors,
        );
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
