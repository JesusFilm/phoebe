// The bootstrapper's GitHub engine materializer: clone the engine repo once into
// a persistent dir, then fetch the configured ref and check it out. The git
// mechanics are the whole of it, so we drive an injected GitRunner that records
// the commands and assert the exact sequence — clone-only-on-first-boot,
// authenticated URLs, token scrubbed from the persisted remote, ref passed
// through verbatim so a branch/SHA/tag all check out the fetched commit.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  buildAuthenticatedRepoUrl,
  githubEngineDir,
  materializeGithubEngine,
} from "./github-engine.ts";

/** A GitRunner that records every argv it is handed and returns empty output. */
function recordingGit(): { calls: string[][]; git: (args: string[]) => string } {
  const calls: string[][] = [];
  return { calls, git: (args: string[]) => (calls.push(args), "") };
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

    const entry = materializeGithubEngine(
      { source: "github", ref: "main", repo: REPO },
      { baseDir: base, token: "tok-123", git, exists: () => false },
    );

    expect(entry).toBe(join(dir, "src", "cli.ts"));
    expect(calls).toEqual([
      ["clone", AUTH_URL, dir],
      ["-C", dir, "remote", "set-url", "origin", CLEAN_URL],
      ["-C", dir, "fetch", "--force", "--tags", AUTH_URL, "main"],
      ["-C", dir, "checkout", "--force", "--detach", "FETCH_HEAD"],
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
    ]);
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

    const entry = materializeGithubEngine(
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
