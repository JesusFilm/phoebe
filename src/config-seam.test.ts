// The config seam contract, now guarding the shipped defaults: the engine
// source (everything under src/ except tests) and the in-package default
// prompts are repo-agnostic. They must not mention the reference consumer
// (youtube-studio) or its dev toolchain (`vp`), and the engine must not
// mention the config's repo-specific literals — those live only in
// phoebe.config.ts, so retargeting Phoebe at another repo is an edit to
// one file.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { config } from "../phoebe.config.ts";

const srcDir = join(import.meta.dirname, ".");
const promptsDir = join(import.meta.dirname, "..", "prompts");

function engineSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...engineSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function defaultPromptFiles(): string[] {
  return readdirSync(promptsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(promptsDir, name));
}

function shippedDefaultFiles(): string[] {
  return [...engineSourceFiles(srcDir), ...defaultPromptFiles()];
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

  test("engine source never mentions the config's repo-specific literals", () => {
    for (const file of engineSourceFiles(srcDir)) {
      const source = readFileSync(file, "utf8");
      for (const literal of repoLiterals) {
        expect(source, `${file} must not contain "${literal}"`).not.toContain(literal);
      }
    }
  });

  test("config provides a key env var and default model for every provider", () => {
    for (const provider of ["cursor", "claude", "codex"] as const) {
      expect(config.providerEnv[provider]).toBeTruthy();
      expect(config.defaultModels[provider]).toBeTruthy();
    }
  });
});
