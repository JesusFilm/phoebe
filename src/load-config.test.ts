// Tests for the consumer-facing config plumbing in ./load-config.ts:
//
//   - `applyEnvOverlay` overlays scalar `PHOEBE_*` keys, validates the enum
//     ones, and leaves the input object untouched.
//   - `resolveConfigPath` returns absolute paths and rejects missing files
//     with a message that distinguishes an explicit --config from the default.
//   - `loadUserConfig` accepts both `export default` and named `export const
//     config` shapes and quotes the underlying error on failure.
//
// `defineConfig` moved to the bootstrapper — see bootstrap/define-config.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  ENV_OVERLAY_KEYS,
  applyEnvOverlay,
  loadUserConfig,
  resolveConfigPath,
} from "./load-config.ts";
import type { PhoebeUserConfig } from "./config-schema.ts";

function baseUser(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

describe("applyEnvOverlay", () => {
  test("returns a new object — does not mutate the input", () => {
    const input = baseUser();
    const result = applyEnvOverlay(input, { PHOEBE_REPO_SLUG: "other/repo" });
    expect(result).not.toBe(input);
    expect(input.repoSlug).toBe("acme/widget");
    expect(result.repoSlug).toBe("other/repo");
  });

  test("unset env vars leave the config field untouched", () => {
    const result = applyEnvOverlay(baseUser(), {});
    expect(result.repoSlug).toBe("acme/widget");
    expect(result.installCommand).toBe("npm ci");
  });

  test("empty-string env vars are ignored (treated the same as unset)", () => {
    const result = applyEnvOverlay(baseUser(), { PHOEBE_REPO_SLUG: "" });
    expect(result.repoSlug).toBe("acme/widget");
  });

  test("every scalar overlay key maps to the documented user-config field", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const { env: k } of ENV_OVERLAY_KEYS) env[k] = `sentinel-${k}`;
    const result = applyEnvOverlay(baseUser(), env);
    for (const { env: k, key } of ENV_OVERLAY_KEYS) {
      expect(result[key]).toBe(`sentinel-${k}`);
    }
  });

  test("PHOEBE_PR_SCOPE overlays and validates the enum", () => {
    expect(applyEnvOverlay(baseUser(), { PHOEBE_PR_SCOPE: "all" }).prScope).toBe("all");
    expect(() => applyEnvOverlay(baseUser(), { PHOEBE_PR_SCOPE: "bogus" })).toThrow(
      /PHOEBE_PR_SCOPE/,
    );
  });

  test("PHOEBE_DRAFT_PRS overlays and validates the enum", () => {
    expect(applyEnvOverlay(baseUser(), { PHOEBE_DRAFT_PRS: "include" }).draftPrs).toBe("include");
    expect(() => applyEnvOverlay(baseUser(), { PHOEBE_DRAFT_PRS: "bogus" })).toThrow(
      /PHOEBE_DRAFT_PRS/,
    );
  });

  test("PHOEBE_DEFAULT_PROVIDER overlays and validates the enum", () => {
    expect(applyEnvOverlay(baseUser(), { PHOEBE_DEFAULT_PROVIDER: "claude" }).defaultProvider).toBe(
      "claude",
    );
    expect(() => applyEnvOverlay(baseUser(), { PHOEBE_DEFAULT_PROVIDER: "bogus" })).toThrow(
      /PHOEBE_DEFAULT_PROVIDER/,
    );
  });
});

describe("resolveConfigPath + loadUserConfig", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "phoebe-cli-"));
    mkdirSync(workDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("resolveConfigPath returns an absolute path when a relative one is passed", () => {
    const rel = "phoebe.config.ts";
    writeFileSync(join(workDir, rel), "export default {};", "utf8");
    expect(resolveConfigPath(rel, workDir)).toBe(join(workDir, rel));
  });

  test("resolveConfigPath uses the default when no --config passed", () => {
    const defaultPath = join(workDir, "phoebe.config.ts");
    writeFileSync(defaultPath, "export default {};", "utf8");
    expect(resolveConfigPath(undefined, workDir)).toBe(defaultPath);
  });

  test("resolveConfigPath differentiates the missing-file error by source", () => {
    const empty = mkdtempSync(join(tmpdir(), "phoebe-cli-empty-"));
    try {
      expect(() => resolveConfigPath(undefined, empty)).toThrow(/pass --config/);
      expect(() => resolveConfigPath("nope.ts", empty)).toThrow(/passed via --config/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("loadUserConfig loads a default-exported config", async () => {
    const path = join(workDir, "default-export.ts");
    writeFileSync(
      path,
      `export default {
        repoSlug: "org/one",
        repoUrl: "https://x/y.git",
        installCommand: "a",
        checkCommand: "b",
        testCommand: "c",
      };
      `,
      "utf8",
    );
    const cfg = await loadUserConfig(path);
    expect(cfg.repoSlug).toBe("org/one");
  });

  test("loadUserConfig loads a named `config` export (pre-defineConfig scaffold)", async () => {
    const path = join(workDir, "named-config.ts");
    writeFileSync(
      path,
      `export const config = {
        repoSlug: "org/two",
        repoUrl: "https://x/y.git",
        installCommand: "a",
        checkCommand: "b",
        testCommand: "c",
      };
      `,
      "utf8",
    );
    const cfg = await loadUserConfig(path);
    expect(cfg.repoSlug).toBe("org/two");
  });

  test("loadUserConfig errors clearly when the file exports no config", async () => {
    const path = join(workDir, "empty-export.ts");
    writeFileSync(path, `export const something = 1;\n`, "utf8");
    await expect(loadUserConfig(path)).rejects.toThrow(/must export/);
  });

  test("loadUserConfig quotes the underlying error on syntax failure", async () => {
    const path = join(workDir, "broken.ts");
    writeFileSync(path, `export default { unterminated`, "utf8");
    await expect(loadUserConfig(path)).rejects.toThrow(/Failed to load/);
  });
});
