// The bootstrapper's GitHub engine materializer: clone the engine repo once into
// a persistent dir, then fetch the configured ref and check it out. The git
// mechanics are the whole of it, so we drive an injected GitRunner that records
// the commands and assert the exact sequence — clone-only-on-first-boot,
// authenticated URLs, token scrubbed from the persisted remote, ref passed
// through verbatim so a branch/SHA/tag all check out the fetched commit.
//
// The same seam covers the ref watch the reconcile loop polls (#42): what
// `ls-remote` is asked, and — the part that matters — which refs are treated as
// *moving*. Only a branch is watched; a pinned SHA is never even asked about and
// a tag is asked but never acted on.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { GitRunner } from "../src/git-model.ts";
import {
  branchShaFromLsRemote,
  buildAuthenticatedRepoUrl,
  githubEngineDir,
  isPinnedSha,
  LS_REMOTE_TIMEOUT_MS,
  lsRemoteBranchSha,
  materializeGithubEngine,
  parseLsRemote,
} from "./github-engine.ts";

/**
 * A GitRunner that records every argv it is handed. Returns empty output by
 * default; `outputs` maps a git subcommand to canned stdout for the calls that
 * read something back (`rev-parse`, `ls-remote`).
 */
function recordingGit(outputs: Record<string, string> = {}): {
  calls: string[][];
  git: (args: string[]) => string;
} {
  const calls: string[][] = [];
  return {
    calls,
    git: (args: string[]) => {
      calls.push(args);
      const subcommand = args.find((arg) => arg in outputs);
      return subcommand ? (outputs[subcommand] ?? "") : "";
    },
  };
}

const REPO = "JesusFilm/phoebe";
const CLEAN_URL = "https://github.com/JesusFilm/phoebe.git";
const AUTH_URL = "https://x-access-token:tok-123@github.com/JesusFilm/phoebe.git";

describe("buildAuthenticatedRepoUrl", () => {
  test("embeds the token as x-access-token when one is given", () => {
    expect(buildAuthenticatedRepoUrl(REPO, "tok-123")).toBe(AUTH_URL);
  });

  test("falls back to the clean URL when no token is given (public/anon)", () => {
    expect(buildAuthenticatedRepoUrl(REPO, undefined)).toBe(CLEAN_URL);
    expect(buildAuthenticatedRepoUrl(REPO, "")).toBe(CLEAN_URL);
  });

  test("honours a repo override", () => {
    expect(buildAuthenticatedRepoUrl("acme/fork", "tok-123")).toBe(
      "https://x-access-token:tok-123@github.com/acme/fork.git",
    );
  });
});

describe("githubEngineDir", () => {
  test("keys the clone dir by repo so an override gets its own clone", () => {
    const base = "/data/engine";
    expect(githubEngineDir(base, "JesusFilm/phoebe")).toBe(
      githubEngineDir(base, "JesusFilm/phoebe"),
    );
    expect(githubEngineDir(base, "JesusFilm/phoebe")).not.toBe(githubEngineDir(base, "acme/fork"));
    // Path-safe: the slash in the slug never becomes a nested directory.
    expect(githubEngineDir(base, "JesusFilm/phoebe").startsWith(base)).toBe(true);
    expect(githubEngineDir(base, "JesusFilm/phoebe").includes("phoebe")).toBe(true);
  });
});

describe("materializeGithubEngine", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "github-engine-test-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("first boot clones, scrubs the token from origin, fetches the ref, checks out", () => {
    const { calls, git } = recordingGit();
    const dir = githubEngineDir(base, REPO);

    const { entry } = materializeGithubEngine(
      { source: "github", ref: "main", repo: REPO },
      { baseDir: base, token: "tok-123", git, exists: () => false },
    );

    expect(entry).toBe(join(dir, "src", "cli.ts"));
    expect(calls).toEqual([
      ["clone", AUTH_URL, dir],
      ["-C", dir, "remote", "set-url", "origin", CLEAN_URL],
      ["-C", dir, "fetch", "--force", "--tags", AUTH_URL, "main"],
      ["-C", dir, "checkout", "--force", "--detach", "FETCH_HEAD"],
      ["-C", dir, "rev-parse", "HEAD"],
    ]);
  });

  test("subsequent boots skip the clone — fetch + checkout only, never re-clone", () => {
    const { calls, git } = recordingGit();
    const dir = githubEngineDir(base, REPO);

    materializeGithubEngine(
      { source: "github", ref: "main", repo: REPO },
      { baseDir: base, token: "tok-123", git, exists: () => true },
    );

    expect(calls.some((c) => c[0] === "clone")).toBe(false);
    expect(calls).toEqual([
      ["-C", dir, "fetch", "--force", "--tags", AUTH_URL, "main"],
      ["-C", dir, "checkout", "--force", "--detach", "FETCH_HEAD"],
      ["-C", dir, "rev-parse", "HEAD"],
    ]);
  });

  test("reports the commit the checkout landed on — the ref-watch's comparison point", () => {
    const sha = "b".repeat(40);
    const { git } = recordingGit({ "rev-parse": `${sha}\n` });

    const result = materializeGithubEngine(
      { source: "github", ref: "main", repo: REPO },
      { baseDir: base, token: "tok-123", git, exists: () => true },
    );

    expect(result.sha).toBe(sha);
  });

  test("an unreadable HEAD reports a null sha rather than an empty string", () => {
    const { git } = recordingGit();

    const result = materializeGithubEngine(
      { source: "github", ref: "main", repo: REPO },
      { baseDir: base, token: "tok-123", git, exists: () => true },
    );

    expect(result.sha).toBeNull();
  });

  test("a pinned SHA is passed to fetch verbatim (exact checkout via FETCH_HEAD)", () => {
    const { calls, git } = recordingGit();
    const sha = "a".repeat(40);

    materializeGithubEngine(
      { source: "github", ref: sha, repo: REPO },
      { baseDir: base, token: "tok-123", git, exists: () => true },
    );

    expect(calls[0]).toEqual([
      "-C",
      githubEngineDir(base, REPO),
      "fetch",
      "--force",
      "--tags",
      AUTH_URL,
      sha,
    ]);
    expect(calls[1]).toEqual([
      "-C",
      githubEngineDir(base, REPO),
      "checkout",
      "--force",
      "--detach",
      "FETCH_HEAD",
    ]);
  });

  test("a tag ref is fetched by name", () => {
    const { calls, git } = recordingGit();

    materializeGithubEngine(
      { source: "github", ref: "v1.2.3", repo: REPO },
      { baseDir: base, token: "tok-123", git, exists: () => true },
    );

    expect(calls[0]?.at(-1)).toBe("v1.2.3");
  });

  test("no token → unauthenticated URLs (clone + fetch use the clean URL)", () => {
    const { calls, git } = recordingGit();
    const dir = githubEngineDir(base, REPO);

    materializeGithubEngine(
      { source: "github", ref: "main", repo: REPO },
      { baseDir: base, token: undefined, git, exists: () => false },
    );

    expect(calls[0]).toEqual(["clone", CLEAN_URL, dir]);
    // Nothing to scrub, but the fetch still uses the clean URL.
    expect(calls.find((c) => c.includes("fetch"))?.at(-2)).toBe(CLEAN_URL);
  });

  test("honours a repo override in the clone dir and URLs", () => {
    const { calls, git } = recordingGit();
    const dir = githubEngineDir(base, "acme/fork");

    const { entry } = materializeGithubEngine(
      { source: "github", ref: "main", repo: "acme/fork" },
      { baseDir: base, token: "tok-123", git, exists: () => false },
    );

    expect(entry).toBe(join(dir, "src", "cli.ts"));
    expect(calls[0]).toEqual([
      "clone",
      "https://x-access-token:tok-123@github.com/acme/fork.git",
      dir,
    ]);
  });

  test("creates the clone directory before cloning into it", () => {
    const { git } = recordingGit();
    const dir = githubEngineDir(base, REPO);

    materializeGithubEngine(
      { source: "github", ref: "main", repo: REPO },
      { baseDir: base, token: "tok-123", git, exists: () => false },
    );

    // The (fake) git never created it, so the mkdir is what must have.
    expect(existsSync(dir)).toBe(true);
  });
});

// --- ref watch (#42) --------------------------------------------------------

const TIP = "c".repeat(40);
const TAG_SHA = "d".repeat(40);

describe("isPinnedSha", () => {
  test("a 40-char hex ref is an exact commit", () => {
    expect(isPinnedSha("a".repeat(40))).toBe(true);
    expect(isPinnedSha("A".repeat(40))).toBe(true);
  });

  test("branch names, tags and short SHAs are not pinned commits", () => {
    expect(isPinnedSha("main")).toBe(false);
    expect(isPinnedSha("v1.2.3")).toBe(false);
    expect(isPinnedSha("a".repeat(7))).toBe(false);
    expect(isPinnedSha("z".repeat(40))).toBe(false);
  });
});

describe("parseLsRemote", () => {
  test("parses sha/refname pairs and ignores blank lines", () => {
    expect(parseLsRemote(`${TIP}\trefs/heads/main\n\n${TAG_SHA}\trefs/tags/v1\n`)).toEqual([
      { sha: TIP, refName: "refs/heads/main" },
      { sha: TAG_SHA, refName: "refs/tags/v1" },
    ]);
  });

  test("empty output parses to no rows", () => {
    expect(parseLsRemote("")).toEqual([]);
  });
});

describe("branchShaFromLsRemote", () => {
  test("a branch ref yields its current tip — the thing the watch tracks", () => {
    expect(branchShaFromLsRemote(`${TIP}\trefs/heads/main\n`, "main")).toBe(TIP);
  });

  test("picks the right branch when the remote returns several refs", () => {
    const output = `${TAG_SHA}\trefs/heads/mainline\n${TIP}\trefs/heads/main\n`;
    expect(branchShaFromLsRemote(output, "main")).toBe(TIP);
  });

  test("a tag is inert — a pinned tag must never trigger a relaunch", () => {
    const output = `${TAG_SHA}\trefs/tags/v1.2.3\n${TAG_SHA}\trefs/tags/v1.2.3^{}\n`;
    expect(branchShaFromLsRemote(output, "v1.2.3")).toBeNull();
  });

  test("a ref the remote does not have is inert", () => {
    expect(branchShaFromLsRemote("", "nope")).toBeNull();
  });

  test("accepts a fully-qualified branch ref", () => {
    expect(branchShaFromLsRemote(`${TIP}\trefs/heads/main\n`, "refs/heads/main")).toBe(TIP);
  });

  test("a fully-qualified tag ref stays inert", () => {
    expect(branchShaFromLsRemote(`${TAG_SHA}\trefs/tags/v1\n`, "refs/tags/v1")).toBeNull();
  });
});

describe("lsRemoteBranchSha", () => {
  test("a no-change poll costs exactly one ls-remote — no fetch, no checkout", () => {
    const { calls, git } = recordingGit({ "ls-remote": `${TIP}\trefs/heads/main\n` });

    const sha = lsRemoteBranchSha(
      { source: "github", ref: "main", repo: REPO },
      {
        token: "tok-123",
        git,
      },
    );

    expect(sha).toBe(TIP);
    expect(calls).toEqual([["ls-remote", AUTH_URL, "main"]]);
  });

  test("a pinned SHA never even asks the remote", () => {
    const { calls, git } = recordingGit();

    const sha = lsRemoteBranchSha({ source: "github", ref: "a".repeat(40), repo: REPO }, { git });

    expect(sha).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a tag asks once but reports nothing to watch", () => {
    const { calls, git } = recordingGit({ "ls-remote": `${TAG_SHA}\trefs/tags/v1\n` });

    const sha = lsRemoteBranchSha({ source: "github", ref: "v1", repo: REPO }, { git });

    expect(sha).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("without a token the remote is asked over the clean URL", () => {
    const { calls, git } = recordingGit();

    lsRemoteBranchSha({ source: "github", ref: "main", repo: REPO }, { git });

    expect(calls[0]).toEqual(["ls-remote", CLEAN_URL, "main"]);
  });

  test("the poll is bounded by a timeout — a hung remote must not stall the supervisor", () => {
    const seen: Array<{ timeout?: number } | undefined> = [];
    const git = (_args: string[], opts?: { timeout?: number }) => (seen.push(opts), "");

    lsRemoteBranchSha(
      { source: "github", ref: "main", repo: REPO },
      {
        git: git as unknown as GitRunner,
      },
    );

    expect(seen[0]?.timeout).toBe(LS_REMOTE_TIMEOUT_MS);
  });
});
