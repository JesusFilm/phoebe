// The origin hub is a seam, not logic — every method forwards to `git-model`,
// which has its own tests against a real repo. `commitsBehind` is the exception
// worth pinning here: it composes a revision range, and a range composed the
// wrong way round still returns a plausible number. Reversed, the feature-branch
// catch-up (#382) would fire on a branch that is *ahead* of the default branch
// and ignore one that has fallen behind it — the exact failure it exists to
// prevent, reported as success.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { asBranchRef } from "./branded.ts";
import { resolveConfig } from "./config-schema.ts";
import type { GitRunner } from "./git-model.ts";
import { createOriginHub } from "./origin-hub.ts";

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
  }) as unknown as string;

const FEATURE = asBranchRef("phoebe/feature-341");

let root: string;
let repoDir: string;

function commit(message: string): void {
  writeFileSync(join(repoDir, `${message}.txt`), `${message}\n`);
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", message);
}

beforeAll(() => {
  // `<dataBase>/<repoSlug>/repo` is where `derivePaths` puts the private clone,
  // so building the hub against this root gives it the real directory layout.
  root = mkdtempSync(join(tmpdir(), "phoebe-origin-hub-"));
  repoDir = join(root, "acme", "widget", "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { encoding: "utf8" });
  commit("seed");
  // The remote-tracking refs are written directly rather than fetched: no live
  // transport runs in this suite (see src/git-model.test.ts's header).
  git(repoDir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repoDir, "update-ref", `refs/remotes/origin/${FEATURE}`, "HEAD");
  commit("one");
  commit("two");
  git(repoDir, "update-ref", "refs/remotes/origin/main", "HEAD");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function hub() {
  const config = resolveConfig(
    {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
      readyCommand: "npm run ready",
    },
    { dataBase: root },
  );
  return createOriginHub(config, true, testGit);
}

describe("commitsBehind", () => {
  test("counts the commits the upstream carries and the branch does not", () => {
    expect(hub().commitsBehind(FEATURE, "main")).toBe(2);
  });

  test("reads zero the other way round — the branch is not ahead", () => {
    expect(hub().commitsBehind(asBranchRef("main"), FEATURE)).toBe(0);
  });

  test("reads zero for a branch level with its upstream", () => {
    expect(hub().commitsBehind(asBranchRef("main"), "main")).toBe(0);
  });
});
