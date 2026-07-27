// Materialize the Phoebe engine from GitHub for `engine: { source: "github" }`.
//
// The published package is a thin bootstrapper; when the config selects a github
// source, `phoebe boot` runs the engine straight from a git checkout rather than
// the bundled copy. First boot clones the engine repo into a persistent dir;
// every boot fetches the configured ref and checks it out, so a branch tracks
// its tip while a pinned SHA or tag pins an exact commit. The clone lives on a
// persistent volume (keep `PHOEBE_ENGINE_DIR` on one) so later boots fetch into
// the existing clone instead of re-cloning.
//
// Auth reuses `GH_TOKEN` (the same token every `gh` call uses), embedded as an
// `x-access-token` HTTPS credential. The token is passed explicitly to each
// clone/fetch and scrubbed from the persisted `origin` URL, so a rotated token
// keeps working and no secret is written to the volume's git config.
//
// The git mechanics reuse the engine's injectable GitRunner seam
// (src/git-model.ts) so this materializer is unit-tested without running git.
//
// This module also owns the *ref watch* the reconcile loop polls (#42): asking
// the remote where the configured ref points now, so `phoebe boot` can notice
// the tracked branch has advanced past the commit the running engine was checked
// out at. Only a moving branch is watched — a pinned SHA or tag is inert.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "../src/git-model.ts";

/** The resolved github source the materializer acts on (defaults already applied). */
export type GithubSource = { source: "github"; ref: string; repo: string };

/** The persistent clone directory for a given engine repo, keyed by repo slug. */
export function githubEngineDir(baseDir: string, repo: string): string {
  return join(baseDir, "github", repo.replace(/[^a-zA-Z0-9]+/g, "-"));
}

/**
 * The HTTPS URL git clones/fetches from. With a token it carries an
 * `x-access-token` credential (GitHub's convention for PAT/app tokens); without
 * one it is the plain URL, so public repos and anonymous local dev still work.
 */
export function buildAuthenticatedRepoUrl(repo: string, token: string | undefined): string {
  if (!token) return `https://github.com/${repo}.git`;
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/**
 * Ensure a git checkout of `repo` at `ref` exists under `baseDir` and return the
 * engine-CLI path (`<clone>/src/cli.ts`) `phoebe boot` execs, plus the commit it
 * landed on. Clones only when the clone is absent; otherwise fetches into the
 * existing one. `ref` (branch, 40-char SHA, or tag) is fetched by name and
 * checked out via `FETCH_HEAD`, so a branch lands on its current tip and a
 * SHA/tag on that exact commit.
 *
 * The returned `sha` is what the reconcile ref-watch compares the remote tip
 * against — it is the commit actually running, so a relaunch is triggered by the
 * branch advancing rather than by anything the poll itself remembers.
 *
 * `git`/`exists` are injectable so the command sequence is unit-tested without a
 * real repository or network.
 */
export function materializeGithubEngine(
  source: GithubSource,
  deps: {
    baseDir: string;
    token?: string | undefined;
    git?: GitRunner;
    exists?: (path: string) => boolean;
  },
): { entry: string; sha: string | null } {
  const git = deps.git ?? defaultGit;
  const exists = deps.exists ?? existsSync;
  const dir = githubEngineDir(deps.baseDir, source.repo);
  const authUrl = buildAuthenticatedRepoUrl(source.repo, deps.token);
  const cleanUrl = buildAuthenticatedRepoUrl(source.repo, undefined);

  let sha: string | null;
  try {
    if (!exists(join(dir, ".git"))) {
      // Clone into a pre-created empty dir (git needs the leading dirs to exist).
      // Inlined rather than reusing git-model's `ensureClone`: this has to inject
      // `exists` (for testing) and interleave the token-scrub below, neither of
      // which that helper exposes.
      mkdirSync(dir, { recursive: true });
      git(["clone", authUrl, dir], { stdio: "inherit" });
      // Drop the token from the persisted `origin` URL — the fetch below
      // re-supplies it explicitly, so a rotated token keeps working and the
      // volume's git config never holds the secret. The token is still passed on
      // git's argv (clone/fetch); that is acceptable here because `GH_TOKEN`
      // already lives in the container env and boot runs before any agent child.
      git(["-C", dir, "remote", "set-url", "origin", cleanUrl]);
    }
    // Fetch the ref by name (works for branch/tag/reachable-SHA on GitHub) and
    // detach onto exactly what was fetched — latest for a branch, pinned for a
    // SHA/tag. `--force` lets a moved tag/branch and a dirty tree update cleanly.
    git(["-C", dir, "fetch", "--force", "--tags", authUrl, source.ref], { stdio: "inherit" });
    git(["-C", dir, "checkout", "--force", "--detach", "FETCH_HEAD"], { stdio: "inherit" });
    sha = git(["-C", dir, "rev-parse", "HEAD"]).trim() || null;
  } catch (error) {
    throw new Error(
      `Failed to materialize the engine from ${source.repo}@${source.ref}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { entry: join(dir, "src", "cli.ts"), sha };
}

/** A 40-char hex ref is an exact commit — nothing for the ref-watch to track. */
export function isPinnedSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/**
 * Bound on the reconcile poll's `ls-remote`. It runs on the bootstrapper's event
 * loop (`execFileSync`), so a hung remote must not stall boot's SIGTERM latch or
 * its child-exit handling — a timed-out poll surfaces as a sample error and is
 * treated as "no change", not a crash.
 */
export const LS_REMOTE_TIMEOUT_MS = 30_000;

/**
 * Parse `git ls-remote` output into `{ sha, refName }` rows. Each line is
 * `<sha>\t<refname>`; peeled tag lines (`refs/tags/v1^{}`) come through as
 * ordinary rows and are simply never matched as branches.
 */
export function parseLsRemote(output: string): Array<{ sha: string; refName: string }> {
  const rows: Array<{ sha: string; refName: string }> = [];
  for (const line of output.split("\n")) {
    const [sha, refName] = line.trim().split(/\s+/);
    if (sha && refName) rows.push({ sha, refName });
  }
  return rows;
}

/**
 * The tip `ref` currently points at, but only when `ref` names a **branch** —
 * the one kind of ref that moves under a running engine. A tag (or a ref the
 * remote does not have) yields null, which the reconcile loop reads as "nothing
 * to watch": per #42 a pinned SHA/tag never triggers a relaunch, even if someone
 * force-moves the tag.
 *
 * Accepts both the short form (`main`) and a fully-qualified `refs/heads/main`.
 */
export function branchShaFromLsRemote(output: string, ref: string): string | null {
  const wanted = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
  if (!wanted.startsWith("refs/heads/")) return null;
  return parseLsRemote(output).find((row) => row.refName === wanted)?.sha ?? null;
}

/**
 * Ask the remote where the configured branch points now — the ref half of a
 * reconcile poll, and deliberately the *only* network call it makes: `ls-remote`
 * reads a ref without fetching any objects. Returns null when there is nothing
 * to watch (pinned SHA — not even asked; tag; unknown ref).
 *
 * The token rides on the URL exactly as it does for clone/fetch (same tradeoff,
 * documented above): `GH_TOKEN` is already in the container env and boot runs
 * before any agent child.
 */
export function lsRemoteBranchSha(
  source: GithubSource,
  deps: { token?: string | undefined; git?: GitRunner } = {},
): string | null {
  if (isPinnedSha(source.ref)) return null;
  const git = deps.git ?? defaultGit;
  const url = buildAuthenticatedRepoUrl(source.repo, deps.token);
  const output = git(["ls-remote", url, source.ref], { timeout: LS_REMOTE_TIMEOUT_MS });
  return branchShaFromLsRemote(output, source.ref);
}
