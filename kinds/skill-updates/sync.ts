// The deterministic sync of the `skill-updates` kind (#877): copy each locked
// skill's folder from an upstream checkout over the vendored copy, rewrite its
// lock entry, and say what happened. No agent and no network: the upstream is
// already checked out (./upstream.ts).
//
// Vendored skills sit in `.agents/skills/<name>/` beside the lock, as the
// `skills` CLI puts them. Upstream, each sits where its entry's `skillPath`
// says. A skill whose `skillPath` is gone upstream is looked for by folder
// name: one hit is a move, and `skillPath` follows it; two or more are skipped
// and reported; none is a removal, reported and left alone.

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  hashSkillFolder,
  parseSkillLock,
  SKILLS_DIR,
  type SkillLock,
} from "../../src/skill-lock.ts";
import { parseTag } from "./plan.ts";
import type { Upstream } from "./upstream.ts";

/** One synced skill: where it sat upstream before and after, and whether its files changed. */
export type SyncedSkill = {
  name: string;
  from: string | null;
  to: string;
  changed: boolean;
};

export type SyncReport = {
  synced: SyncedSkill[];
  /** Vendored skills no longer upstream at all; left at the ref they were on. */
  removed: string[];
  /** Vendored skills whose folder name upstream matches more than one path. */
  ambiguous: { name: string; paths: string[] }[];
  /** Skills upstream has now that it did not have at the locked commit, and this repo does not vendor. */
  added: string[];
  /** Skills upstream dropped that this repo does not vendor. */
  dropped: string[];
  /** Whether `added` and `dropped` could be worked out at all. */
  previousKnown: boolean;
  /** Vendored skills whose files already did not match the lock, now overwritten. */
  localEditsDiscarded: string[];
  /** Locked skills from this source `ignore` left untouched. */
  ignored: string[];
};

/** The vendored folder of skill `name`, relative to the repository root. */
export function vendoredDir(lockPath: string, name: string): string {
  return posix.join(posix.dirname(lockPath), SKILLS_DIR, name);
}

/** Read the lock at `lockPath` under `repoDir`, refusing any version but 2. */
export function readLockAt(repoDir: string, lockPath: string): SkillLock {
  return parseSkillLock(readFileSync(join(repoDir, lockPath), "utf8"), lockPath);
}

/**
 * Where skill `name` sits upstream now: its locked `skillPath` when that is
 * still a `SKILL.md`, otherwise the one path its folder name turns up at.
 */
function locate(
  upstream: Upstream,
  name: string,
  skillPath: string | undefined,
): { path: string } | { missing: true } | { ambiguous: string[] } {
  if (skillPath !== undefined && posix.basename(skillPath) === "SKILL.md") {
    const all = [...upstream.skills.values()].flat();
    if (all.includes(skillPath)) return { path: skillPath };
  }
  const folderName =
    skillPath !== undefined && posix.dirname(skillPath) !== "."
      ? posix.basename(posix.dirname(skillPath))
      : name;
  const hits = upstream.skills.get(folderName) ?? [];
  if (hits.length === 0) return { missing: true };
  if (hits.length > 1) return { ambiguous: hits };
  return { path: hits[0]! };
}

/**
 * Sync every skill of `source` that `ignore` does not name, in the checkout at
 * `repoDir`, from `upstream`, and write the lock back. `tag` is the release the
 * source moves to; a SHA-pinned source passes null and keeps its entries'
 * `ref` as it is.
 */
export function syncSource(opts: {
  repoDir: string;
  lockPath: string;
  source: string;
  tag: string | null;
  ignore: readonly string[];
  upstream: Upstream;
}): SyncReport {
  const { repoDir, lockPath, source, upstream } = opts;
  const lock = readLockAt(repoDir, lockPath);
  const report: SyncReport = {
    synced: [],
    removed: [],
    ambiguous: [],
    added: [],
    dropped: [],
    previousKnown: upstream.previous !== null,
    localEditsDiscarded: [],
    ignored: [],
  };

  const vendoredNames = new Set<string>();
  for (const [name, entry] of Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.source !== source) continue;
    vendoredNames.add(name);
    if (entry.skillPath !== undefined && posix.dirname(entry.skillPath) !== ".") {
      vendoredNames.add(posix.basename(posix.dirname(entry.skillPath)));
    }
    if (opts.ignore.includes(name)) {
      report.ignored.push(name);
      continue;
    }
    const found = locate(upstream, name, entry.skillPath);
    if ("missing" in found) {
      report.removed.push(name);
      continue;
    }
    if ("ambiguous" in found) {
      report.ambiguous.push({ name, paths: found.ambiguous });
      continue;
    }

    const target = join(repoDir, vendoredDir(lockPath, name));
    if (existsSync(target)) {
      if (hashSkillFolder(target) !== entry.computedHash) report.localEditsDiscarded.push(name);
      rmSync(target, { recursive: true, force: true });
    }
    cpSync(join(upstream.dir, posix.dirname(found.path)), target, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !src.split(/[\\/]/).includes(".git"),
    });
    const hash = hashSkillFolder(target);
    report.synced.push({
      name,
      from: entry.skillPath ?? null,
      to: found.path,
      changed: hash !== entry.computedHash,
    });
    if (opts.tag !== null && (entry.ref === undefined || parseTag(entry.ref) !== null)) {
      entry.ref = opts.tag;
    }
    entry.commit = upstream.commit;
    entry.skillPath = found.path;
    entry.computedHash = hash;
  }

  if (upstream.previous !== null) {
    const before = new Set(upstream.previous.keys());
    const after = new Set(upstream.skills.keys());
    report.added = [...after].filter((n) => !before.has(n) && !vendoredNames.has(n)).sort();
    report.dropped = [...before].filter((n) => !after.has(n) && !vendoredNames.has(n)).sort();
  }

  writeFileSync(join(repoDir, lockPath), `${JSON.stringify(lock, null, 2)}\n`);
  return report;
}

/**
 * The lock and every vendored folder it names, relative to the repository
 * root: the paths the agent pass may not change.
 */
export function protectedPaths(repoDir: string, lockPath: string): string[] {
  const lock = readLockAt(repoDir, lockPath);
  return [lockPath, ...Object.keys(lock.skills).map((name) => vendoredDir(lockPath, name))];
}

/** The synced skills whose vendored folder does not hash to its lock entry. */
export function hashMismatches(
  repoDir: string,
  lockPath: string,
  names: readonly string[],
): string[] {
  const lock = readLockAt(repoDir, lockPath);
  return names.filter((name) => {
    const entry = lock.skills[name];
    const dir = join(repoDir, vendoredDir(lockPath, name));
    return entry === undefined || !existsSync(dir) || hashSkillFolder(dir) !== entry.computedHash;
  });
}
