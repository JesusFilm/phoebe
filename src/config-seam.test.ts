// The config seam contract, guarding the shipped defaults: engine-body source
// (everything under src/ except the config layer itself and tests) and the
// in-package default prompts are repo-agnostic. They must not mention the
// reference consumer (youtube-studio) or its dev toolchain (`vp`), and the
// engine body must never repeat the resolved config's literal values — those
// belong to the config layer (config-schema.ts + phoebe.config.ts), so every
// call site reads them through `config.*` and retargeting Phoebe at another
// repo remains an edit to one file.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { CONFIG_DEFAULTS, PROVIDER_NAMES } from "./config-schema.ts";
import { config } from "./resolved-config.ts";

const srcDir = join(import.meta.dirname, ".");
const promptsDir = join(import.meta.dirname, "..", "prompts");

// Files that legitimately define or resolve the shipped defaults. They are
// excluded from the "engine body" that must not repeat config literals.
const CONFIG_LAYER_FILES = new Set(["config-schema.ts", "resolved-config.ts"]);

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function engineBodyFiles(): string[] {
  return walkSourceFiles(srcDir).filter((file) => !CONFIG_LAYER_FILES.has(basename(file)));
}

function defaultPromptFiles(): string[] {
  return readdirSync(promptsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(promptsDir, name));
}

function shippedDefaultFiles(): string[] {
  return [...walkSourceFiles(srcDir), ...defaultPromptFiles()];
}

describe("config seam", () => {
  // Strings that would bake the reference consumer's repo or toolchain into
  // the shipped defaults.
  const repoSpecificPatterns = [
    { name: "youtube", pattern: /youtube/i },
    { name: "JesusFilm", pattern: /jesusfilm/i },
    { name: "vp CLI", pattern: /(^|[^A-Za-z])vp([^A-Za-z]|$)/ },
  ];

  test("shipped defaults (engine source + default prompts) are repo-agnostic", () => {
    for (const file of shippedDefaultFiles()) {
      const source = readFileSync(file, "utf8");
      for (const { name, pattern } of repoSpecificPatterns) {
        expect(
          pattern.test(source),
          `${file} must not contain a ${name} reference (${String(pattern)})`,
        ).toBe(false);
      }
    }
  });

  const repoLiterals = [
    config.repoSlug,
    config.repoUrl,
    config.readyLabel,
    config.branchPrefix,
    ...config.selfUpdatePaths,
  ];

  test("engine body never mentions the config's repo-specific literals", () => {
    for (const file of engineBodyFiles()) {
      const source = readFileSync(file, "utf8");
      for (const literal of repoLiterals) {
        expect(source, `${file} must not contain "${literal}"`).not.toContain(literal);
      }
    }
  });

  test("config provides a key env var and default model for every provider", () => {
    for (const provider of PROVIDER_NAMES) {
      expect(config.providerEnv[provider]).toBeTruthy();
      expect(config.defaultModels[provider]).toBeTruthy();
    }
  });

  test("engine defaults include every field the config layer knows about", () => {
    // Sanity: catch a new PhoebeConfig field being added without a default —
    // `resolveConfig` would then leave it undefined at runtime.
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      expect(config[key as keyof typeof config]).toBeDefined();
    }
  });
});
