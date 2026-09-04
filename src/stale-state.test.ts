// The stale-state sweep (#426), against a real data directory and a real
// clone. Every interesting case is a filesystem or git fact — a lease that
// outlived its pipeline, a worktree with a commit origin has not seen — so
// stubbing them out would test the stubs.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { asBranchRef } from "./branded.ts";
import { CLONE_LOCK_DIR } from "./clone-lock.ts";
import { resolveConfig, type PathsConfig, type PhoebeUserConfig } from "./config-schema.ts";
import {
  addWorktreeDetached,
  addWorktreeForNewBranch,
  lockWorktree,
  type GitRunner,
} from "./git-model.ts";
import { READONLY_WORKTREES_SEGMENT } from "./paths.ts";
import {
  applyStaleStateSweep,
  createWorktreeInspector,
  parseSweepStateArgs,
  pipelineOwnership,
  scanStaleState,
  sweepStaleState,
  type PipelineOwnership,
  type StaleItem,
} from "./stale-state.ts";
import { unitOwner } from "./unit-scope.ts";
import { formatLeaseReason } from "./worktree-lease.ts";

const IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });

const testGit: GitRunner = (args, opts) =>
  execFileSync("git", [...IDENTITY, ...args], {
    encoding: "utf8",
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    ...(opts?.stdio ? { stdio: opts.stdio } : {}),
  }) as unknown as string;

let root: string;
let paths: PathsConfig;

/** A tenant data directory with a seeded clone, as the container lays it out. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "phoebe-stale-state-"));
  paths = {
    repoDir: join(root, "repo"),
    worktreesDir: join(root, "worktrees"),
    stateDir: join(root, "state"),
    scratchDir: join(root, "scratch"),
  };
  execFileSync("git", ["init", "-b", "main", paths.repoDir], { encoding: "utf8" });
  writeFileSync(join(paths.repoDir, "README.md"), "seed\n");
  git(paths.repoDir, "add", ".");
  git(paths.repoDir, "commit", "-m", "seed");
  git(paths.repoDir, "update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function owns(pipelines: string[], kinds: string[]): PipelineOwnership {
  return { pipelines: new Set(pipelines), kinds: new Set(kinds) };
}

function inspector() {
  return createWorktreeInspector({ repoDir: paths.repoDir, defaultBranch: "main", git: testGit });
}

function sweep(ownership: PipelineOwnership) {
  return sweepStaleState({ paths, ownership, inspector: inspector() });
}

function stateDirFor(pipeline: string): string {
  const dir = join(paths.stateDir, pipeline);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), "{}\n");
  return dir;
}

function scratchDirFor(kind: string): string {
  const dir = join(paths.scratchDir, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.md"), "work\n");
  return dir;
}

/** A unit worktree on its own branch, optionally leased by `pipeline`. */
function unitWorktree(branch: string, opts: { lease?: string; published?: boolean } = {}): string {
  const ref = asBranchRef(branch);
  const dir = join(paths.worktreesDir, branch.replace(/[^a-z0-9]/g, "-"));
  addWorktreeForNewBranch(
    { repoDir: paths.repoDir, worktreeDir: dir, branch: ref, baseRef: "origin/main" },
    testGit,
  );
  if (opts.published === true) {
    git(paths.repoDir, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  }
  if (opts.lease !== undefined) {
    lockWorktree(
      paths.repoDir,
      dir,
      // As a live engine writes it since #423: the pipeline, then the unit that
      // holds the tree. The sweep reads the pipeline segment alone.
      formatLeaseReason({
        owner: unitOwner(opts.lease, { kind: "issues", id: branch }),
        pid: 4242,
      }),
      testGit,
    );
  }
  return dir;
}

/** One unit's read-only workspace, at the per-unit path #423 gave it. */
function readonlyWorktree(kind: string, opts: { lease?: string; ref?: string } = {}): string {
  const ref = opts.ref ?? "1";
  const dir = join(paths.worktreesDir, READONLY_WORKTREES_SEGMENT, kind, ref);
  addWorktreeDetached({ repoDir: paths.repoDir, worktreeDir: dir, ref: "origin/main" }, testGit);
  if (opts.lease !== undefined) {
    lockWorktree(
      paths.repoDir,
      dir,
      formatLeaseReason({ owner: unitOwner(opts.lease, { kind, id: ref }), pid: 99 }),
      testGit,
    );
  }
  return dir;
}

function userConfig(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

function ownershipOf(overrides: Partial<PhoebeUserConfig> = {}): PipelineOwnership {
  return pipelineOwnership(resolveConfig(userConfig(overrides), { dataBase: "/tmp/phoebe-test" }));
}

const CUSTOM_KIND = { module: "./triage.ts" };

describe("pipelineOwnership", () => {
  test("a config with no pipelines block owns the work pipeline and every built-in", () => {
    const ownership = ownershipOf();
    expect([...ownership.pipelines]).toEqual(["work"]);
    expect(ownership.kinds.has("issues")).toBe(true);
  });

  test("a disabled pipeline is still enumerated, so its state is stopped and not orphaned", () => {
    const ownership = ownershipOf({
      pipelines: {
        work: {},
        intake: { disabled: true, kinds: { triage: CUSTOM_KIND } },
      },
    });
    expect(ownership.pipelines.has("intake")).toBe(true);
    expect(ownership.kinds.has("triage")).toBe(true);
  });

  test("a kind that moved between pipelines is still owned", () => {
    const before = ownershipOf({
      pipelines: { work: {}, intake: { kinds: { triage: CUSTOM_KIND } } },
    });
    const after = ownershipOf({
      pipelines: { work: { kinds: { triage: CUSTOM_KIND } }, intake: {} },
    });
    expect(before.kinds.has("triage")).toBe(true);
    expect(after.kinds.has("triage")).toBe(true);
  });

  test("a retired kind is owned by nobody", () => {
    expect(ownershipOf({ pipelines: { work: {} } }).kinds.has("triage")).toBe(false);
  });
});

describe("state directories", () => {
  test("a renamed pipeline loses its old state and the new name is untouched", () => {
    const intake = stateDirFor("intake");
    const inbox = stateDirFor("inbox");

    const result = sweep(owns(["work", "inbox"], ["issues"]));

    expect(existsSync(intake)).toBe(false);
    expect(existsSync(inbox)).toBe(true);
    expect(result.removed.map((item) => item.path)).toContain(intake);
  });

  test("a disabled pipeline keeps its state directory", () => {
    const intake = stateDirFor("intake");
    sweep(owns(["work", "intake"], ["issues"]));
    expect(existsSync(intake)).toBe(true);
  });

  test("the clone lock is not a pipeline's directory", () => {
    const lock = join(paths.stateDir, CLONE_LOCK_DIR);
    mkdirSync(lock, { recursive: true });
    sweep(owns(["work"], ["issues"]));
    expect(existsSync(lock)).toBe(true);
  });

  test("a stray status tmp file is reported and goes with its orphaned directory", () => {
    const intake = stateDirFor("intake");
    const tmp = join(intake, ".4242.status.json.tmp");
    writeFileSync(tmp, "{}\n");

    const result = sweep(owns(["work"], ["issues"]));

    expect(result.removed.some((item) => item.tier === "tmp" && item.path === tmp)).toBe(true);
    expect(existsSync(intake)).toBe(false);
  });

  test("a live pipeline's directory is never opened for tmp files", () => {
    const work = stateDirFor("work");
    const tmp = join(work, ".7.status.json.tmp");
    writeFileSync(tmp, "{}\n");

    const result = sweep(owns(["work"], ["issues"]));

    expect(result.removed).toEqual([]);
    expect(existsSync(tmp)).toBe(true);
  });
});

describe("scratch directories", () => {
  test("a retired kind's scratch goes and an owned kind's stays", () => {
    const retired = scratchDirFor("triage");
    const owned = scratchDirFor("issues");

    sweep(owns(["work"], ["issues"]));

    expect(existsSync(retired)).toBe(false);
    expect(existsSync(owned)).toBe(true);
  });

  test("a kind that moved to another pipeline keeps its scratch", () => {
    const dir = scratchDirFor("triage");
    sweep(
      pipelineOwnership(
        resolveConfig(userConfig({ pipelines: { work: { kinds: { triage: CUSTOM_KIND } } } }), {
          dataBase: "/tmp/phoebe-test",
        }),
      ),
    );
    expect(existsSync(dir)).toBe(true);
  });
});

describe("worktrees", () => {
  test("the clone itself is never a candidate", () => {
    const items = scanStaleState({
      paths,
      ownership: owns(["work"], ["issues"]),
      inspector: inspector(),
    });
    expect(items.map((item) => item.path)).not.toContain(paths.repoDir);
  });

  test("a clean tree leased by a pipeline no pipeline produces is unlocked and removed", () => {
    const dir = unitWorktree("phoebe/issue-9", { lease: "intake", published: true });

    const result = sweep(owns(["work"], ["issues"]));

    expect(existsSync(dir)).toBe(false);
    expect(result.removed.some((item) => item.path === dir)).toBe(true);
  });

  test("a dirty tree is left in place and reported with its path and a reclaim hint", () => {
    const dir = unitWorktree("phoebe/issue-10", { lease: "intake", published: true });
    writeFileSync(join(dir, "half-done.txt"), "in progress\n");

    const result = sweep(owns(["work"], ["issues"]));

    expect(existsSync(dir)).toBe(true);
    const kept = result.kept.find((item) => item.path === dir);
    expect(kept?.reclaim).toContain("worktree remove --force");
    expect(kept?.detail).toContain("not clean");
    expect(result.removed).toEqual([]);
  });

  test("a tree holding a commit origin has never seen is left in place", () => {
    const dir = unitWorktree("phoebe/issue-11", { lease: "intake" });
    writeFileSync(join(dir, "work.txt"), "unit\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "unit work");

    const result = sweep(owns(["work"], ["issues"]));

    expect(existsSync(dir)).toBe(true);
    expect(result.kept.map((item) => item.path)).toEqual([dir]);
  });

  test("a tree leased by a live pipeline is untouchable", () => {
    const dir = unitWorktree("phoebe/issue-12", { lease: "work", published: true });

    const result = sweep(owns(["work"], ["issues"]));

    expect(existsSync(dir)).toBe(true);
    expect([...result.removed, ...result.kept]).toEqual([]);
  });

  test("an unlocked tree is a candidate — no unit holds it", () => {
    const dir = unitWorktree("phoebe/issue-13", { published: true });

    const result = sweep(owns(["work"], ["issues"]));

    expect(existsSync(dir)).toBe(false);
    expect(result.removed.map((item) => item.path)).toEqual([dir]);
  });

  test("a lock Phoebe did not write is reported, never broken", () => {
    const dir = unitWorktree("phoebe/issue-14", { published: true });
    execFileSync("git", ["worktree", "lock", "--reason", "operator: debugging", dir], {
      cwd: paths.repoDir,
      encoding: "utf8",
    });

    const result = sweep(owns(["work"], ["issues"]));

    expect(existsSync(dir)).toBe(true);
    expect(result.kept[0]?.detail).toContain("Phoebe did not write");
  });

  test("a read-only tree for a retired kind is removed", () => {
    const dir = readonlyWorktree("triage", { lease: "intake" });

    const result = sweep(owns(["work"], ["issues"]));

    expect(existsSync(dir)).toBe(false);
    expect(result.removed.some((item) => item.tier === "readonly")).toBe(true);
  });

  test("a read-only tree a live pipeline is working in survives", () => {
    const dir = readonlyWorktree("research", { lease: "work" });
    sweep(owns(["work"], ["research"]));
    expect(existsSync(dir)).toBe(true);
  });

  test("a retired kind's directory survives while a tree the sweep kept is inside it", () => {
    const kindDir = join(paths.worktreesDir, READONLY_WORKTREES_SEGMENT, "triage");
    const dir = readonlyWorktree("triage", { lease: "intake" });
    writeFileSync(join(dir, "notes.md"), "unsaved\n");

    const result = sweep(owns(["work"], ["issues"]));

    expect(result.kept.map((item) => item.path)).toEqual([dir]);
    expect(existsSync(join(dir, "notes.md"))).toBe(true);
    expect(existsSync(kindDir)).toBe(true);
  });

  test("a retired kind's read-only directory git has no record of is removed", () => {
    const dir = join(paths.worktreesDir, READONLY_WORKTREES_SEGMENT, "triage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "leftover.txt"), "x\n");

    sweep(owns(["work"], ["issues"]));

    expect(existsSync(dir)).toBe(false);
  });

  test("no clone means no worktree tier, and the rest still sweeps", () => {
    const intake = stateDirFor("intake");
    const items = scanStaleState({ paths, ownership: owns(["work"], ["issues"]), inspector: null });
    expect(items.map((item) => item.path)).toEqual([intake]);
  });
});

describe("applyStaleStateSweep", () => {
  test("one item's failure does not stop the next", () => {
    const good = stateDirFor("intake");
    const items: StaleItem[] = [
      { tier: "worktree", path: join(root, "gone"), detail: "orphan", reclaim: null },
      { tier: "state", path: good, detail: "orphan", reclaim: null },
    ];
    const failing = {
      list: () => [],
      inspect: () => null,
      release: () => {
        throw new Error("git said no");
      },
    };

    const result = applyStaleStateSweep(items, failing);

    expect(result.failed).toHaveLength(1);
    expect(result.removed.map((item) => item.path)).toEqual([good]);
    expect(existsSync(good)).toBe(false);
  });

  test("the protected tier is kept, never attempted", () => {
    const dir = stateDirFor("intake");
    const result = applyStaleStateSweep(
      [{ tier: "worktree", path: dir, detail: "dirty", reclaim: "do it yourself" }],
      null,
    );
    expect(result.kept).toHaveLength(1);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("parseSweepStateArgs", () => {
  test("reads the config path and the json flag", () => {
    expect(parseSweepStateArgs(["--config", "a/phoebe.config.ts", "--json"])).toEqual({
      configPath: "a/phoebe.config.ts",
      json: true,
      help: false,
    });
    expect(parseSweepStateArgs(["--config=b.ts"]).configPath).toBe("b.ts");
  });

  test("an unknown argument is a loud failure, not a silent full sweep", () => {
    expect(() => parseSweepStateArgs(["--force"])).toThrow(/Unknown argument/);
    expect(() => parseSweepStateArgs(["--config"])).toThrow(/requires a path/);
  });
});
