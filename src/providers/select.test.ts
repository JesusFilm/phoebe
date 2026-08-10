// Provider/model/effort resolution (#155) — the seam both call chains that
// invoke an agent (issue-shaped producer, PR-fix skeleton) terminate at.
// Exercised directly, independent of `runEngine`'s composition root.

import { describe, expect, test } from "vite-plus/test";
import { sampleConfig as config } from "../test-config.ts";
import { selectProvider } from "./select.ts";

describe("selectProvider — no tier (env override, falling back to tenant default)", () => {
  test("with no env override, resolves the tenant's default provider/model/effort", () => {
    const result = selectProvider({ config, env: {} });
    expect(result.provider.name).toBe(config.defaultProvider);
    expect(result.model).toBe(config.defaultModels[config.defaultProvider]);
    expect(result.effort).toBe(config.defaultEfforts[config.defaultProvider]);
  });

  test("PHOEBE_AGENT overrides the provider", () => {
    const result = selectProvider({ config, env: { PHOEBE_AGENT: "claude" } });
    expect(result.provider.name).toBe("claude");
    expect(result.model).toBe(config.defaultModels.claude);
  });

  test("an unknown PHOEBE_AGENT throws", () => {
    expect(() => selectProvider({ config, env: { PHOEBE_AGENT: "bogus" } })).toThrow(
      /Unknown PHOEBE_AGENT/,
    );
  });

  test("PHOEBE_MODEL overrides the model for the resolved provider", () => {
    const result = selectProvider({
      config,
      env: { PHOEBE_AGENT: "claude", PHOEBE_MODEL: "claude-opus-4-7" },
    });
    expect(result.model).toBe("claude-opus-4-7");
  });

  test("PHOEBE_EFFORT overrides the effort for the resolved provider (#155 — the dead wiring, now live)", () => {
    const result = selectProvider({
      config,
      env: { PHOEBE_AGENT: "claude", PHOEBE_EFFORT: "xhigh" },
    });
    expect(result.effort).toBe("xhigh");
  });

  test("claude defaults to effort 'high' with no override — restores the belief every tenant .env already had", () => {
    const result = selectProvider({ config, env: { PHOEBE_AGENT: "claude" } });
    expect(result.effort).toBe("high");
  });

  test("cursor/codex get no effort — their CLIs have no effort concept", () => {
    expect(selectProvider({ config, env: { PHOEBE_AGENT: "cursor" } }).effort).toBeUndefined();
    expect(selectProvider({ config, env: { PHOEBE_AGENT: "codex" } }).effort).toBeUndefined();
  });
});

describe("selectProvider — tier (#155)", () => {
  test("a tier short-circuits to its bundle, ignoring PHOEBE_AGENT/PHOEBE_MODEL/PHOEBE_EFFORT entirely", () => {
    const result = selectProvider({
      config,
      env: { PHOEBE_AGENT: "cursor", PHOEBE_MODEL: "composer-x", PHOEBE_EFFORT: "low" },
      tier: "strong",
    });
    expect(result.provider.name).toBe("claude");
    expect(result.model).toBe("opus");
    expect(result.effort).toBe("high");
  });

  test("basic resolves to sonnet/low", () => {
    const result = selectProvider({ config, env: {}, tier: "basic" });
    expect(result.model).toBe("sonnet");
    expect(result.effort).toBe("low");
  });

  test("mid resolves to sonnet/high", () => {
    const result = selectProvider({ config, env: {}, tier: "mid" });
    expect(result.model).toBe("sonnet");
    expect(result.effort).toBe("high");
  });

  test("strong is the only tier reaching opus — the fleet's only path to it", () => {
    expect(selectProvider({ config, env: {}, tier: "strong" }).model).toBe("opus");
    expect(selectProvider({ config, env: {}, tier: "basic" }).model).not.toBe("opus");
    expect(selectProvider({ config, env: {}, tier: "mid" }).model).not.toBe("opus");
  });
});
