// The vendored-skill lock: `skills-lock.json` at a repository's root pins each
// skill under `.agents/skills/` to an upstream ref and a `computedHash` of the
// skill folder's contents. This module recomputes that hash and says, per locked
// skill, whether the folder on disk still matches.
//
// The lock is written by the `skills` CLI (vercel-labs). Its v2 hash recipe is
// not documented upstream; it was read out of `skills@1.9.0` and recomputed
// independently against every entry in this repo's lock (#876):
//
//   - SHA-256, hex digest, over every file under the skill folder, recursively.
//   - Anything named `metadata.json` is skipped at any depth, as are directories
//     named `.git`, `__pycache__` and `__pypackages__`. `node_modules` is kept.
//   - Symlinks are followed only when their real path stays inside the skill
//     folder, and a link back to a directory already being walked is skipped.
//   - Paths are relative to the skill folder and `/`-separated, sorted by their
//     UTF-8 bytes rather than by locale.
//   - CRLF becomes LF unless the file holds a NUL byte. A bare CR is left alone.
//   - Each file is fed as `path`, NUL, the content length in decimal, NUL, then
//     the content.
//
// A recipe change upstream would come with a new lock `version`, so any version
// but 2 is refused outright rather than reported as a wall of mismatches.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** The lock version whose hash recipe this module implements. */
export const SKILL_LOCK_VERSION = 2;

/** Where the lock and the vendored skills sit, relative to a repository root. */
export const SKILL_LOCK_FILE = "skills-lock.json";
export const SKILLS_DIR = ".agents/skills";

const SKIPPED_NAMES = new Set(["metadata.json"]);
const SKIPPED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

export type SkillLockEntry = {
  source: string;
  ref?: string;
  sourceType?: string;
  skillPath?: string;
  computedHash: string;
  commit?: string;
};

export type SkillLock = {
  version: number;
  skills: Record<string, SkillLockEntry>;
};

/** One file as the hash sees it: its `/`-separated path in the skill folder, and its bytes. */
type SkillFile = { path: string; content: Buffer };

export type SkillCheck =
  | { name: string; status: "matching"; expected: string }
  | { name: string; status: "modified"; expected: string; actual: string }
  | { name: string; status: "missing"; expected: string };

/** Read and validate `skills-lock.json` under `repoRoot`. */
export function readSkillLock(repoRoot: string): SkillLock {
  const path = join(repoRoot, SKILL_LOCK_FILE);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${SKILL_LOCK_FILE} is not a JSON object`);
  }
  const { version, skills } = parsed as { version?: unknown; skills?: unknown };
  if (version !== SKILL_LOCK_VERSION) {
    throw new Error(
      `${SKILL_LOCK_FILE} is version ${JSON.stringify(version)}, but only version ${SKILL_LOCK_VERSION} can be checked: ` +
        `its hash recipe is the only one implemented, so the skills-lock module needs updating for the new one`,
    );
  }
  if (typeof skills !== "object" || skills === null) {
    throw new Error(`${SKILL_LOCK_FILE} has no "skills" object`);
  }
  for (const [name, entry] of Object.entries(skills)) {
    const hash = (entry as { computedHash?: unknown } | null)?.computedHash;
    if (typeof hash !== "string") {
      throw new Error(`${SKILL_LOCK_FILE} entry "${name}" has no computedHash`);
    }
  }
  return { version, skills: skills as Record<string, SkillLockEntry> };
}

/**
 * Check every skill in the lock under `repoRoot` against its folder in
 * `.agents/skills/`. Skills on disk that the lock doesn't name are not checked.
 */
export function verifySkills(repoRoot: string): SkillCheck[] {
  const lock = readSkillLock(repoRoot);
  return Object.entries(lock.skills).map(([name, entry]) => {
    const expected = entry.computedHash;
    const dir = join(repoRoot, SKILLS_DIR, name);
    if (!isDirectory(dir)) {
      return { name, status: "missing", expected };
    }
    const actual = hashSkillFolder(dir);
    return actual === expected
      ? { name, status: "matching", expected }
      : { name, status: "modified", expected, actual };
  });
}

/** The lock v2 `computedHash` of the skill folder at `dir`. */
export function hashSkillFolder(dir: string): string {
  const root = realpathSync(dir);
  const files: SkillFile[] = [];
  collectFiles(dir, "", root, [root], files);

  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

  const hash = createHash("sha256");
  for (const file of files) {
    const content = file.content.includes(0) ? file.content : foldCrlf(file.content);
    hash.update(`${file.path}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

/**
 * Walk `dir` (reached as `relative` from the skill folder), pushing each file.
 * `ancestors` holds the real paths of the directories on the current walk, so a
 * symlink back up to one of them is a cycle and is skipped.
 */
function collectFiles(
  dir: string,
  relative: string,
  root: string,
  ancestors: string[],
  files: SkillFile[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Upstream skips this name before asking what the entry is, so a
    // `metadata.json` directory is dropped along with everything under it.
    if (SKIPPED_NAMES.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const relPath = relative === "" ? entry.name : `${relative}/${entry.name}`;

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    let real = path;
    if (entry.isSymbolicLink()) {
      try {
        real = realpathSync(path);
      } catch {
        continue; // dangling
      }
      if (real !== root && !real.startsWith(root + sep)) continue;
      const stat = statSync(real);
      isDir = stat.isDirectory();
      isFile = stat.isFile();
    }

    if (isDir) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const realDir = entry.isSymbolicLink() ? real : realpathSync(path);
      if (ancestors.includes(realDir)) continue;
      collectFiles(path, relPath, root, [...ancestors, realDir], files);
    } else if (isFile) {
      files.push({ path: relPath, content: readFileSync(real) });
    }
  }
}

/** Replace every CRLF pair with LF, leaving a lone CR in place. */
function foldCrlf(content: Buffer): Buffer {
  if (!content.includes(0x0d)) return content;
  const out = Buffer.alloc(content.length);
  let length = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x0d && content[i + 1] === 0x0a) continue;
    out[length++] = content[i]!;
  }
  return out.subarray(0, length);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
