// The Python rows, one per file kind Renovate names a manager for, so a
// native candidate and a Renovate one for the same bump merge: `pep621` for a
// pyproject.toml under uv.lock, `poetry` for one under poetry.lock, and
// `pip_requirements` for a requirements file. A pyproject.toml with no
// lockfile pins nothing and is left to the agent fallback.
//
// uv.lock names a workspace's members and the directory each lives in, so a
// uv project covers every member's pyproject.toml. Poetry has no workspaces.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  detectRoots,
  dirOf,
  fileIn,
  findDirs,
  isRecord,
  logUnresolved,
  str,
  type Json,
} from "./common.ts";
import {
  listLocked,
  lockedVersions,
  lockEntries,
  normalName,
  parseRequirement,
  pep621Declared,
  pinnedVersion,
  pipAuditor,
  poetryDeclared,
  pythonFinder,
  readToml,
  underRoot,
  type Declared,
} from "./python-family.ts";
import type { ListedDependency, Manifest, Row, RowDeps } from "./row.ts";

/** Directories that hold installed packages or bytecode, never a project. */
const SKIP = ["__pycache__", "site-packages"];

type LockedRow = {
  name: string;
  manager: string;
  lockfile: string;
  declared: (pyproject: Json) => Declared[];
  isRegistry: (source: unknown) => boolean;
  /** The member directories the lockfile names, relative to the project root. */
  members: (lock: Json) => string[];
};

function lockedRow(deps: RowDeps, spec: LockedRow): Row {
  const findPython = pythonFinder(deps);
  const audit = pipAuditor(deps, spec.name);

  const readProject = async (manifest: Manifest, paths: readonly string[]) => {
    const { cwd } = underRoot(manifest);
    const python = await findPython(cwd);
    if (!python.ok) return { ok: false as const, problem: python.problem };
    return readToml(deps, python.stdout, cwd, [...paths, spec.lockfile]);
  };

  return {
    name: spec.name,
    manager: spec.manager,
    system: "pypi",
    ecosystem: "PyPI",

    detect(checkout) {
      const roots = findDirs(
        checkout,
        (dir) =>
          existsSync(join(dir, "pyproject.toml")) &&
          existsSync(join(dir, spec.lockfile)) &&
          // uv.lock beside poetry.lock is a project moving to uv.
          !(spec.lockfile === "poetry.lock" && existsSync(join(dir, "uv.lock"))),
        SKIP,
      );
      return detectRoots(deps, spec.name, checkout, roots, {
        manifest: "pyproject.toml",
        probe: (root) => findPython(join(checkout, root)),
        async workspacesOf(root, python) {
          const read = await readToml(deps, python, join(checkout, root), [spec.lockfile]);
          if (!read.ok) return read;
          const paths = spec.members(read.value.get(spec.lockfile)!).flatMap((dir) => {
            const joined = posix.normalize(posix.join(root || ".", dir));
            return joined.startsWith("..") ? [] : [fileIn(joined, "pyproject.toml")];
          });
          return { ok: true, value: paths };
        },
      });
    },

    async list(manifest) {
      const { relativePath } = underRoot(manifest);
      const paths = manifest.workspaces.map(relativePath);
      const read = await readProject(manifest, paths);
      if (!read.ok) return read;
      const declared = new Map(
        manifest.workspaces.map((workspace, i) => [
          workspace,
          spec.declared(read.value.get(paths[i]!)!),
        ]),
      );
      const locked = lockedVersions(lockEntries(read.value.get(spec.lockfile)!, spec.isRegistry));
      const unresolved: string[] = [];
      const listed = listLocked(declared, locked, unresolved);
      logUnresolved(deps.log, spec.name, manifest.path, unresolved);
      return { ok: true, value: listed };
    },

    async audit(manifest) {
      const read = await readProject(manifest, []);
      if (!read.ok) return read;
      const pins = lockEntries(read.value.get(spec.lockfile)!, spec.isRegistry).filter(
        (entry) => entry.registry,
      );
      return audit(underRoot(manifest).cwd, pins);
    },
  };
}

/**
 * uv's workspace members, from `[manifest] members` and the editable or
 * virtual source each member's package entry carries. A project with no
 * members table is its root alone; any other local package is a path
 * dependency, not a member.
 */
function uvMembers(lock: Json): string[] {
  const members = new Set(
    (Array.isArray(lock["members"]) ? lock["members"] : [])
      .filter((m): m is string => typeof m === "string")
      .map(normalName),
  );
  const packages = Array.isArray(lock["package"]) ? lock["package"] : [];
  return packages.flatMap((p) => {
    const source = isRecord(p) && isRecord(p["source"]) ? p["source"] : {};
    const dir = str(source, "editable") ?? str(source, "virtual");
    const name = isRecord(p) ? str(p, "name") : undefined;
    if (dir === undefined || name === undefined) return [];
    return (members.size === 0 ? dir === "." : members.has(normalName(name))) ? [dir] : [];
  });
}

export function uvRow(deps: RowDeps): Row {
  return lockedRow(deps, {
    name: "uv",
    manager: "pep621",
    lockfile: "uv.lock",
    declared: pep621Declared,
    isRegistry: (source) => isRecord(source) && "registry" in source,
    members: uvMembers,
  });
}

export function poetryRow(deps: RowDeps): Row {
  return lockedRow(deps, {
    name: "poetry",
    manager: "poetry",
    lockfile: "poetry.lock",
    declared: poetryDeclared,
    // No source is PyPI; a `legacy` one is another package index.
    isRegistry: (source) =>
      source === undefined || (isRecord(source) && source["type"] === "legacy"),
    members: () => [],
  });
}

// ---------------------------------------------------------------------------
// Requirements files

/** Renovate's pattern for a requirements file: `requirements.txt`, `requirements-dev.txt`, `dev-requirements.txt`. */
const REQUIREMENTS_RE = /^[\w-]*requirements([-.]\w+)?\.txt$/;

function requirementFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && REQUIREMENTS_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export type Requirements = {
  pins: { name: string; version: string }[];
  /** Requirements with a range or no version, which pin nothing. */
  unpinned: string[];
};

/**
 * A requirements file's `==` pins. Options (`-r`, `-e`, `--index-url`), paths,
 * URLs and comments are skipped; a backslash continues a line.
 */
export function readRequirements(text: string): Requirements {
  const result: Requirements = { pins: [], unpinned: [] };
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = raw
      .replace(/(^|\s)#.*$/, "")
      .split(/\s--?[a-z]/)[0]!
      .trim();
    if (line === "" || line.startsWith("-") || line.startsWith(".") || line.startsWith("/")) {
      continue;
    }
    if (line.includes("://")) continue;
    const requirement = parseRequirement(line);
    if (requirement === null) continue;
    const version = pinnedVersion(requirement.rest);
    if (version === null) result.unpinned.push(requirement.name);
    else result.pins.push({ name: requirement.name, version });
  }
  return result;
}

/**
 * The pip row: every directory holding requirements files is one project, its
 * `requirements.txt` first. A pin is the version; it needs no tool to read,
 * so this row claims its files whatever is installed.
 */
export function pipRow(deps: RowDeps): Row {
  const audit = pipAuditor(deps, "pip");

  const read = (manifest: Manifest): Map<string, Requirements> | string => {
    const byFile = new Map<string, Requirements>();
    for (const path of manifest.workspaces) {
      try {
        byFile.set(path, readRequirements(readFileSync(join(manifest.checkout, path), "utf8")));
      } catch {
        return `${path} is not readable`;
      }
    }
    return byFile;
  };

  return {
    name: "pip",
    manager: "pip_requirements",
    system: "pypi",
    ecosystem: "PyPI",

    async detect(checkout) {
      return findDirs(checkout, (dir) => requirementFiles(dir).length > 0, SKIP).map((dir) => {
        const files = requirementFiles(join(checkout, dir)).map((file) => fileIn(dir, file));
        const root = files.find((f) => posix.basename(f) === "requirements.txt") ?? files[0]!;
        return { checkout, path: root, workspaces: [root, ...files.filter((f) => f !== root)] };
      });
    },

    async list(manifest) {
      const byFile = read(manifest);
      if (typeof byFile === "string") return { ok: false, problem: byFile };
      const listed: ListedDependency[] = [];
      const unresolved: string[] = [];
      for (const [workspace, { pins, unpinned }] of byFile) {
        for (const pin of pins) {
          listed.push({
            package: normalName(pin.name),
            current: pin.version,
            depType: "prod",
            workspace,
          });
        }
        unresolved.push(...unpinned.map((name) => `${workspace}: ${name}`));
      }
      logUnresolved(deps.log, "pip", manifest.path, unresolved);
      return { ok: true, value: listed };
    },

    async audit(manifest) {
      const byFile = read(manifest);
      if (typeof byFile === "string") return { ok: false, problem: byFile };
      const pins = [...byFile.values()].flatMap((r) => r.pins);
      return audit(join(manifest.checkout, dirOf(manifest.path)), pins);
    },
  };
}
