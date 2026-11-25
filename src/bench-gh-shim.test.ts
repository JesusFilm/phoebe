// The `gh` a bench trial sees (#940): reads come from the snapshot, writes are
// recorded and answered with a plausible success, nothing reaches GitHub.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  answerGh,
  GH_SHIM_SNAPSHOT_FILE,
  GH_SHIM_WOULD_HAVE_FILE,
  type GhShimIo,
  type GhShimSnapshot,
} from "./bench-gh-shim.ts";

const SNAPSHOT: GhShimSnapshot = {
  repo: "acme/widget",
  defaultBranch: "main",
  fixture: {
    issue: {
      number: 7,
      title: "Make the widget spin",
      body: "It should spin.",
      comments: [{ author: "ana", createdAt: "2026-11-01T00:00:00Z", body: "Clockwise, please." }],
    },
    pr: { number: 70, headSha: "a".repeat(40), mergeSha: "b".repeat(40) },
    baseSha: "c".repeat(40),
  },
};

function io(overrides: Partial<GhShimIo> = {}): GhShimIo {
  return {
    now: () => new Date("2026-11-25T12:00:00Z"),
    cwd: "/trial/repo",
    readFile: () => null,
    readStdin: () => "",
    jq: () => null,
    ...overrides,
  };
}

describe("answerGh: reads", () => {
  test("gh issue view --json serves the snapshot", () => {
    const answer = answerGh(
      ["issue", "view", "7", "--json", "number,title,body,comments"],
      SNAPSHOT,
      io(),
    );
    expect(answer.code).toBe(0);
    expect(answer.wouldHave).toBeUndefined();
    expect(JSON.parse(answer.stdout)).toEqual({
      number: 7,
      title: "Make the widget spin",
      body: "It should spin.",
      comments: [
        { author: { login: "ana" }, body: "Clockwise, please.", createdAt: "2026-11-01T00:00:00Z" },
      ],
    });
  });

  test("--jq goes through jq when there is one, and prints the JSON when there is not", () => {
    const seen: string[] = [];
    const filtered = answerGh(
      ["issue", "view", "7", "--json", "title", "--jq", ".title"],
      SNAPSHOT,
      io({
        jq: (json, filter) => {
          seen.push(json, filter);
          return { stdout: "Make the widget spin\n", code: 0 };
        },
      }),
    );
    expect(filtered.stdout).toBe("Make the widget spin\n");
    expect(seen).toEqual(['{"title":"Make the widget spin"}', ".title"]);

    const unfiltered = answerGh(
      ["issue", "view", "7", "--json", "title", "-q", ".title"],
      SNAPSHOT,
      io(),
    );
    expect(JSON.parse(unfiltered.stdout)).toEqual({ title: "Make the widget spin" });
    expect(unfiltered.stderr).toMatch(/no jq/);
  });

  test("the plain view prints title, body and, with --comments, the comments", () => {
    const plain = answerGh(["issue", "view", "#7", "-R", "acme/widget"], SNAPSHOT, io());
    expect(plain.stdout).toContain("title:\tMake the widget spin");
    expect(plain.stdout).toContain("It should spin.");
    expect(plain.stdout).not.toContain("Clockwise");
    const withComments = answerGh(
      ["issue", "view", "https://github.com/acme/widget/issues/7", "--comments"],
      SNAPSHOT,
      io(),
    );
    expect(withComments.stdout).toContain("Clockwise, please.");
  });

  test("another issue is not found, as GitHub would say", () => {
    const answer = answerGh(["issue", "view", "8"], SNAPSHOT, io());
    expect(answer.code).toBe(1);
    expect(answer.stderr).toMatch(/Could not resolve to an issue/);
  });

  test("lists are empty, and reads with no snapshot fail saying the trial is offline", () => {
    expect(answerGh(["pr", "list", "--json", "number"], SNAPSHOT, io()).stdout).toBe("[]\n");
    expect(answerGh(["issue", "list"], SNAPSHOT, io())).toMatchObject({ stdout: "", code: 0 });
    expect(answerGh(["pr", "view"], SNAPSHOT, io()).code).toBe(1);
    const api = answerGh(["api", "repos/acme/widget/pulls"], SNAPSHOT, io());
    expect(api.code).toBe(1);
    expect(api.stderr).toMatch(/not available offline/);
  });

  test("gh api reads of the fixture's issue come from the snapshot", () => {
    const answer = answerGh(["api", "repos/acme/widget/issues/7/comments"], SNAPSHOT, io());
    expect(JSON.parse(answer.stdout)).toEqual([
      { user: { login: "ana" }, body: "Clockwise, please.", created_at: "2026-11-01T00:00:00Z" },
    ]);
  });

  test("gh repo view names the repo and its default branch", () => {
    const answer = answerGh(
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      SNAPSHOT,
      io(),
    );
    expect(JSON.parse(answer.stdout)).toEqual({
      nameWithOwner: "acme/widget",
      defaultBranchRef: { name: "main" },
    });
  });
});

describe("answerGh: writes", () => {
  test("gh pr create is recorded and answers with a PR URL", () => {
    const argv = [
      "pr",
      "create",
      "--base",
      "main",
      "--title",
      "Phoebe: spin",
      "--body",
      "Closes #7",
    ];
    const answer = answerGh(argv, SNAPSHOT, io());
    expect(answer).toEqual({
      stdout: "https://github.com/acme/widget/pull/70\n",
      stderr: "",
      code: 0,
      wouldHave: { at: "2026-11-25T12:00:00.000Z", command: "pr create", argv },
    });
  });

  test("a body file is read when the call is made", () => {
    const answer = answerGh(
      ["issue", "comment", "7", "--body-file", "note.md"],
      SNAPSHOT,
      io({ readFile: (path) => (path === "/trial/repo/note.md" ? "Addressed." : null) }),
    );
    expect(answer.stdout).toBe("https://github.com/acme/widget/issues/7#issuecomment-1\n");
    expect(answer.wouldHave).toMatchObject({ command: "issue comment", bodyFile: "Addressed." });
  });

  test("gh api is a write when it says so or carries fields", () => {
    expect(
      answerGh(["api", "-X", "PATCH", "repos/acme/widget/issues/7"], SNAPSHOT, io()).wouldHave,
    ).toMatchObject({ command: "api" });
    expect(
      answerGh(["api", "repos/acme/widget/issues/7/labels", "-f", "labels[]=x"], SNAPSHOT, io())
        .wouldHave,
    ).toMatchObject({ command: "api" });
    expect(
      answerGh(["api", "-X", "GET", "repos/acme/widget/issues/7"], SNAPSHOT, io()).wouldHave,
    ).toBeUndefined();
  });

  test("labels, edits and merges are writes too", () => {
    for (const argv of [
      ["issue", "edit", "7", "--add-label", "x"],
      ["pr", "merge", "70", "--squash"],
      ["label", "create", "x"],
    ]) {
      const answer = answerGh(argv, SNAPSHOT, io());
      expect(answer.code).toBe(0);
      expect(answer.wouldHave?.argv).toEqual(argv);
    }
  });
});

describe("the shim as a process", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phoebe-gh-shim-"));
    writeFileSync(join(dir, GH_SHIM_SNAPSHOT_FILE), JSON.stringify(SNAPSHOT));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const shim = join(import.meta.dirname, "bench-gh-shim.ts");

  test("serves a read and appends a write to the would-have file", () => {
    const view = execFileSync(
      process.execPath,
      ["--no-warnings", shim, dir, "issue", "view", "7", "--json", "title"],
      {
        encoding: "utf8",
      },
    );
    expect(JSON.parse(view)).toEqual({ title: "Make the widget spin" });

    const create = spawnSync(
      process.execPath,
      ["--no-warnings", shim, dir, "pr", "create", "--title", "t", "--body", "b"],
      { encoding: "utf8" },
    );
    expect(create.status).toBe(0);
    const lines = readFileSync(join(dir, GH_SHIM_WOULD_HAVE_FILE), "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).command)).toEqual(["pr create"]);
  });

  test("exits with gh's code on a read it cannot serve", () => {
    const ran = spawnSync(process.execPath, ["--no-warnings", shim, dir, "issue", "view", "9"], {
      encoding: "utf8",
    });
    expect(ran.status).toBe(1);
  });
});
