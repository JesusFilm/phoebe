// Repo-governance guard for the prompt assets every in-repo deployment runs on
// (#164).
//
// `.phoebe/prompts/` used to be a hand-copied duplicate of the repo's `prompts/`.
// It silently lost a whole prompt kind (`research`) the day that kind landed, and
// two of the copies it did keep drifted behind the originals — so the agent
// working this repo ran older prompts than the repo ships, and every research
// unit died at dispatch. This test pins the fix in both directions: each
// deployment's `promptFiles` must resolve to a file that exists, and it must be a
// file in the one shipped `prompts/` tree rather than a private copy.
//
// It reads the configs off disk through the same functions boot uses
// (`loadUserConfig`, `readConfigDir`, `resolveConfig`), so a new deployment or a
// moved asset dir is covered without touching this file — only the list below.
// Sibling of container-image.test.ts / nested-dogfood.test.ts, and under `src/`
// for the same reason: test files never ship, and `vp test` already covers them.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { readConfigDir } from "../bootstrap/config-dir.ts";
import { resolveConfig } from "./config-schema.ts";
import { loadUserConfig } from "./load-config.ts";
import { assertPromptFilesExist } from "./prompt.ts";

const repoRoot = join(import.meta.dirname, "..");
const SHIPPED_PROMPTS = join(repoRoot, "prompts");

/** Every `phoebe.config.ts` in this repo that a real Phoebe deployment runs. */
const DEPLOYMENT_CONFIGS = [
  // The workspace-tenant entry for this repo (and the test fixture).
  "phoebe.config.ts",
  // The flat dogfood.
  ".phoebe/phoebe.config.ts",
  // Both tenants of the nested dogfood.
  ".phoebe-nested/repos/JesusFilm/phoebe/phoebe.config.ts",
  ".phoebe-nested/repos/JesusFilm/youtube-studio/phoebe.config.ts",
] as const;

/**
 * A deployment as boot sees it: its resolved config, plus the cwd its engine
 * child runs in — the dir holding `phoebe.config.ts`, relocated by the config's
 * own `configDir` (bootstrap/tenants.ts). Relative `promptFiles` resolve there.
 */
async function deploymentAt(configRelPath: string): Promise<{
  config: ReturnType<typeof resolveConfig>;
  runtimeRoot: string;
}> {
  const configPath = join(repoRoot, configRelPath);
  const user = await loadUserConfig(configPath);
  const configDir = readConfigDir(user as unknown as Record<string, unknown>);
  return { config: resolveConfig(user), runtimeRoot: resolve(dirname(configPath), configDir) };
}

describe.each(DEPLOYMENT_CONFIGS)("deployment %s", (configRelPath) => {
  test("has every promptFiles entry present at its runtime root", async () => {
    const { config, runtimeRoot } = await deploymentAt(configRelPath);

    // The same call the engine makes at startup — a missing kind is a boot
    // failure there and a test failure here.
    expect(() => assertPromptFilesExist(config, runtimeRoot)).not.toThrow();
  });

  test("points every prompt kind at the shipped prompts/, not a private copy", async () => {
    // Stricter than the engine, deliberately: a consumer may legitimately point
    // one key at their own file, but no deployment *in this repo* should — that
    // is the copy that drifts. Loosen this if we ever want a real override here.
    const { config, runtimeRoot } = await deploymentAt(configRelPath);

    for (const [kind, promptPath] of Object.entries(config.promptFiles)) {
      expect(dirname(resolve(runtimeRoot, promptPath)), `${configRelPath} → ${kind}`).toBe(
        SHIPPED_PROMPTS,
      );
    }
  });
});

test("no deployment keeps its own prompts/ tree to drift", () => {
  for (const configRelPath of DEPLOYMENT_CONFIGS) {
    const deploymentDir = join(repoRoot, dirname(configRelPath));
    if (deploymentDir === repoRoot) continue; // the shipped tree itself
    expect(
      existsSync(join(deploymentDir, "prompts")),
      `${configRelPath} grew a private prompts/ copy`,
    ).toBe(false);
  }
});
