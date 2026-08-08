// `src/config/authoring.ts` contract (#72): one escape-handling scrape and one
// renderer over the three shipped scaffold templates, replacing
// `extractConfigValues`, `readFlatRepoFields`, and `renderTenantConfig`.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { readAuthoredFields, renderAuthoredConfig } from "./authoring.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "phoebe-authoring-test-"));
}

describe("readAuthoredFields", () => {
  test("pulls every scaffolded field out of a config file", () => {
    const dir = makeTempDir();
    const path = join(dir, "phoebe.config.ts");
    writeFileSync(
      path,
      `const config = {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: "pnpm i",
        checkCommand: "pnpm check",
        testCommand: "pnpm test",
        defaultProvider: "claude",
      };`,
    );
    expect(readAuthoredFields(path)).toEqual({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "pnpm i",
      checkCommand: "pnpm check",
      testCommand: "pnpm test",
      defaultProvider: "claude",
    });
  });

  test("omits fields that are absent", () => {
    const dir = makeTempDir();
    const path = join(dir, "phoebe.config.ts");
    writeFileSync(path, `{ repoSlug: "a/b" }`);
    expect(readAuthoredFields(path)).toEqual({ repoSlug: "a/b" });
  });

  test("stops at the field's own closing quote even past an escaped one", () => {
    const dir = makeTempDir();
    const path = join(dir, "phoebe.config.ts");
    // The naive `extractConfigValues` char-class reader this replaces would
    // stop at the *escaped* quote instead, truncating the value.
    writeFileSync(
      path,
      String.raw`{ installCommand: "pnpm i --filter \"web\"", checkCommand: "next" }`,
    );
    expect(readAuthoredFields(path)).toEqual({
      installCommand: String.raw`pnpm i --filter \"web\"`,
      checkCommand: "next",
    });
  });

  test("returns empty when the file is missing", () => {
    expect(readAuthoredFields(join(makeTempDir(), "phoebe.config.ts"))).toEqual({});
  });
});

describe("renderAuthoredConfig", () => {
  test("flat: renders every scaffolded field plus CLI_BIN, no leftover tokens", () => {
    const rendered = renderAuthoredConfig(
      "flat",
      {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: "pnpm i",
        checkCommand: "pnpm check",
        testCommand: "pnpm test",
        defaultProvider: "claude",
      },
      { packageRoot: REPO_ROOT },
    );
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain(`repoSlug: "acme/widget"`);
    expect(rendered).toContain(`defaultProvider: "claude"`);
    expect(rendered).toContain(`from "phoebe-agent"`);
  });

  test("tenant: carries the repo fields and NO engine field (engine is shared)", () => {
    const rendered = renderAuthoredConfig(
      "tenant",
      {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: "pnpm i",
        checkCommand: "pnpm check",
        testCommand: "pnpm test",
      },
      { packageRoot: REPO_ROOT },
    );
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain('repoSlug: "acme/widget"');
    expect(rendered).toContain('installCommand: "pnpm i"');
    expect(rendered).not.toMatch(/\bengine\s*:/);
    expect(rendered).not.toContain("defaultProvider");
  });

  test("workspace: renders CLI_BIN only, no per-repo fields", () => {
    const rendered = renderAuthoredConfig("workspace", {}, { packageRoot: REPO_ROOT });
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain(`from "phoebe-agent"`);
    expect(rendered).not.toContain("repoSlug:");
  });

  test("escapes a double quote so it cannot break out of the string literal (#71)", () => {
    const rendered = renderAuthoredConfig(
      "flat",
      {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: 'pnpm i --filter "web"',
        checkCommand: "pnpm check",
        testCommand: "pnpm test",
        defaultProvider: "claude",
      },
      { packageRoot: REPO_ROOT },
    );
    expect(rendered).toContain(String.raw`installCommand: "pnpm i --filter \"web\""`);
  });

  test("throws a clear error when a profile field is left unsupplied", () => {
    expect(() => renderAuthoredConfig("flat", {}, { packageRoot: REPO_ROOT })).toThrow(
      /unrenderable placeholder/,
    );
  });
});

describe("round-trip: renderAuthoredConfig → readAuthoredFields", () => {
  for (const [profile, fields] of [
    [
      "flat",
      {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: "pnpm i",
        checkCommand: "pnpm check",
        testCommand: "pnpm test",
        defaultProvider: "claude",
      },
    ],
    [
      "tenant",
      {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: "pnpm i",
        checkCommand: "pnpm check",
        testCommand: "pnpm test",
      },
    ],
    ["workspace", {}],
  ] as const) {
    test(`${profile} profile returns the input fields`, () => {
      const rendered = renderAuthoredConfig(profile, fields, { packageRoot: REPO_ROOT });
      const dir = makeTempDir();
      const path = join(dir, "phoebe.config.ts");
      writeFileSync(path, rendered);
      expect(readAuthoredFields(path)).toEqual(fields);
    });
  }
});
