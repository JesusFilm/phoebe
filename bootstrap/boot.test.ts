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
  pipelineArgv,
  tenantFingerprint,
  trackPipelines,
  workspacePipelineFingerprint,
} from "./boot.ts";
import type { SupervisedPipeline } from "./pipelines.ts";
import { createSlotBroker } from "./slot-broker.ts";

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

describe("pipelineArgv", () => {
  const pipeline = (name: string, enumerated: boolean): SupervisedPipeline => ({
    id: `/etc/phoebe/repos/acme/widget#${name}`,
    tenant: {
      id: "/etc/phoebe/repos/acme/widget",
      slug: "acme/widget",
      dir: "/etc/phoebe/repos/acme/widget",
      configPath: "/etc/phoebe/repos/acme/widget/phoebe.config.ts",
      envPath: "/etc/phoebe/repos/acme/widget/.env",
      gitIdentity: null,
    },
    pipeline: {
      name,
      disabled: false,
      priority: 0,
      concurrency: 1,
      needsClone: true,
      env: [],
      fingerprint: enumerated ? "abc123" : null,
    },
    enumerated,
    siblingEnv: [],
  });

  test("names the pipeline the child is to run", () => {
    expect(
      pipelineArgv(
        pipeline("intake", true),
        "/etc/phoebe/repos/acme/widget/phoebe.config.ts",
        false,
        [],
      ),
    ) //
      .toEqual(["--pipeline", "intake"]);
  });

  test("keeps `--config` for a relocated asset dir, ahead of the pipeline", () => {
    const configPath = "/etc/phoebe/repos/acme/widget/phoebe.config.ts";
    expect(pipelineArgv(pipeline("work", true), configPath, true, ["--dry-run"])).toEqual([
      "--config",
      configPath,
      "--pipeline",
      "work",
      "--dry-run",
    ]);
  });

  test("omits `--pipeline` for the implicit pipeline of an engine that cannot enumerate", () => {
    // That checkout has no such flag and would exit on it before reading a
    // config, so an engine downgrade must stay a no-op (#417).
    expect(
      pipelineArgv(
        pipeline("work", false),
        "/etc/phoebe/repos/acme/widget/phoebe.config.ts",
        false,
        ["--run-once"],
      ),
    ) //
      .toEqual(["--run-once"]);
  });
});

describe("trackPipelines", () => {
  const pipeline = (
    slug: string,
    name: string,
    knobs: { concurrency?: number; priority?: number } = {},
  ): SupervisedPipeline => ({
    id: `/etc/phoebe/repos/${slug}#${name}`,
    tenant: {
      id: `/etc/phoebe/repos/${slug}`,
      slug,
      dir: `/etc/phoebe/repos/${slug}`,
      configPath: `/etc/phoebe/repos/${slug}/phoebe.config.ts`,
      envPath: `/etc/phoebe/repos/${slug}/.env`,
      gitIdentity: null,
    },
    pipeline: {
      name,
      disabled: false,
      priority: knobs.priority ?? 0,
      concurrency: knobs.concurrency ?? 1,
      needsClone: true,
      env: [],
      fingerprint: "abc123",
    },
    enumerated: true,
    siblingEnv: [],
  });

  /** Swap `console.log` for a recorder: the cap line is operator-facing output. */
  function captureLog(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    return {
      lines,
      restore: () => {
        console.log = original;
      },
    };
  }

  const MATRIX = [
    pipeline("acme/widget", "work"),
    pipeline("acme/widget", "intake"),
    pipeline("acme/gadget", "work", { concurrency: 4 }),
  ];

  test("derives the cap from the live pipelines and logs the derivation once", () => {
    const broker = createSlotBroker({ capacity: 1 });
    const log = captureLog();
    try {
      const track = trackPipelines(broker, {});
      track({ pipelines: MATRIX, reshaped: true });
      expect(broker.capacity).toBe(4);
      // Pipelines declaring 1, 1 and 4 derive 4, and the line says where from.
      expect(log.lines).toEqual([
        "[phoebe] boot: slot cap 4 — max(concurrency)=4 from acme/gadget:work; floorBudget=1",
      ]);
      // A second reshape saying the same thing does not repeat itself.
      track({ pipelines: MATRIX, reshaped: true });
      expect(log.lines).toHaveLength(1);
    } finally {
      log.restore();
    }
  });

  test("the env replaces the derivation, and the over-cap pipeline is named as queuing", () => {
    const broker = createSlotBroker({ capacity: 1 });
    const log = captureLog();
    try {
      trackPipelines(broker, { PHOEBE_MAX_CONCURRENT_AGENTS: "2" })({
        pipelines: MATRIX,
        reshaped: true,
      });
      expect(broker.capacity).toBe(2);
      expect(log.lines[0]).toContain("slot cap 2 — PHOEBE_MAX_CONCURRENT_AGENTS=2");
      expect(log.lines[0]).toContain("acme/gadget:work(4)");
    } finally {
      log.restore();
    }
  });

  test("a poll that reshaped nothing refreshes the ordering but not the cap", async () => {
    const broker = createSlotBroker({ capacity: 1, floorBudget: 0 });
    const log = captureLog();
    try {
      const track = trackPipelines(broker, {});
      track({
        pipelines: [pipeline("acme/widget", "work"), pipeline("acme/widget", "intake")],
        reshaped: true,
      });
      expect(broker.capacity).toBe(1);

      await broker.acquire("/etc/phoebe/repos/acme/widget#work");
      let urgent = false;
      const waiting = [
        broker.acquire("/etc/phoebe/repos/acme/widget#intake"),
        broker.acquire("/etc/phoebe/repos/acme/widget#urgent").then(() => {
          urgent = true;
        }),
      ];

      // A hot `priority` edit: the pipeline set is the same shape, so the cap holds
      // still while the queue reorders behind it.
      track({
        pipelines: [
          pipeline("acme/widget", "work", { concurrency: 8 }),
          pipeline("acme/widget", "intake"),
          pipeline("acme/widget", "urgent", { priority: 5 }),
        ],
        reshaped: false,
      });
      expect(broker.capacity).toBe(1);
      expect(log.lines).toHaveLength(1);

      broker.release("/etc/phoebe/repos/acme/widget#work");
      await Promise.race(waiting);
      expect(urgent).toBe(true);
    } finally {
      log.restore();
    }
  });
});

describe("workspacePipelineFingerprint", () => {
  function tenantDir(env: string): {
    dir: string;
    pipeline: (name: string, own: string[], siblings: string[]) => SupervisedPipeline;
  } {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-pipeline-fp-"));
    writeFileSync(join(dir, ".env"), env);
    return {
      dir,
      pipeline: (name, own, siblings) => ({
        id: `${dir}#${name}`,
        tenant: {
          id: dir,
          slug: "acme/widget",
          dir,
          configPath: join(dir, "phoebe.config.ts"),
          envPath: join(dir, ".env"),
          gitIdentity: null,
        },
        pipeline: {
          name,
          disabled: false,
          priority: 0,
          concurrency: 1,
          needsClone: true,
          env: own,
          fingerprint: "fp",
        },
        enumerated: true,
        siblingEnv: siblings,
      }),
    };
  }

  test("rotating a declared key moves the declaring pipeline and not its sibling", () => {
    const before = tenantDir("SLACK_BOT_TOKEN=xoxb-1\nFOO=public\n");
    const after = tenantDir("SLACK_BOT_TOKEN=xoxb-2\nFOO=public\n");
    const intake = (t: ReturnType<typeof tenantDir>) =>
      t.pipeline("intake", ["SLACK_BOT_TOKEN"], []);
    const work = (t: ReturnType<typeof tenantDir>) => t.pipeline("work", [], ["SLACK_BOT_TOKEN"]);

    expect(workspacePipelineFingerprint(intake(after), "fp")).not.toBe(
      workspacePipelineFingerprint(intake(before), "fp"),
    );
    expect(workspacePipelineFingerprint(work(after), "fp")).toBe(
      workspacePipelineFingerprint(work(before), "fp"),
    );
  });

  test("rotating an undeclared key moves both pipelines", () => {
    const before = tenantDir("SLACK_BOT_TOKEN=xoxb-1\nFOO=public\n");
    const after = tenantDir("SLACK_BOT_TOKEN=xoxb-1\nFOO=changed\n");
    for (const [own, siblings] of [
      [["SLACK_BOT_TOKEN"], []],
      [[], ["SLACK_BOT_TOKEN"]],
    ] as const) {
      expect(
        workspacePipelineFingerprint(after.pipeline("r", [...own], [...siblings]), "fp"),
      ).not.toBe(workspacePipelineFingerprint(before.pipeline("r", [...own], [...siblings]), "fp"));
    }
  });

  test("an unknown enumerated fingerprint stays unknown", () => {
    const t = tenantDir("FOO=public\n");
    expect(workspacePipelineFingerprint(t.pipeline("work", [], []), null)).toBeNull();
  });
});
