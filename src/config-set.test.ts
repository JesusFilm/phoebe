// `phoebe config set` — argument shape, value reading, and the `--validate`
// half the bootstrapper spawns (#536).
//
// Contracts:
//   * The path and the value are positional; every flag is named.
//   * A value is JSON when it parses as JSON, and the string typed otherwise.
//   * `--validate` answers against the real loader, for a tenant and for a root,
//     and writes nothing either way.
//   * A written receipt prints what landed; a refusal prints the manual edit.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import {
  formatReceipt,
  localEditId,
  parseConfigSetArgs,
  parseSetValue,
  runConfigSet,
  validateConfigPatch,
} from "./config-set.ts";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-config-set-"));
  temps.push(dir);
  const path = join(dir, "phoebe.config.ts");
  writeFileSync(path, body);
  return path;
}

const TENANT = `export const config = {
  repoSlug: "acme/test",
  repoUrl: "https://github.com/acme/test.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
};
`;

const ROOT = `export const config = {
  workspace: { tenants: ["./a"] },
};
`;

describe("parseConfigSetArgs", () => {
  test("reads the path and the value positionally", () => {
    const parsed = parseConfigSetArgs(["defaultProvider", "claude"]);
    expect(parsed.path).toBe("defaultProvider");
    expect(parsed.value).toBe("claude");
    expect(parsed.validate).toBe(false);
  });

  test("reads the console's flags", () => {
    const parsed = parseConfigSetArgs([
      "checkCommand",
      "pnpm check",
      "--id",
      "e7",
      "--fingerprint",
      "sha256:abc",
      "--by",
      "ops@example.com",
      "--json",
      "--config",
      "/etc/phoebe/phoebe.config.ts",
    ]);
    expect(parsed).toMatchObject({
      path: "checkCommand",
      value: "pnpm check",
      id: "e7",
      fingerprint: "sha256:abc",
      by: "ops@example.com",
      json: true,
      configPath: "/etc/phoebe/phoebe.config.ts",
    });
  });

  test("a negative number is a value, not a flag", () => {
    expect(parseConfigSetArgs(["priority", "-1"]).value).toBe("-1");
  });

  test("rejects an unknown flag rather than dropping it", () => {
    expect(() => parseConfigSetArgs(["a", "1", "--dry-runn"])).toThrow(/Unknown flag/);
  });

  test("rejects a flag with no value", () => {
    expect(() => parseConfigSetArgs(["a", "1", "--id"])).toThrow(/needs a value/);
  });

  test("rejects an unquoted value that split into words", () => {
    expect(() => parseConfigSetArgs(["checkCommand", "pnpm", "run", "check"])).toThrow(/Quote a/);
  });
});

describe("parseSetValue", () => {
  test.each([
    ["42", 42],
    ["true", true],
    ["null", null],
    [`"two words"`, "two words"],
    ["claude", "claude"],
    ["v1.2.3", "v1.2.3"],
    ["{}", "{}"],
  ])("%s", (raw, expected) => {
    expect(parseSetValue(raw)).toEqual(expected);
  });
});

describe("localEditId", () => {
  test("is the same for the same edit against the same file", () => {
    const edit = { path: "a", value: 1, fingerprint: "sha256:x" } as const;
    expect(localEditId(edit)).toBe(localEditId(edit));
    expect(localEditId({ ...edit, value: 2 })).not.toBe(localEditId(edit));
    expect(localEditId({ ...edit, fingerprint: "sha256:y" })).not.toBe(localEditId(edit));
  });
});

describe("validateConfigPatch", () => {
  test("accepts a value the loader accepts, and writes nothing", async () => {
    const configPath = tempConfig(TENANT);
    const before = readFileSync(configPath, "utf8");
    expect(
      await validateConfigPatch({ configPath, path: "checkCommand", value: "pnpm run check" }),
    ).toEqual({ ok: true });
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("refuses a value the loader rejects, and says what it said", async () => {
    const configPath = tempConfig(TENANT);
    const verdict = await validateConfigPatch({ configPath, path: "checkCommand", value: "" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("checkCommand");
  });

  test("a workspace root is not resolved as a tenant", async () => {
    const configPath = tempConfig(ROOT);
    expect(
      await validateConfigPatch({ configPath, path: "reporting.maintainers", value: true }),
    ).toEqual({ ok: true });
  });

  test("a root whose block the patch breaks is refused", async () => {
    const configPath = tempConfig(ROOT);
    const verdict = await validateConfigPatch({
      configPath,
      path: "reporting.maintainers",
      value: "yes please",
    });
    expect(verdict.ok).toBe(false);
  });

  test("a config that will not load at all is a refusal, not a throw", async () => {
    const verdict = await validateConfigPatch({
      configPath: "/nope/phoebe.config.ts",
      path: "a",
      value: 1,
    });
    expect(verdict.ok).toBe(false);
  });

  test("a per-kind setting is applied at the depth the tree shows it", async () => {
    const configPath = tempConfig(TENANT);
    expect(
      await validateConfigPatch({
        configPath,
        path: "pipelines.work.kinds.issues.model",
        value: "opus",
      }),
    ).toEqual({ ok: true });
  });
});

describe("formatReceipt", () => {
  test("a write says what landed and what happens next", () => {
    const text = formatReceipt({
      id: "e1",
      state: "written",
      file: "/etc/phoebe/phoebe.config.ts",
      path: "checkCommand",
      value: "pnpm run check",
      fingerprint: "sha256:abc",
      at: "2026-09-18T10:00:00.000Z",
    });
    expect(text).toContain(`checkCommand = "pnpm run check"`);
    expect(text).toContain("sha256:abc");
    expect(text).toContain("reconciles");
  });

  test("a refusal says why, then exactly what to type", () => {
    const text = formatReceipt({
      id: "e1",
      state: "refused",
      file: "/etc/phoebe/phoebe.config.ts",
      path: "engine.ref",
      reason: "not-editable",
      why: "the engine pin moves with `phoebe upgrade`",
      instruction: 'In /etc/phoebe/phoebe.config.ts, write `{ engine: ref: "v2" }` by hand.',
      at: "2026-09-18T10:00:00.000Z",
    });
    expect(text).toContain("refused (not-editable)");
    expect(text).toContain("phoebe upgrade");
    expect(text).toContain("by hand");
  });
});

describe("runConfigSet — the verb, with no argv and no stdout", () => {
  test("writes the field and answers with the receipt the CLI would have printed", async () => {
    const configPath = tempConfig(TENANT);

    const receipt = await runConfigSet({
      configPath,
      path: "checkCommand",
      value: "pnpm run check",
    });

    expect(receipt.state).toBe("written");
    expect(readFileSync(configPath, "utf8")).toContain(`checkCommand: "pnpm run check"`);
  });

  test("a fingerprint that is not the file's is refused stale, and the file is untouched", async () => {
    const configPath = tempConfig(TENANT);

    const receipt = await runConfigSet({
      configPath,
      path: "checkCommand",
      value: "pnpm run check",
      fingerprint: "sha256:something-else",
    });

    expect(receipt).toMatchObject({ state: "refused", reason: "stale" });
    expect(readFileSync(configPath, "utf8")).toBe(TENANT);
  });

  test("`ledgerPath: null` keeps no ledger — the local arm has no redelivery to answer", async () => {
    const configPath = tempConfig(TENANT);
    const dir = dirname(configPath);

    const receipt = await runConfigSet(
      { configPath, path: "checkCommand", value: "pnpm run check" },
      { ledgerPath: null },
    );

    expect(receipt.state).toBe("written");
    expect(readdirSync(dir)).toEqual(["phoebe.config.ts"]);
  });

  test("a ledger path that was given is written, so a redelivery gets the same receipt", async () => {
    const configPath = tempConfig(TENANT);
    const ledgerPath = join(dirname(configPath), "config-edits.json");

    const first = await runConfigSet(
      { configPath, id: "e1", path: "checkCommand", value: "pnpm run check" },
      { ledgerPath },
    );
    // The same id again, against the file as the first edit left it.
    const second = await runConfigSet(
      {
        configPath,
        id: "e1",
        path: "checkCommand",
        value: "pnpm run check",
        fingerprint: (first as { fingerprint: string }).fingerprint,
      },
      { ledgerPath },
    );

    expect(second).toEqual(first);
  });
});
