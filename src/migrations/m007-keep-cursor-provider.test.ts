// m007 — keep-cursor-provider migration unit tests (#869).
//
// Contract:
//   detect: null when the config is absent or already names a provider.
//   detect: non-null when the config names none.
//   apply: writes defaultProvider: "cursor", and nothing else.
//   apply: ConfigRefusal when the config cannot be edited.
//   idempotence: apply → detect returns null.

import { describe, expect, test } from "vite-plus/test";
import { isConfigRefusal } from "../config-handle.ts";
import { resolveConfig, type PhoebeUserConfig } from "../config-schema.ts";
import { MIGRATIONS } from "./index.ts";
import { keepCursorProviderMigration as m } from "./m007-keep-cursor-provider.ts";

const CONFIG_PATH = "phoebe.config.ts";

function withConfig(content: string) {
  return (relPath: string): string | null => (relPath === CONFIG_PATH ? content : null);
}

const NO_PROVIDER = `
const config = {
  repoSlug: "owner/repo",
  repoUrl: "https://github.com/owner/repo",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
};

export default config;
`.trim();

const withProvider = (provider: string) =>
  NO_PROVIDER.replace(
    `testCommand: "npm test",`,
    `testCommand: "npm test",\n  defaultProvider: "${provider}",`,
  );

const SPREAD = `
const base = { defaultProvider: "claude" };
export default {
  ...base,
  repoSlug: "owner/repo",
};
`.trim();

describe("detect", () => {
  test("null when there is no config", () => {
    expect(m.detect(".", () => null)).toBeNull();
  });

  test.each(["claude", "cursor", "codex"])("null when the config names %s", (provider) => {
    expect(m.detect(".", withConfig(withProvider(provider)))).toBeNull();
  });

  test("non-null when the config names no provider", () => {
    expect(m.detect(".", withConfig(NO_PROVIDER))).not.toBeNull();
  });
});

describe("apply", () => {
  test('writes defaultProvider: "cursor", so the deployment keeps the agent it ran', () => {
    const data = m.detect(".", withConfig(NO_PROVIDER));
    const result = m.apply(".", data, withConfig(NO_PROVIDER));
    expect(isConfigRefusal(result)).toBe(false);
    const content = (result as Record<string, string>)[CONFIG_PATH]!;
    expect(content).toContain('defaultProvider: "cursor"');
    expect(content.replace(/\n {2}defaultProvider: "cursor",/, "")).toBe(NO_PROVIDER);
  });

  test("is idempotent: apply then detect is null", () => {
    const data = m.detect(".", withConfig(NO_PROVIDER));
    const migrated = (m.apply(".", data, withConfig(NO_PROVIDER)) as Record<string, string>)[
      CONFIG_PATH
    ]!;
    expect(m.detect(".", withConfig(migrated))).toBeNull();
  });

  test("a config the handle cannot edit is a refusal naming the edit", () => {
    const data = m.detect(".", withConfig(SPREAD));
    expect(data).not.toBeNull();
    const result = m.apply(".", data, withConfig(SPREAD));
    expect(isConfigRefusal(result)).toBe(true);
    expect((result as { instruction: string }).instruction).toContain('defaultProvider: "cursor"');
  });

  test("describe says what changed and why", () => {
    expect(m.describe(m.detect(".", withConfig(NO_PROVIDER)))).toMatch(
      /defaultProvider: "cursor" written.*default is now claude/,
    );
  });
});

test("the default it stands in for is now claude", () => {
  const user: PhoebeUserConfig = {
    repoSlug: "owner/repo",
    repoUrl: "https://github.com/owner/repo",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
  };
  expect(resolveConfig(user).defaultProvider).toBe("claude");
});

test("is registered, last", () => {
  expect(MIGRATIONS.at(-1)).toBe(m);
});
