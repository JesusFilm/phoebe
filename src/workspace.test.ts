// Repo-governance guard for the pnpm workspace (#529, decided in #521).
//
// The workspace exists so apps can live beside the published package. The
// property that matters is what it must *not* change: `phoebe-agent` stays at
// the root, publishes the same tarball, and gains no dependency on anything
// under `apps/`. The assertions below pin that boundary plus the three settings
// the apps rely on — the linker, electron's build allowance, and the root gate
// building every app.
//
// Sibling of container-image.test.ts, and under `src/` for the same reason:
// test files never ship (package.json `files` excludes `**/*.test.ts`) and
// `vp test` already covers this tree.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const repoRoot = join(import.meta.dirname, "..");

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

/** A YAML file with `#` comment lines stripped — assert against instructions. */
function settingsOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const workspace = settingsOnly(read("pnpm-workspace.yaml"));
const rootManifest = JSON.parse(read("package.json")) as {
  private?: boolean;
  files: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
};

/** Every `apps/*` package manifest, by directory name. Empty until one lands. */
function appManifests(): Array<{ dir: string; manifest: Record<string, unknown> }> {
  let entries: string[];
  try {
    entries = readdirSync(join(repoRoot, "apps"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((dir) => statSync(join(repoRoot, "apps", dir)).isDirectory())
    .map((dir) => ({
      dir,
      manifest: JSON.parse(read(join("apps", dir, "package.json"))) as Record<string, unknown>,
    }));
}

describe("pnpm-workspace.yaml", () => {
  test("covers apps/*", () => {
    expect(workspace).toMatch(/^\s*-\s*["']?apps\/\*["']?\s*$/m);
  });

  test("names the isolated linker rather than leaning on the default", () => {
    expect(workspace).toMatch(/^nodeLinker:\s*isolated\s*$/m);
  });

  test("allows electron's build and nothing else", () => {
    const allowBuilds = workspace.match(/^allowBuilds:\n((?:\s+\S.*\n?)*)/m);
    expect(allowBuilds).not.toBeNull();
    const entries = allowBuilds![1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    // An entry set to `false` is a script somebody read and decided not to run,
    // which pnpm wants said out loud. Only a `true` lets anything execute.
    expect(entries.filter((entry) => entry.endsWith(": true"))).toEqual(["electron: true"]);
    expect(entries.every((entry) => /: (true|false)$/.test(entry))).toBe(true);
  });
});

describe("the root ready gate", () => {
  test("recurses over lint, typecheck, test and build", () => {
    for (const target of ["lint", "typecheck", "test", "build"]) {
      expect(rootManifest.scripts.ready).toContain(`vp run -r ${target}`);
    }
  });

  test("keeps a build task for `-r build` to find", () => {
    // `vp run -r <task>` exits non-zero when no package in the workspace
    // defines the task, so the root holds a build script of its own until an
    // app under apps/* brings a real one.
    expect(rootManifest.scripts.build).toBeTruthy();
  });
});

describe("the published package is unaffected by the workspace", () => {
  test("`files` reaches nothing under apps/", () => {
    // `files` entries are packlist rules, not paths — a broad `**/*` or a
    // negated `!apps/**` would pass a check against the raw entries while
    // still changing what ships. Assert against the tarball npm actually
    // resolves instead.
    const dryRun = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const [{ files }] = JSON.parse(dryRun) as Array<{ files: Array<{ path: string }> }>;
    for (const { path } of files) {
      expect(path.startsWith("apps/")).toBe(false);
    }
  });

  test("the root package depends on no workspace package", () => {
    for (const range of Object.values(rootManifest.dependencies ?? {})) {
      expect(range.startsWith("workspace:")).toBe(false);
    }
  });
});

describe("apps/*", () => {
  test("every app is private, so `changeset version` skips it", () => {
    for (const { dir, manifest } of appManifests()) {
      expect(manifest.private, `apps/${dir} must be private`).toBe(true);
    }
  });

  test("private packages are skipped by the changeset config", () => {
    const changesets = JSON.parse(read(".changeset/config.json")) as {
      privatePackages?: { version?: boolean; tag?: boolean };
    };
    expect(changesets.privatePackages).toEqual({ version: false, tag: false });
  });
});

describe("the dogfood container", () => {
  test("skips electron's binary download so none lands in a worktree", () => {
    expect(settingsOnly(read(".phoebe/container/compose.yml"))).toMatch(
      /^\s*ELECTRON_SKIP_BINARY_DOWNLOAD:\s*"1"\s*$/m,
    );
  });
});
