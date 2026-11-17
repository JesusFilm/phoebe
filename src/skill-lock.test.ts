// The expected hashes below are worked examples, not recomputations: each was
// produced outside this module by piping `path \0 length \0 content` for the
// files that should count through `sha256sum`. The live-repo test checks against
// the hashes the upstream `skills` CLI wrote into `skills-lock.json`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { hashSkillFolder, verifySkills } from "./skill-lock.ts";

const repoRoot = join(import.meta.dirname, "..");

/** `SKILL.md` holding `a\nb`, and nothing else. */
const A_NEWLINE_B = "4058bc44bc7597183c059420bd8bbba3573e19903fc369850148f6931eb5ff96";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory holding `files` (relative path → content). */
function folder(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-lock-"));
  scratch.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("hashSkillFolder", () => {
  test("hashes path, length and content of each file", () => {
    expect(hashSkillFolder(folder({ "SKILL.md": "a\nb" }))).toBe(A_NEWLINE_B);
  });

  test("sorts paths by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF5E is EF BD 9E in UTF-8 and sorts before the emoji (F0 9F 98 80);
    // JavaScript's default sort compares the emoji's D83D surrogate and puts it first.
    const dir = folder({ "\u{FF5E}.md": "x\n", "\u{1F600}.md": "y\n" });

    expect(hashSkillFolder(dir)).toBe(
      "2529290d045d380afa76ae2bd5a9c6564f02e22cc3816362aac8aa516edaeda6",
    );
  });

  test("hashes a backslash in a file name as a slash, as upstream does", () => {
    // On POSIX `docs\b.md` is one file at the top of the folder, but upstream
    // turns every backslash into `/` before sorting and hashing.
    const dir = folder({ "SKILL.md": "a\nb", "docs\\b.md": "x\n" });

    expect(hashSkillFolder(dir)).toBe(
      "74db92866203e95de5c6b37059af6376fbc4c5c89898e2563d08c0a2191e2f26",
    );
  });

  test("folds CRLF to LF and hashes the folded length", () => {
    expect(hashSkillFolder(folder({ "SKILL.md": "a\r\nb" }))).toBe(A_NEWLINE_B);
  });

  test("leaves a bare CR alone", () => {
    expect(hashSkillFolder(folder({ "SKILL.md": "a\rb" }))).toBe(
      "a478c2f1b23db8b5efb3ade8201cb07fbe0286bbb7fa9ae2e15aaca3b4c1688e",
    );
  });

  test("leaves CRLF alone in a file holding a NUL byte", () => {
    expect(hashSkillFolder(folder({ "SKILL.md": "a\r\n\0" }))).toBe(
      "0d48c7d8136ab86484f2f0bcfb9a6b5ff6e81c134fbfa685952cea0d26a80816",
    );
  });

  test("skips metadata.json at any depth, and .git, __pycache__, __pypackages__", () => {
    const dir = folder({
      "SKILL.md": "a\nb",
      "metadata.json": "{}",
      "references/metadata.json": "{}",
      ".git/HEAD": "ref: refs/heads/main\n",
      "__pycache__/x.pyc": "x",
      "scripts/__pypackages__/x.py": "x",
    });

    expect(hashSkillFolder(dir)).toBe(A_NEWLINE_B);
  });

  test("skips a directory named metadata.json, and everything under it", () => {
    // Upstream checks the name before the entry type; this hash is what
    // skills@1.9.0 itself computes for the folder.
    const dir = folder({ "SKILL.md": "a\nb", "metadata.json/x.md": "x\n" });

    expect(hashSkillFolder(dir)).toBe(A_NEWLINE_B);
  });

  test("keeps node_modules", () => {
    const dir = folder({ "SKILL.md": "a\nb", "node_modules/x.md": "y\n" });

    expect(hashSkillFolder(dir)).toBe(
      "8db883abd3b151c8a87ef4ae80526083b47a6ea5a3b3ea0fe6063bbb670d5a9f",
    );
  });

  test("follows a symlink that stays inside the folder", () => {
    const dir = folder({ "SKILL.md": "a\nb" });
    symlinkSync("SKILL.md", join(dir, "alias.md"));

    expect(hashSkillFolder(dir)).toBe(
      "559f33d91d0c0c8e4b4a811f2b3217fc6d576e0dba2178276ded434272993083",
    );
  });

  test("skips symlinks that leave the folder", () => {
    const outside = folder({ "secret.md": "s\n", "dir/inner.md": "i\n" });
    const dir = folder({ "SKILL.md": "a\nb" });
    symlinkSync(join(outside, "secret.md"), join(dir, "secret.md"));
    symlinkSync(join(outside, "dir"), join(dir, "dir"));

    expect(hashSkillFolder(dir)).toBe(A_NEWLINE_B);
  });

  test("skips a symlink back to a directory it is already inside", () => {
    const dir = folder({ "SKILL.md": "a\nb" });
    mkdirSync(join(dir, "sub"));
    symlinkSync("..", join(dir, "sub", "up"));
    symlinkSync(".", join(dir, "self"));

    expect(hashSkillFolder(dir)).toBe(A_NEWLINE_B);
  });
});

describe("verifySkills", () => {
  test("reproduces every computedHash in this repo's lock", () => {
    const results = verifySkills(repoRoot);

    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((r) => r.status !== "matching")).toEqual([]);
  });

  /** A repo with `skills/<name>/SKILL.md` = `a\nb` for each name, and `lock` as its lock. */
  function repo(names: string[], lock: unknown): string {
    const files: Record<string, string> = { "skills-lock.json": JSON.stringify(lock) };
    for (const name of names) files[`.agents/skills/${name}/SKILL.md`] = "a\nb";
    return folder(files);
  }

  const locked = (...names: string[]) => ({
    version: 2,
    skills: Object.fromEntries(
      names.map((name) => [name, { source: "o/r", computedHash: A_NEWLINE_B }]),
    ),
  });

  test("reports a skill whose folder changed by one byte as modified", () => {
    const root = repo(["alpha", "beta"], locked("alpha", "beta"));
    const skill = join(root, ".agents/skills/beta/SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace("b", "c"));

    expect(verifySkills(root)).toEqual([
      { name: "alpha", status: "matching", expected: A_NEWLINE_B },
      {
        name: "beta",
        status: "modified",
        expected: A_NEWLINE_B,
        actual: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  test("reports a locked skill with no folder as missing", () => {
    const root = repo([], locked("gone"));

    expect(verifySkills(root)).toEqual([
      { name: "gone", status: "missing", expected: A_NEWLINE_B },
    ]);
  });

  test("ignores skills on disk that the lock doesn't name", () => {
    const root = repo(["alpha", "local-only"], locked("alpha"));

    expect(verifySkills(root).map((r) => r.name)).toEqual(["alpha"]);
  });

  test("refuses a lock whose version isn't 2", () => {
    const root = repo(["alpha"], { ...locked("alpha"), version: 3 });

    expect(() => verifySkills(root)).toThrow(/version 3.*only version 2/);
  });
});
