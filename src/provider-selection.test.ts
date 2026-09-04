// The per-work-kind resolution ladder (#300). Each knob (provider, model,
// effort) resolves independently, most specific wins:
//
//   1. per-kind env      (PHOEBE_REVIEWS_MODEL)
//   2. per-kind config   (workKinds.reviews.model)
//   3. global env        (PHOEBE_MODEL)
//   4. repo defaults     (defaultProvider / defaultModels / defaultEfforts)
//
// Per-kind *config* deliberately outranks global *env*, and a kind block's
// model/effort go silent when the run's effective provider differs from the
// provider the block speaks for.

import { describe, expect, test } from "vite-plus/test";
import type { PhoebeUserConfig } from "./config-schema.ts";
import { resolveConfig } from "./config-schema.ts";
import { selectProviderForKind, workKindEnvVar } from "./provider-selection.ts";

const BASE_USER: PhoebeUserConfig = {
  repoSlug: "octo/repo",
  repoUrl: "https://github.com/octo/repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
};

function selectionConfig(overrides: Partial<PhoebeUserConfig> = {}) {
  return resolveConfig({ ...BASE_USER, ...overrides });
}

describe("the env var naming scheme", () => {
  test("uppercases the kind between the prefix and the knob", () => {
    expect(workKindEnvVar("reviews", "MODEL")).toBe("PHOEBE_REVIEWS_MODEL");
    expect(workKindEnvVar("conflicts", "AGENT")).toBe("PHOEBE_CONFLICTS_AGENT");
    expect(workKindEnvVar("issues", "EFFORT")).toBe("PHOEBE_ISSUES_EFFORT");
  });
});

describe("with no overrides anywhere", () => {
  test("every kind runs on the repo defaults", () => {
    const config = selectionConfig();
    const picked = selectProviderForKind({ kind: "issues", env: {}, config });
    expect(picked).toEqual({
      provider: config.defaultProvider,
      model: config.defaultModels[config.defaultProvider],
      effort: undefined,
    });
  });

  test("a configured default effort is picked up", () => {
    const config = selectionConfig({ defaultEfforts: { cursor: "high" } });
    const picked = selectProviderForKind({ kind: "checks", env: {}, config });
    expect(picked.effort).toBe("high");
  });
});

describe("the global env vars (unchanged behavior)", () => {
  test("PHOEBE_AGENT flips the provider and its model default follows", () => {
    const config = selectionConfig();
    const picked = selectProviderForKind({
      kind: "issues",
      env: { PHOEBE_AGENT: "claude" },
      config,
    });
    expect(picked.provider).toBe("claude");
    expect(picked.model).toBe(config.defaultModels.claude);
  });

  test("PHOEBE_MODEL and PHOEBE_EFFORT override the defaults", () => {
    const config = selectionConfig();
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_MODEL: "some-model", PHOEBE_EFFORT: "low" },
      config,
    });
    expect(picked.model).toBe("some-model");
    expect(picked.effort).toBe("low");
  });

  test("an unknown PHOEBE_AGENT throws, naming the variable", () => {
    const config = selectionConfig();
    expect(() =>
      selectProviderForKind({ kind: "issues", env: { PHOEBE_AGENT: "gemini" }, config }),
    ).toThrow(/PHOEBE_AGENT "gemini"/);
  });

  test("empty strings read as unset (compose's :-  passthrough)", () => {
    const config = selectionConfig();
    const picked = selectProviderForKind({
      kind: "issues",
      env: { PHOEBE_AGENT: "", PHOEBE_MODEL: "", PHOEBE_EFFORT: "" },
      config,
    });
    expect(picked.provider).toBe(config.defaultProvider);
    expect(picked.model).toBe(config.defaultModels[config.defaultProvider]);
    expect(picked.effort).toBeUndefined();
  });
});

describe("per-kind config blocks", () => {
  const config = selectionConfig({
    defaultProvider: "claude",
    workKinds: {
      reviews: { model: "claude-haiku-4-5", effort: "low" },
      issues: { effort: "high" },
    },
  });

  test("the named kind gets the block's knobs", () => {
    const picked = selectProviderForKind({ kind: "reviews", env: {}, config });
    expect(picked).toEqual({ provider: "claude", model: "claude-haiku-4-5", effort: "low" });
  });

  test("a block sets only what it names; the rest falls through", () => {
    const picked = selectProviderForKind({ kind: "issues", env: {}, config });
    expect(picked.model).toBe(config.defaultModels.claude);
    expect(picked.effort).toBe("high");
  });

  test("kinds without a block are untouched", () => {
    const picked = selectProviderForKind({ kind: "checks", env: {}, config });
    expect(picked).toEqual({
      provider: "claude",
      model: config.defaultModels.claude,
      effort: undefined,
    });
  });

  test("a block's provider knob flips the provider for that kind only", () => {
    const flipped = selectionConfig({
      workKinds: { research: { provider: "codex" } },
    });
    expect(selectProviderForKind({ kind: "research", env: {}, config: flipped }).provider).toBe(
      "codex",
    );
    expect(selectProviderForKind({ kind: "issues", env: {}, config: flipped }).provider).toBe(
      flipped.defaultProvider,
    );
  });
});

describe("per-kind env vars", () => {
  const config = selectionConfig({
    defaultProvider: "claude",
    workKinds: { reviews: { model: "claude-haiku-4-5", effort: "low" } },
  });

  test("outrank the kind's own config block", () => {
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_REVIEWS_MODEL: "claude-opus-5", PHOEBE_REVIEWS_EFFORT: "max" },
      config,
    });
    expect(picked.model).toBe("claude-opus-5");
    expect(picked.effort).toBe("max");
  });

  test("scope to their own kind", () => {
    const picked = selectProviderForKind({
      kind: "issues",
      env: { PHOEBE_REVIEWS_MODEL: "claude-opus-5" },
      config,
    });
    expect(picked.model).toBe(config.defaultModels.claude);
  });

  test("PHOEBE_<KIND>_AGENT outranks everything, and an unknown value throws with its name", () => {
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_REVIEWS_AGENT: "codex", PHOEBE_AGENT: "cursor" },
      config,
    });
    expect(picked.provider).toBe("codex");
    expect(() =>
      selectProviderForKind({ kind: "reviews", env: { PHOEBE_REVIEWS_AGENT: "gemini" }, config }),
    ).toThrow(/PHOEBE_REVIEWS_AGENT "gemini"/);
  });

  test("empty per-kind vars read as unset", () => {
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_REVIEWS_MODEL: "", PHOEBE_REVIEWS_EFFORT: "", PHOEBE_REVIEWS_AGENT: "" },
      config,
    });
    expect(picked).toEqual({ provider: "claude", model: "claude-haiku-4-5", effort: "low" });
  });
});

describe("per-kind config vs global env", () => {
  test("a kind's block survives a blanket PHOEBE_MODEL", () => {
    const config = selectionConfig({
      defaultProvider: "claude",
      workKinds: { reviews: { model: "claude-haiku-4-5" } },
    });
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_MODEL: "claude-opus-5" },
      config,
    });
    expect(picked.model).toBe("claude-haiku-4-5");
  });

  test("a kind's provider knob survives a blanket PHOEBE_AGENT", () => {
    const config = selectionConfig({
      workKinds: { reviews: { provider: "claude", model: "claude-haiku-4-5" } },
    });
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_AGENT: "codex" },
      config,
    });
    expect(picked.provider).toBe("claude");
    expect(picked.model).toBe("claude-haiku-4-5");
  });
});

describe("effort: null — explicit clear (#335)", () => {
  test("null clears a defaultEfforts value for that kind", () => {
    const config = selectionConfig({
      defaultProvider: "claude",
      defaultEfforts: { claude: "low" },
      workKinds: { reviews: { model: "claude-haiku-4-5", effort: null } },
    });
    const picked = selectProviderForKind({ kind: "reviews", env: {}, config });
    expect(picked.effort).toBeUndefined();
    // Other kinds still get the default effort
    expect(selectProviderForKind({ kind: "issues", env: {}, config }).effort).toBe("low");
  });

  test("a per-kind env var still wins over a null block", () => {
    const config = selectionConfig({
      defaultProvider: "claude",
      defaultEfforts: { claude: "low" },
      workKinds: { reviews: { effort: null } },
    });
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_REVIEWS_EFFORT: "max" },
      config,
    });
    expect(picked.effort).toBe("max");
  });

  test("null does not fall through to PHOEBE_EFFORT or defaultEfforts", () => {
    const config = selectionConfig({
      defaultProvider: "claude",
      defaultEfforts: { claude: "high" },
      workKinds: { reviews: { effort: null } },
    });
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_EFFORT: "medium" },
      config,
    });
    expect(picked.effort).toBeUndefined();
  });
});

describe("the provider-mismatch guard", () => {
  test("a providerless block goes silent when PHOEBE_AGENT flips the run away from defaultProvider", () => {
    const config = selectionConfig({
      defaultProvider: "claude",
      workKinds: { reviews: { model: "claude-haiku-4-5", effort: "low" } },
    });
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_AGENT: "cursor" },
      config,
    });
    // The providerless block speaks for defaultProvider (claude); the run is
    // cursor, so the block's model/effort stay silent.
    expect(picked.provider).toBe("cursor");
    expect(picked.model).toBe(config.defaultModels.cursor);
    expect(picked.effort).toBeUndefined();
  });

  test("an explicitly-bound block goes silent when the per-kind env flips the provider", () => {
    const config = selectionConfig({
      workKinds: { checks: { provider: "claude", model: "claude-haiku-4-5", effort: "low" } },
    });
    const picked = selectProviderForKind({
      kind: "checks",
      env: { PHOEBE_CHECKS_AGENT: "cursor" },
      config,
    });
    expect(picked.provider).toBe("cursor");
    expect(picked.model).toBe(config.defaultModels.cursor);
    expect(picked.effort).toBeUndefined();
  });

  test("a silent block still lets the global env model through", () => {
    const config = selectionConfig({
      defaultProvider: "claude",
      workKinds: { reviews: { model: "claude-haiku-4-5" } },
    });
    const picked = selectProviderForKind({
      kind: "reviews",
      env: { PHOEBE_AGENT: "cursor", PHOEBE_MODEL: "composer-x" },
      config,
    });
    expect(picked.model).toBe("composer-x");
  });
});

// --- Modular kinds (#303): custom names and definition-level defaults --------

describe("custom kind names", () => {
  test("hyphens map to underscores in the env var names", () => {
    expect(workKindEnvVar("stale-pr-nudger", "MODEL")).toBe("PHOEBE_STALE_PR_NUDGER_MODEL");
    expect(workKindEnvVar("my-kind", "AGENT")).toBe("PHOEBE_MY_KIND_AGENT");
  });

  test("wrapper knobs tune a custom kind like a built-in's block", () => {
    const config = selectionConfig({
      workKinds: {
        "my-kind": { module: "./kinds/my-kind.ts", model: "composer-mini" },
      },
    });
    const picked = selectProviderForKind({ kind: "my-kind", env: {}, config });
    expect(picked.model).toBe("composer-mini");
  });

  test("the per-kind env var outranks the custom kind's block", () => {
    const config = selectionConfig({
      workKinds: {
        "my-kind": { module: "./kinds/my-kind.ts", model: "composer-mini" },
      },
    });
    const picked = selectProviderForKind({
      kind: "my-kind",
      env: { PHOEBE_MY_KIND_MODEL: "composer-max" },
      config,
    });
    expect(picked.model).toBe("composer-max");
  });
});

describe("definition-level defaults (#303)", () => {
  test("sit above the repo defaults when nothing else speaks", () => {
    const config = selectionConfig();
    const picked = selectProviderForKind({
      kind: "my-kind",
      env: {},
      config,
      definitionDefaults: { model: "composer-lite", effort: "low" },
    });
    expect(picked.model).toBe("composer-lite");
    expect(picked.effort).toBe("low");
  });

  test("lose to the wrapper's knobs and to the global env", () => {
    const config = selectionConfig({
      workKinds: { "my-kind": { module: "./k.ts", model: "from-block" } },
    });
    expect(
      selectProviderForKind({
        kind: "my-kind",
        env: {},
        config,
        definitionDefaults: { model: "from-definition" },
      }).model,
    ).toBe("from-block");
    expect(
      selectProviderForKind({
        kind: "other-kind",
        env: { PHOEBE_MODEL: "from-global-env" },
        config: selectionConfig(),
        definitionDefaults: { model: "from-definition" },
      }).model,
    ).toBe("from-global-env");
  });

  test("go silent when an env flip moved the run off the default provider", () => {
    const config = selectionConfig();
    const picked = selectProviderForKind({
      kind: "my-kind",
      env: { PHOEBE_AGENT: "claude" },
      config,
      definitionDefaults: { model: "cursor-specific-model" },
    });
    expect(picked.provider).toBe("claude");
    expect(picked.model).toBe(config.defaultModels.claude);
  });
});
