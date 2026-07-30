// The `phoebe boot` source resolution. `boot` reads the mounted config, resolves
// the engine source, and turns it into the path it execs. This pins the `local`
// mount decision and which sources the crash-loop guard covers; the `github`
// source is materialized separately (github-engine.ts) and tested there, and the
// fallback policy itself lives in crash-loop.ts.

import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  isMovingBranch,
  LOCAL_ENGINE_DIR,
  resolveEngineEntry,
  setupGitCredentials,
} from "./boot.ts";

describe("resolveEngineEntry", () => {
  test("a local source execs the engine CLI under the mounted dir", () => {
    const entry = resolveEngineEntry(
      { source: "local" },
      { localEngineDir: "/opt/phoebe-engine", exists: () => true },
    );
    expect(entry).toBe(join("/opt/phoebe-engine", "src", "cli.ts"));
  });

  test("local defaults to /opt/phoebe-engine", () => {
    expect(LOCAL_ENGINE_DIR).toBe("/opt/phoebe-engine");
    const entry = resolveEngineEntry({ source: "local" }, { exists: () => true });
    expect(entry).toBe(join(LOCAL_ENGINE_DIR, "src", "cli.ts"));
  });

  test("a local source with no mount fails loudly, naming the dir", () => {
    expect(() =>
      resolveEngineEntry(
        { source: "local" },
        { localEngineDir: "/opt/phoebe-engine", exists: () => false },
      ),
    ).toThrow(/no engine is mounted at \/opt\/phoebe-engine/);
  });

  test("a mounted-but-empty volume (dir present, no src/cli.ts) also fails loudly", () => {
    const entry = join("/opt/phoebe-engine", "src", "cli.ts");
    // Everything exists except the engine entry file — an empty/wrong mount.
    expect(() =>
      resolveEngineEntry(
        { source: "local" },
        { localEngineDir: "/opt/phoebe-engine", exists: (path) => path !== entry },
      ),
    ).toThrow(/no engine is mounted at \/opt\/phoebe-engine/);
  });
});

// --- which launches the crash-loop guard covers ------------------------------

describe("isMovingBranch", () => {
  const SHA = "a".repeat(40);
  const repo = "JesusFilm/phoebe";
  /** `git ls-remote <url> <ref>` output for a branch and for a tag. */
  const lsRemote = (refName: string) => () => `${SHA}\t${refName}\n`;
  const never = () => {
    throw new Error("ls-remote should not have been called");
  };

  test("a branch is watched, so the guard covers it", () => {
    expect(
      isMovingBranch(
        { source: "github", ref: "main", repo },
        undefined,
        lsRemote("refs/heads/main"),
      ),
    ).toBe(true);
  });

  test("a pinned SHA is inert — and costs no network call to establish", () => {
    // Pinning means pinning: an operator who named a commit gets that commit,
    // crash-looping and all, rather than a silently different one.
    expect(isMovingBranch({ source: "github", ref: SHA, repo }, undefined, never)).toBe(false);
  });

  test("a tag is inert too", () => {
    expect(
      isMovingBranch(
        { source: "github", ref: "v1.2.3", repo },
        undefined,
        lsRemote("refs/tags/v1.2.3"),
      ),
    ).toBe(false);
  });

  test("a local mount has no commit to fall back to", () => {
    expect(isMovingBranch({ source: "local" }, undefined, never)).toBe(false);
  });

  test("a remote that will not answer leaves the guard off rather than failing the launch", () => {
    // Materializing is about to make the same call and raise the real error.
    expect(
      isMovingBranch({ source: "github", ref: "main", repo }, undefined, () => {
        throw new Error("could not resolve host github.com");
      }),
    ).toBe(false);
  });
});

// --- GH_TOKEN → git credential helper at boot --------------------------------

describe("setupGitCredentials", () => {
  test("runs when token present", () => {
    const calls: string[][] = [];
    setupGitCredentials({
      token: "ghs_test",
      gh: (args) => {
        calls.push([...args]);
      },
    });
    expect(calls).toEqual([["auth", "setup-git", "--hostname", "github.com"]]);
  });

  test("skips when absent", () => {
    const calls: string[][] = [];
    setupGitCredentials({
      token: undefined,
      gh: (args) => {
        calls.push([...args]);
      },
    });
    expect(calls).toEqual([]);
  });

  test("warns on failure", () => {
    const warnings: string[] = [];
    setupGitCredentials({
      token: "ghs_test",
      gh: () => {
        throw new Error("gh not found");
      },
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not configure git credentials.*gh not found/);
  });
});
