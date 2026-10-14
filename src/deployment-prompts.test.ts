// Repo-governance guard for the prompt assets every in-repo deployment runs on
// (#164).
//
// `.phoebe/prompts/` used to be a hand-copied duplicate of the repo's `prompts/`.
// It silently lost a whole prompt kind (`research`) the day that kind landed, and
// two of the copies it did keep drifted behind the originals — so the agent
// working this repo ran older prompts than the repo ships, and every research
// unit died at dispatch. This test pins the fix in both directions: each
// deployment's prompt path must resolve to a file that exists, and it must be a
// file in the one shipped `prompts/` tree rather than a private copy.
//
// It reads the configs off disk through the same functions boot uses
// (`loadUserConfig`, `readConfigDir`, `governingConfigFor`, `tenantForDir`,
// `resolveConfig`), so a new deployment, a moved asset dir or a root turned into
// a pointer is covered without touching this file — only the list below.
//
// Since #663 every deployment in this repo runs on one `phoebe.config.ts`, and
// the last test here is what keeps a second one from growing back.
// Sibling of container-image.test.ts, and under `src/` for the same reason: test
// files never ship, and `vp test` already covers them.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { readConfigDir } from "../bootstrap/config-dir.ts";
import { governingConfigFor, TENANT_CONFIG_FILE, tenantForDir } from "../bootstrap/tenants.ts";
import { DEFAULT_PIPELINE_NAME, resolveConfig } from "./config-schema.ts";
import { selectPipeline } from "./pipeline.ts";
import { loadUserConfig } from "./load-config.ts";
import { assertPromptFilesExist as assertPromptFilesExistRaw } from "./prompt.ts";
import { buildRegistry } from "./work-kinds/registry.ts";

/** The engine's boot check, driven the way `runEngine` drives it. */
function assertPromptFilesExist(
  config: ReturnType<typeof resolveConfig>,
  runtimeRoot: string,
): void {
  const registry = buildRegistry(config);
  assertPromptFilesExistRaw({
    repoSlug: config.repoSlug,
    runtimeRoot,
    kinds: config.workOrder.map((kind) => ({
      name: kind,
      promptFile: registry.get(kind)!.definition.promptFile,
    })),
  });
}

const repoRoot = join(import.meta.dirname, "..");
const SHIPPED_PROMPTS = join(repoRoot, "prompts");

/**
 * Every directory in this repo that a real Phoebe deployment runs from, named by
 * the directory rather than by a config in it: which `phoebe.config.ts` such a
 * directory runs on is the thing being resolved.
 */
const DEPLOYMENT_DIRS = [
  // This repo as a workspace tenant. A workspace finds the checkout by the
  // config at its root, which is a pointer (#663).
  ".",
  // The dogfood: the deployment in `.phoebe/`, run in place.
  ".phoebe",
] as const;

/**
 * A deployment as boot sees it: the config it runs on, that config resolved,
 * and the cwd its engine child runs in. The config at the directory's root says
 * where the asset dir is (`configDir`) and may hand over to the config inside
 * it; the tenant builder turns the two into the paths boot spawns with
 * (bootstrap/tenants.ts). Relative `promptFiles` resolve against that cwd.
 */
async function deploymentAt(dirRelPath: string): Promise<{
  configPath: string;
  config: ReturnType<typeof resolveConfig>;
  runtimeRoot: string;
}> {
  const dir = resolve(repoRoot, dirRelPath);
  const rootConfigPath = join(dir, TENANT_CONFIG_FILE);
  const root = (await loadUserConfig(rootConfigPath)) as unknown as Record<string, unknown>;
  const tenant = tenantForDir(
    dir,
    null,
    readConfigDir(root),
    governingConfigFor(rootConfigPath, root),
  );
  const user = await loadUserConfig(tenant.configPath);
  return {
    configPath: tenant.configPath,
    // Pipeline selection as the CLI runs it (#419): a deployment declares its prompt
    // paths per kind under `pipelines.work`, and this is what folds them onto
    // the flat `promptFiles` the boot check reads.
    config: selectPipeline(resolveConfig(user), DEFAULT_PIPELINE_NAME),
    runtimeRoot: dirname(tenant.envPath),
  };
}

describe.each(DEPLOYMENT_DIRS)("the deployment at %s", (dirRelPath) => {
  test("has every prompt path present at its runtime root", async () => {
    const { config, runtimeRoot } = await deploymentAt(dirRelPath);

    // The same call the engine makes at startup — a missing kind is a boot
    // failure there and a test failure here.
    expect(() => assertPromptFilesExist(config, runtimeRoot)).not.toThrow();
  });

  test("points every prompt kind at the shipped prompts/, not a private copy", async () => {
    // Stricter than the engine, deliberately: a consumer may legitimately point
    // one key at their own file, but no deployment *in this repo* should — that
    // is the copy that drifts. Loosen this if we ever want a real override here.
    const { config, runtimeRoot } = await deploymentAt(dirRelPath);

    for (const [kind, promptPath] of Object.entries(config.promptFiles)) {
      expect(dirname(resolve(runtimeRoot, promptPath)), `${dirRelPath} → ${kind}`).toBe(
        SHIPPED_PROMPTS,
      );
    }
  });
});

test("no deployment keeps its own prompts/ tree to drift", async () => {
  for (const dirRelPath of DEPLOYMENT_DIRS) {
    const { runtimeRoot } = await deploymentAt(dirRelPath);
    if (runtimeRoot === repoRoot) continue; // the shipped tree itself
    expect(
      existsSync(join(runtimeRoot, "prompts")),
      `${dirRelPath} grew a private prompts/ copy`,
    ).toBe(false);
  }
});

test("every deployment of this repo runs on the same phoebe.config.ts (#663)", async () => {
  // Two configs here drifted twice: the workspace ran the shipped default model
  // while the dogfood's copy said Opus (#389), and the dogfood's copy never
  // gained the `intake` pipeline. One file cannot disagree with itself, so this
  // fails the day a deployment is given a config of its own again.
  const configs = await Promise.all(
    DEPLOYMENT_DIRS.map(async (dirRelPath) => (await deploymentAt(dirRelPath)).configPath),
  );

  expect(new Set(configs)).toEqual(new Set([join(repoRoot, ".phoebe", TENANT_CONFIG_FILE)]));
});
