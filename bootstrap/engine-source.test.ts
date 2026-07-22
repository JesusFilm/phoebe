// Tests for the bootstrapper's minimal engine-source reader. This is the only
// piece of the mounted config the bootstrapper cares about — everything else is
// the engine's concern — so the reader must extract exactly the `engine` field,
// apply the documented defaults, and return nothing else.

import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_ENGINE_REF,
  DEFAULT_ENGINE_REPO,
  readEngineSource,
  resolveEngineSource,
} from "./engine-source.ts";

describe("resolveEngineSource", () => {
  test("an omitted engine field resolves to github at the default ref/repo", () => {
    expect(resolveEngineSource(undefined)).toEqual({
      source: "github",
      ref: DEFAULT_ENGINE_REF,
      repo: DEFAULT_ENGINE_REPO,
    });
    expect(DEFAULT_ENGINE_REF).toBe("main");
    expect(DEFAULT_ENGINE_REPO).toBe("JesusFilm/phoebe");
  });

  test("github with no ref/repo fills both defaults", () => {
    expect(resolveEngineSource({ source: "github" })).toEqual({
      source: "github",
      ref: "main",
      repo: "JesusFilm/phoebe",
    });
  });

  test("github honours an explicit ref (branch, tag, or SHA)", () => {
    expect(resolveEngineSource({ source: "github", ref: "v1.2.3" })).toEqual({
      source: "github",
      ref: "v1.2.3",
      repo: "JesusFilm/phoebe",
    });
    const sha = "a".repeat(40);
    expect(resolveEngineSource({ source: "github", ref: sha })).toEqual({
      source: "github",
      ref: sha,
      repo: "JesusFilm/phoebe",
    });
  });

  test("github honours an explicit repo override", () => {
    expect(resolveEngineSource({ source: "github", repo: "acme/fork" })).toEqual({
      source: "github",
      ref: "main",
      repo: "acme/fork",
    });
  });

  test("github honours ref and repo together", () => {
    expect(resolveEngineSource({ source: "github", ref: "next", repo: "acme/fork" })).toEqual({
      source: "github",
      ref: "next",
      repo: "acme/fork",
    });
  });

  test("local passes through with no github fields", () => {
    expect(resolveEngineSource({ source: "local" })).toEqual({ source: "local" });
  });
});

describe("readEngineSource", () => {
  test("extracts only the engine field from a fuller config object", () => {
    const config = {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      engine: { source: "github", ref: "next" } as const,
    };
    expect(readEngineSource(config)).toEqual({
      source: "github",
      ref: "next",
      repo: "JesusFilm/phoebe",
    });
  });

  test("a config with no engine field resolves to the github/main default", () => {
    expect(readEngineSource({ repoSlug: "acme/widget" })).toEqual({
      source: "github",
      ref: "main",
      repo: "JesusFilm/phoebe",
    });
  });

  test("returns a local source verbatim when the config selects it", () => {
    expect(readEngineSource({ engine: { source: "local" } })).toEqual({ source: "local" });
  });

  test("rejects an unknown source rather than silently resolving to local", () => {
    expect(() => readEngineSource({ engine: { source: "other" } })).toThrow(/`engine` must be/);
  });

  test("rejects a non-string ref", () => {
    expect(() => readEngineSource({ engine: { source: "github", ref: 123 } })).toThrow(
      /`engine` must be/,
    );
  });

  test("rejects a non-string repo", () => {
    expect(() => readEngineSource({ engine: { source: "github", repo: 7 } })).toThrow(
      /`engine` must be/,
    );
  });

  test("rejects a non-object engine value", () => {
    expect(() => readEngineSource({ engine: "github" })).toThrow(/`engine` must be/);
  });
});
