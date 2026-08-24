// The `phoebe boot` source resolution. `boot` reads the mounted config, resolves
// the engine source, and turns it into the path it execs. This pins the `local`
// mount decision and which sources the crash-loop guard covers; the `github`
// source is materialized separately (github-engine.ts) and tested there, and the
// fallback policy itself lives in crash-loop.ts.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  checkMinBootstrap,
  isMovingBranch,
  LOCAL_ENGINE_DIR,
  resolveEngineEntry,
  setupGitCredentials,
  tenantFingerprint,
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
  test("runs unconditionally", () => {
    const calls: string[][] = [];
    setupGitCredentials({
      gh: (args) => {
        calls.push([...args]);
      },
    });
    expect(calls).toEqual([["auth", "setup-git", "--hostname", "github.com"]]);
  });

  test("runs even when supervisor holds no token", () => {
    // This is the App-mode path: no GH_TOKEN in the supervisor env, but the
    // helper must be wired so child processes can use their own minted token.
    const calls: string[][] = [];
    setupGitCredentials({
      gh: (args) => {
        calls.push([...args]);
      },
    });
    expect(calls).toEqual([["auth", "setup-git", "--hostname", "github.com"]]);
  });

  test("warns on failure", () => {
    const warnings: string[] = [];
    setupGitCredentials({
      gh: () => {
        throw new Error("gh not found");
      },
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not configure git credentials.*gh not found/);
  });
});

describe("tenantFingerprint", () => {
  const setup = (): { dir: string; configPath: string; envPath: string } => {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-fp-"));
    const configPath = join(dir, "phoebe.config.ts");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, "export default { repoSlug: 'acme/widget' };\n");
    return { dir, configPath, envPath };
  };

  test("a GH_TOKEN-only rotation does not move the fingerprint (#205)", () => {
    const { configPath, envPath } = setup();
    writeFileSync(envPath, "GH_TOKEN=ghp_old\nCURSOR_API_KEY=sk-1\n");
    const before = tenantFingerprint(configPath, envPath);
    writeFileSync(envPath, "GH_TOKEN=ghp_new\nCURSOR_API_KEY=sk-1\n");
    expect(tenantFingerprint(configPath, envPath)).toBe(before);
    expect(before).not.toBeNull();
  });

  test("any other .env edit still moves the fingerprint (relaunch delivers it)", () => {
    const { configPath, envPath } = setup();
    writeFileSync(envPath, "GH_TOKEN=ghp_x\nCURSOR_API_KEY=sk-1\n");
    const before = tenantFingerprint(configPath, envPath);
    writeFileSync(envPath, "GH_TOKEN=ghp_x\nCURSOR_API_KEY=sk-2\n");
    expect(tenantFingerprint(configPath, envPath)).not.toBe(before);
  });

  test("an unreadable config stays the null 'unknown' sentinel", () => {
    const { dir, envPath } = setup();
    writeFileSync(envPath, "GH_TOKEN=ghp_x\n");
    expect(tenantFingerprint(join(dir, "missing.config.ts"), envPath)).toBeNull();
  });

  test("an absent .env is a stable non-null fingerprint", () => {
    const { configPath, envPath } = setup();
    const a = tenantFingerprint(configPath, envPath);
    const b = tenantFingerprint(configPath, envPath);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test("an absent .env and one that only carries GH_TOKEN differ", () => {
    // Presence of the file — and of the token itself — is still counted; only
    // the token's value is rotation-invisible.
    const { configPath, envPath } = setup();
    const absent = tenantFingerprint(configPath, envPath);
    writeFileSync(envPath, "GH_TOKEN=ghp_x\n");
    const present = tenantFingerprint(configPath, envPath);
    expect(present).not.toBeNull();
    expect(present).not.toBe(absent);
  });
});

// --- minBootstrap floor ------------------------------------------------------

describe("checkMinBootstrap", () => {
  const pkg = (minBootstrap: unknown) =>
    JSON.stringify({
      name: "phoebe-agent",
      version: "0.8.0",
      phoebe: { minBootstrap },
    });

  test("no package.json in the engine checkout — no floor", () => {
    expect(() =>
      checkMinBootstrap({
        launcherVersion: "0.3.0",
        engineDir: "/fake/engine",
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).not.toThrow();
  });

  test("package.json present but no phoebe.minBootstrap field — no floor", () => {
    expect(() =>
      checkMinBootstrap({
        launcherVersion: "0.3.0",
        engineDir: "/fake/engine",
        readFile: () => JSON.stringify({ name: "phoebe-agent", version: "0.8.0" }),
      }),
    ).not.toThrow();
  });

  test("phoebe.minBootstrap is an unparseable type — no floor", () => {
    expect(() =>
      checkMinBootstrap({
        launcherVersion: "0.3.0",
        engineDir: "/fake/engine",
        readFile: () => pkg(42),
      }),
    ).not.toThrow();
  });

  test("floor met — launcher exactly at the floor", () => {
    expect(() =>
      checkMinBootstrap({
        launcherVersion: "0.7.0",
        engineDir: "/fake/engine",
        readFile: () => pkg("0.7.0"),
      }),
    ).not.toThrow();
  });

  test("floor met — launcher above the floor", () => {
    expect(() =>
      checkMinBootstrap({
        launcherVersion: "0.8.1",
        engineDir: "/fake/engine",
        readFile: () => pkg("0.7.0"),
      }),
    ).not.toThrow();
  });

  test("floor violated — error names both versions and the two fixes", () => {
    expect(() =>
      checkMinBootstrap({
        launcherVersion: "0.3.0",
        engineDir: "/fake/engine",
        readFile: () => pkg("0.7.0"),
      }),
    ).toThrow(/0\.7\.0.*0\.3\.0|0\.3\.0.*0\.7\.0/);
  });

  test("floor violated — error mentions the Dockerfile pin", () => {
    let message = "";
    try {
      checkMinBootstrap({
        launcherVersion: "0.3.0",
        engineDir: "/fake/engine",
        readFile: () => pkg("0.7.0"),
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/Dockerfile/);
    expect(message).toMatch(/rebuild/i);
  });

  test("floor violated — minor version comparison is numeric, not lexicographic", () => {
    // "0.9.0" > "0.10.0" lexicographically, but 9 < 10 numerically.
    expect(() =>
      checkMinBootstrap({
        launcherVersion: "0.9.0",
        engineDir: "/fake/engine",
        readFile: () => pkg("0.10.0"),
      }),
    ).toThrow();
  });
});

describe("tenantFingerprint — token removal (retention regression)", () => {
  test("removing the GH_TOKEN line moves the fingerprint — removal must relaunch", () => {
    // A lease answer can deliver a new token but not an absence (null means
    // "keep what you have"), so the only way a deleted PAT stops being used is
    // the relaunch: the respawned child's scrubbed env genuinely lacks it.
    const dir = mkdtempSync(join(tmpdir(), "phoebe-fp-"));
    const configPath = join(dir, "phoebe.config.ts");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, "export default { repoSlug: 'acme/widget' };\n");
    writeFileSync(envPath, "GH_TOKEN=ghp_x\nCURSOR_API_KEY=sk-1\n");
    const withToken = tenantFingerprint(configPath, envPath);
    writeFileSync(envPath, "CURSOR_API_KEY=sk-1\n");
    expect(tenantFingerprint(configPath, envPath)).not.toBe(withToken);
  });
});
