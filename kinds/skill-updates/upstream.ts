// The git half of the `skill-updates` kind (#877): reading an upstream skill
// source with plain git and the container's own credentials, rather than
// through the `skills` CLI (ADR 0004). Everything here is a `git` child
// process; nothing reaches skills.sh.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, posix } from "node:path";
import type { BranchCommit } from "./plan.ts";

const GIT_TIMEOUT_MS = 5 * 60_000;

/** Run git and return stdout; throw with git's stderr on failure. */
export function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A source the credentials cannot read fails at once rather than waiting on a prompt.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: GIT_TIMEOUT_MS,
    ...(cwd !== undefined ? { cwd } : {}),
  });
}

/**
 * The clone URL for a lock entry's source. `github` sources are `owner/repo`;
 * a `git` source is its own URL. Anything else (`local`, `well-known`) has no
 * upstream this kind can read, and is null.
 */
export function defaultSourceUrl(source: string, sourceType: string | null): string | null {
  if (sourceType === null || sourceType === "github") {
    return /^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}.git` : null;
  }
  if (sourceType === "git") return source;
  return null;
}

/** The release tags `url` carries, by name. */
export function listTags(url: string): string[] {
  return git(["ls-remote", "--tags", "--refs", url])
    .split("\n")
    .map((line) => line.split("\t")[1] ?? "")
    .filter((ref) => ref.startsWith("refs/tags/"))
    .map((ref) => ref.slice("refs/tags/".length));
}

/**
 * The first-parent history of `branch` (the default branch when null), newest
 * first, with each commit's committer time. A treeless clone into `dir`: the
 * commits without their trees or blobs.
 */
export function branchLog(url: string, branch: string | null, dir: string): BranchCommit[] {
  mkdirSync(dirname(dir), { recursive: true });
  git([
    "clone",
    "--quiet",
    "--bare",
    "--filter=tree:0",
    "--single-branch",
    ...(branch !== null ? ["--branch", branch] : []),
    url,
    dir,
  ]);
  return git(["log", "--first-parent", "--format=%H %ct", "HEAD"], dir)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [sha, seconds] = line.split(" ");
      return { sha: sha!, committedAt: Number(seconds) * 1000 };
    });
}

/** Where each skill sits in one upstream commit: folder name → `SKILL.md` paths. */
export type SkillIndex = Map<string, string[]>;

/**
 * An upstream source checked out at the target, with the commit the lock was
 * on fetched beside it when it could be, to tell what was added and removed.
 */
export type Upstream = {
  dir: string;
  commit: string;
  skills: SkillIndex;
  /** The skills at the commit the lock was on; null when it could not be fetched. */
  previous: SkillIndex | null;
};

/**
 * Shallow-fetch `target` (a tag name or a commit) into a fresh repository at
 * `dir`, check it out, and index its skills. `lockedCommit` is fetched the same
 * way for the index of what was there before; a failure there costs only the
 * added-and-removed report.
 */
export function checkoutUpstream(opts: {
  url: string;
  target: { tag: string } | { commit: string };
  lockedCommit: string | null;
  dir: string;
}): Upstream {
  const { url, dir } = opts;
  mkdirSync(dir, { recursive: true });
  git(["init", "--quiet"], dir);
  const want = "tag" in opts.target ? `refs/tags/${opts.target.tag}` : opts.target.commit;
  git(["fetch", "--quiet", "--depth", "1", url, want], dir);
  const commit = git(["rev-parse", "FETCH_HEAD^{commit}"], dir).trim();
  git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit], dir);

  let previous: SkillIndex | null = null;
  if (opts.lockedCommit !== null) {
    try {
      git(["fetch", "--quiet", "--depth", "1", url, opts.lockedCommit], dir);
      previous = indexSkills(dir, opts.lockedCommit);
    } catch {
      previous = null;
    }
  }
  return { dir, commit, skills: indexSkills(dir, commit), previous };
}

/** Every `SKILL.md` below the root of `commit`, by its folder's name. */
export function indexSkills(repoDir: string, commit: string): SkillIndex {
  const index: SkillIndex = new Map();
  const paths = git(["ls-tree", "-r", "--name-only", "-z", commit], repoDir).split("\0");
  for (const path of paths) {
    if (posix.basename(path) !== "SKILL.md") continue;
    const folder = posix.dirname(path);
    if (folder === ".") continue;
    const name = posix.basename(folder);
    index.set(name, [...(index.get(name) ?? []), path].sort());
  }
  return index;
}

/**
 * Whether `origin/<branch>` carries a commit, past `origin/<base>`, that
 * someone other than Phoebe committed. Phoebe is whoever this process commits
 * as (`git var GIT_COMMITTER_IDENT`), so a fix the janitors push counts as
 * Phoebe's, and a GitHub web edit or "Update branch" (committed by GitHub) or a
 * person's own push does not. A branch that is not on origin has none.
 */
export function hasForeignCommits(repoDir: string, base: string, branch: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoDir);
  } catch {
    return false;
  }
  const ident = git(["var", "GIT_COMMITTER_IDENT"], repoDir);
  const self = /<([^>]*)>/.exec(ident)?.[1] ?? "";
  const committers = git(["log", "--format=%ce", `origin/${base}..origin/${branch}`], repoDir)
    .split("\n")
    .filter((line) => line.trim() !== "");
  return committers.some((email) => email !== self);
}

/** The sha `origin/<branch>` is at, or null when origin has no such branch. */
export function originSha(repoDir: string, branch: string): string | null {
  try {
    return git(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      repoDir,
    ).trim();
  } catch {
    return null;
  }
}
