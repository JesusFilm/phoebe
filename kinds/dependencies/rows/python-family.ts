// What the uv, poetry and pip rows share. A Python project's current versions
// are the ones it pinned: the lockfile's for a pyproject.toml under uv.lock or
// poetry.lock, the `==` pins of a requirements file. Nothing reads an
// installed environment, since a detector's checkout is read-only and nothing
// installs into it, so `pip list` would describe the machine and not the
// project. The manifest says which packages are direct and of what type.
// Packages list under their PEP 503 name, as uv.lock, pip-audit and
// Renovate's `packageName` all write them, so `PyYAML` lists as `pyyaml`.
//
// TOML goes through the interpreter's own `tomllib` (Python 3.11 and later),
// which turns each file into JSON; uv finds that interpreter when it is
// installed, else `python3` is used. The audit hands every pinned version to
// `pip-audit` as a requirements file of its own, outside the checkout, with
// pip's resolver off, so it installs nothing either.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { DepType } from "../candidate.ts";
import { UNRATED_SEVERITY } from "../registry/osv.ts";
import { compareVersions } from "../registry/versions.ts";
import { dirOf, FindingSet, isRecord, parseJson, str, type Json } from "./common.ts";
import type {
  AuditFinding,
  ListedDependency,
  Manifest,
  RowDeps,
  RowResult,
  ToolOutput,
} from "./row.ts";

/**
 * Reads each TOML file named on the command line and prints one JSON object
 * keyed by path. A lockfile keeps only what the rows read, its members and each
 * package's name, version and source, because the wheel lists are most of it.
 */
export const TOML_SCRIPT = `import json, sys, tomllib
def lock(doc):
    return {
        "members": doc.get("manifest", {}).get("members", []),
        "package": [{k: p[k] for k in ("name", "version", "source") if k in p} for p in doc.get("package", [])],
    }
out = {}
for path in sys.argv[1:]:
    try:
        with open(path, "rb") as f:
            doc = tomllib.load(f)
        out[path] = {"ok": lock(doc) if path.endswith(".lock") else doc}
    except (OSError, ValueError) as e:
        out[path] = {"error": str(e)}
json.dump(out, sys.stdout, default=str)
`;

/** The oldest Python whose standard library reads TOML. */
const PYTHON_REQUEST = ">=3.11";

/**
 * A Python that can read TOML, found once per row: uv's pick when uv is
 * installed, else `python3`. The output's stdout is the command to run it by.
 */
export function pythonFinder(deps: RowDeps): (cwd: string) => Promise<ToolOutput> {
  let found: Promise<ToolOutput> | undefined;
  return (cwd) =>
    (found ??= (async (): Promise<ToolOutput> => {
      const uv = await deps.run("uv", ["python", "find", "--no-project", PYTHON_REQUEST], cwd);
      const path = uv.ok ? uv.stdout.trim() : "";
      if (path.length > 0) return { ok: true, code: 0, stdout: path };
      const python3 = await deps.run("python3", ["--version"], cwd);
      return python3.ok ? { ok: true, code: 0, stdout: "python3" } : python3;
    })());
}

/** Each named TOML file as JSON, keyed by the path it was asked for. */
export async function readToml(
  deps: RowDeps,
  python: string,
  cwd: string,
  paths: readonly string[],
): Promise<RowResult<Map<string, Json>>> {
  const printed = parseJson(await deps.run(python, ["-c", TOML_SCRIPT, ...paths], cwd), "tomllib");
  if (!printed.ok) return printed;
  if (!isRecord(printed.value)) return { ok: false, problem: "tomllib printed no object" };
  const docs = new Map<string, Json>();
  for (const path of paths) {
    const entry = printed.value[path];
    if (isRecord(entry) && isRecord(entry["ok"])) {
      docs.set(path, entry["ok"]);
      continue;
    }
    const error = isRecord(entry) ? str(entry, "error") : undefined;
    return { ok: false, problem: `${path} could not be read (${error ?? "no output"})` };
  }
  return { ok: true, value: docs };
}

/** PEP 503's name: lower case, every run of `-`, `_` and `.` one `-`. */
export function normalName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const NAME_RE = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/;

/** A PEP 508 requirement's name and the rest, or null for a URL requirement or no name at all. */
export function parseRequirement(text: string): { name: string; rest: string } | null {
  const match = NAME_RE.exec(text);
  if (match === null) return null;
  const rest = match[2]!.trim();
  return rest.startsWith("@") ? null : { name: match[1]!, rest };
}

/** The version a requirement pins with `==` or `===`, or null for a range or a wildcard. */
export function pinnedVersion(rest: string): string | null {
  const spec = rest.split(";")[0]!.trim();
  const match = /^===?\s*([0-9][0-9A-Za-z.!+_-]*)$/.exec(spec);
  return match?.[1] ?? null;
}

/** A dependency a manifest declares, before it has a version. */
export type Declared = { name: string; depType: DepType };

function requirementNames(list: unknown, depType: DepType): Declared[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    // A dependency group's `{ include-group = "…" }` lists under its own group.
    const parsed = typeof entry === "string" ? parseRequirement(entry) : null;
    return parsed === null ? [] : [{ name: parsed.name, depType }];
  });
}

function table(doc: Json, ...keys: string[]): Json {
  let value: unknown = doc;
  for (const key of keys) value = isRecord(value) ? value[key] : undefined;
  return isRecord(value) ? value : {};
}

/**
 * What a PEP 621 pyproject.toml declares: `project.dependencies` as
 * production, each extra as optional, and each dependency group, with uv's
 * older `tool.uv.dev-dependencies`, as development.
 */
export function pep621Declared(doc: Json): Declared[] {
  const project = table(doc, "project");
  return [
    ...requirementNames(project["dependencies"], "prod"),
    ...Object.values(table(project, "optional-dependencies")).flatMap((list) =>
      requirementNames(list, "optional"),
    ),
    ...Object.values(table(doc, "dependency-groups")).flatMap((list) =>
      requirementNames(list, "dev"),
    ),
    ...requirementNames(table(doc, "tool", "uv")["dev-dependencies"], "dev"),
  ];
}

/** A poetry declaration no registry serves: a path, a git repository, a URL. */
function poetryRegistry(spec: unknown): boolean {
  if (typeof spec === "string") return true;
  if (Array.isArray(spec)) return spec.some(poetryRegistry);
  return isRecord(spec) && !["path", "git", "url", "file"].some((key) => key in spec);
}

function poetryTable(deps: Json, depType: DepType): Declared[] {
  return Object.entries(deps).flatMap(([name, spec]) => {
    if (name.toLowerCase() === "python" || !poetryRegistry(spec)) return [];
    const optional = isRecord(spec) && spec["optional"] === true;
    return [{ name, depType: optional && depType === "prod" ? "optional" : depType }];
  });
}

/**
 * What a poetry pyproject.toml declares: `tool.poetry.dependencies` as
 * production (an `optional` one as optional), every other group and the old
 * `dev-dependencies` as development, and Poetry 2's PEP 621 tables as
 * {@link pep621Declared} reads them.
 */
export function poetryDeclared(doc: Json): Declared[] {
  const poetry = table(doc, "tool", "poetry");
  const groups = Object.entries(table(poetry, "group")).flatMap(([group, body]) =>
    poetryTable(
      table(isRecord(body) ? body : {}, "dependencies"),
      group === "main" ? "prod" : "dev",
    ),
  );
  return [
    ...pep621Declared(doc),
    ...poetryTable(table(poetry, "dependencies"), "prod"),
    ...poetryTable(table(poetry, "dev-dependencies"), "dev"),
    ...groups,
  ];
}

/** A lockfile's versions by normalised name: the registry ones, and whether any came from elsewhere. */
export type Locked = Map<string, { registry: string[]; elsewhere: boolean }>;

/** One lockfile package entry, and whether a registry served it. */
export type LockEntry = { name: string; version: string; registry: boolean };

export function lockEntries(lock: Json, isRegistry: (source: unknown) => boolean): LockEntry[] {
  const packages = Array.isArray(lock["package"]) ? lock["package"] : [];
  return packages.flatMap((p) => {
    const name = isRecord(p) ? str(p, "name") : undefined;
    const version = isRecord(p) ? str(p, "version") : undefined;
    if (name === undefined || version === undefined) return [];
    return [{ name, version, registry: isRegistry(p["source"]) }];
  });
}

export function lockedVersions(entries: readonly LockEntry[]): Locked {
  const locked: Locked = new Map();
  for (const entry of entries) {
    const key = normalName(entry.name);
    const slot = locked.get(key) ?? { registry: [], elsewhere: false };
    if (entry.registry) slot.registry.push(entry.version);
    else slot.elsewhere = true;
    locked.set(key, slot);
  }
  return locked;
}

/**
 * Each declared dependency with every version the lockfile holds for it,
 * which is more than one when uv or poetry split the resolution by marker. A
 * dependency the lockfile has only from a path, git or a sibling workspace
 * package is not listed; one the lockfile lacks is counted in the log.
 */
export function listLocked(
  declared: ReadonlyMap<string, readonly Declared[]>,
  locked: Locked,
  unresolved: string[],
): ListedDependency[] {
  const listed = new Map<string, ListedDependency>();
  for (const [workspace, list] of declared) {
    for (const { name, depType } of list) {
      const slot = locked.get(normalName(name));
      if (slot === undefined || (slot.registry.length === 0 && !slot.elsewhere)) {
        unresolved.push(`${workspace}: ${name}`);
        continue;
      }
      for (const current of slot.registry) {
        const entry = { package: normalName(name), current, depType, workspace };
        listed.set(JSON.stringify(entry), entry);
      }
    }
  }
  return [...listed.values()];
}

/** The project root as a working directory, and a checkout path as a path under it. */
export function underRoot(manifest: Manifest): {
  cwd: string;
  relativePath: (path: string) => string;
} {
  const root = dirOf(manifest.path);
  return { cwd: join(manifest.checkout, root), relativePath: (path) => posix.relative(root, path) };
}

// ---------------------------------------------------------------------------
// The audit

/**
 * `pip-audit --format json` over the pinned versions: one dependency per pin,
 * each with the advisories against it and the versions that fix each. It
 * rates no severity, so a finding is unrated until OSV, which wins an id both
 * report, says otherwise.
 */
export function addPipAuditReport(set: FindingSet, report: unknown): boolean {
  const dependencies = isRecord(report) ? report["dependencies"] : undefined;
  if (!Array.isArray(dependencies)) return false;
  for (const dependency of dependencies) {
    if (!isRecord(dependency)) continue;
    const name = str(dependency, "name");
    const version = str(dependency, "version");
    const vulns = Array.isArray(dependency["vulns"]) ? dependency["vulns"] : [];
    for (const vuln of vulns) {
      const id = isRecord(vuln) ? str(vuln, "id") : undefined;
      if (name === undefined || version === undefined || id === undefined) {
        set.dropped += 1;
        continue;
      }
      const fixes = Array.isArray(vuln["fix_versions"]) ? vuln["fix_versions"] : [];
      const fixedIn =
        fixes
          .filter((fix): fix is string => typeof fix === "string")
          .filter((fix) => compareVersions("pep440", fix, version) > 0)
          .sort((a, b) => compareVersions("pep440", a, b))[0] ?? null;
      set.add(normalName(name), version, { id, severity: UNRATED_SEVERITY, fixedIn });
    }
  }
  return true;
}

export const PIP_AUDIT_ARGS = [
  "--disable-pip",
  "--no-deps",
  "--progress-spinner",
  "off",
  "--format",
  "json",
  "-r",
] as const;

/**
 * The pip-audit every Python row runs over a project's pins. A pip-audit
 * that is not installed audits nothing and says so once per row, which leaves
 * the project to OSV alone.
 */
export function pipAuditor(
  deps: RowDeps,
  rowName: string,
): (
  cwd: string,
  pins: readonly { name: string; version: string }[],
) => Promise<RowResult<AuditFinding[]>> {
  let missingLogged = false;
  return async (cwd, pins) => {
    const lines = [...new Set(pins.map((p) => `${normalName(p.name)}==${p.version}`))].sort();
    const dir = mkdtempSync(join(tmpdir(), "phoebe-pip-audit-"));
    const file = join(dir, "requirements.txt");
    let output: ToolOutput;
    try {
      writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
      output = await deps.run("pip-audit", [...PIP_AUDIT_ARGS, file], cwd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (!output.ok && output.missing) {
      if (!missingLogged) deps.log(`${rowName} row: pip-audit is not installed; OSV alone.`);
      missingLogged = true;
      return { ok: true, value: [] };
    }
    const audited = parseJson(output, "pip-audit");
    if (!audited.ok) return audited;
    const set = new FindingSet();
    if (!addPipAuditReport(set, audited.value)) {
      return { ok: false, problem: "pip-audit printed no dependencies" };
    }
    if (set.dropped > 0) {
      deps.log(`${rowName} row: dropped ${set.dropped} pip-audit record(s) with no id or version.`);
    }
    return { ok: true, value: set.findings };
  };
}
