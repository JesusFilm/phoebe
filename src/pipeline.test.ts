// Pipeline selection (#415): a `--pipeline <name>` flag plus the tenant's
// `pipelines` block, flattened into the config shape every existing module
// reads. The cases that matter are the ones a consumer can get wrong — a
// partial order, a kind two pipelines both want, a cadence the environment tries to
// override — plus the no-pipelines path, which has to behave exactly as it did
// before this file existed.

import { describe, expect, test } from "vite-plus/test";
import {
  CONFIG_DEFAULTS,
  resolveConfig,
  validateUserConfig,
  type PhoebeUserConfig,
} from "./config-schema.ts";
import {
  parsePipelineName,
  declaredPipeline,
  resolvePollIntervalMs,
  selectPipeline,
} from "./pipeline.ts";
import type { AnyWorkKindDefinition } from "./work-kinds/definition.ts";

function userConfig(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

const EVERY_BUILT_IN = ["conflicts", "checks", "reviews", "issues", "research"];

/** A minimal registrable kind — enough shape to be declared, never run here. */
function inlineKind(name: string): AnyWorkKindDefinition {
  return {
    name,
    oneShotEligible: true,
    promptFile: `prompts/${name}.md`,
    workspace: "worktree",
    report: { noun: name, describe: (unit: { ref: string }) => unit.ref },
    fetch: () => Promise.resolve([]),
    select: () => ({ unit: null, skipped: [], total: 0 }),
    run: () => Promise.resolve(),
  };
}

describe("parsePipelineName", () => {
  test("defaults to the reserved work pipeline", () => {
    expect(parsePipelineName([])).toBe("work");
    expect(parsePipelineName(["--run-once", "--dry-run"])).toBe("work");
  });

  test("reads both spellings", () => {
    expect(parsePipelineName(["--pipeline", "intake"])).toBe("intake");
    expect(parsePipelineName(["--pipeline=intake", "--dry-run"])).toBe("intake");
  });

  test("rejects a flag with no name", () => {
    expect(() => parsePipelineName(["--pipeline"])).toThrow(/requires a pipeline name/);
    expect(() => parsePipelineName(["--pipeline", "--dry-run"])).toThrow(
      /requires a pipeline name/,
    );
    expect(() => parsePipelineName(["--pipeline="])).toThrow(/requires a pipeline name/);
  });
});

describe("declaredPipeline", () => {
  test("the work pipeline exists undeclared", () => {
    const config = resolveConfig(userConfig());
    expect(declaredPipeline(config, "work").concurrency).toBe(1);
  });

  test("an unknown name is a boot error naming what is declared", () => {
    const config = resolveConfig(userConfig({ pipelines: { intake: {} } }));
    expect(() => declaredPipeline(config, "intak")).toThrow(
      /Unknown pipeline "intak".*work, intake/s,
    );
  });
});

describe("selectPipeline", () => {
  test("order is priority: named kinds first, every other registered kind after", () => {
    const config = resolveConfig(
      userConfig({ pipelines: { work: { order: ["checks"], concurrency: 2 } } }),
    );
    expect(selectPipeline(config, "work").workOrder).toEqual([
      "checks",
      "conflicts",
      "reviews",
      "issues",
      "research",
    ]);
    expect(config.pipelines["work"]?.concurrency).toBe(2);
  });

  test("a tenant declaring nothing gets the shipped order", () => {
    const config = resolveConfig(userConfig());
    expect(selectPipeline(config, "work").workOrder).toEqual(EVERY_BUILT_IN);
  });

  test("the deprecated workOrder alias resolves as pipelines.work.order", () => {
    const config = resolveConfig(userConfig({ workOrder: ["issues", "checks"] }));
    expect(config.pipelines["work"]?.order).toEqual(["issues", "checks"]);
    expect(selectPipeline(config, "work").workOrder).toEqual([
      "issues",
      "checks",
      "conflicts",
      "reviews",
      "research",
    ]);
  });

  test("disabled is the off-switch; omission from `order` is not", () => {
    const config = resolveConfig(
      userConfig({ pipelines: { work: { kinds: { research: { disabled: true } } } } }),
    );
    expect(selectPipeline(config, "work").workOrder).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
    ]);
  });

  test("a kind another pipeline claims does not follow into work", () => {
    const config = resolveConfig(userConfig({ pipelines: { intake: { order: ["research"] } } }));
    expect(selectPipeline(config, "work").workOrder).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
    ]);
    expect(selectPipeline(config, "intake").workOrder).toEqual(["research"]);
  });

  test("a pipeline's custom kinds are its own, and follow its named ones", () => {
    const config = resolveConfig(
      userConfig({
        pipelines: {
          intake: { kinds: { custom: { slack: inlineKind("slack") } } },
          work: { order: ["issues"] },
        },
      }),
    );
    expect(selectPipeline(config, "intake").workOrder).toEqual(["slack"]);
    expect(selectPipeline(config, "work").workOrder).toEqual([
      "issues",
      "conflicts",
      "checks",
      "reviews",
      "research",
    ]);
  });

  test("a kind named twice in order is gathered once", () => {
    const config = resolveConfig(
      userConfig({ pipelines: { work: { order: ["checks", "checks"] } } }),
    );
    expect(selectPipeline(config, "work").workOrder).toEqual([
      "checks",
      "conflicts",
      "reviews",
      "issues",
      "research",
    ]);
  });

  test("an unknown kind in a pipeline's order names the pipeline", () => {
    const config = resolveConfig(userConfig({ pipelines: { intake: { order: ["bogus"] } } }));
    expect(() => selectPipeline(config, "intake")).toThrow(
      /Unknown work kind "bogus" in `pipelines.intake.order`/,
    );
  });

  test("kinds.<name>.promptFile re-points a built-in's prompt", () => {
    const config = resolveConfig(
      userConfig({ pipelines: { work: { kinds: { issues: { promptFile: "p/mine.md" } } } } }),
    );
    const pipeline = selectPipeline(config, "work");
    expect(pipeline.promptFiles.issue).toBe("p/mine.md");
    expect(pipeline.promptFiles.reviews).toBe(CONFIG_DEFAULTS.promptFiles.reviews);
  });

  test("the promptFiles alias still lands when no kind block re-points it", () => {
    const config = resolveConfig(userConfig({ promptFiles: { issue: "p/alias.md" } }));
    expect(selectPipeline(config, "work").promptFiles.issue).toBe("p/alias.md");
  });

  test("the pipeline's kinds block becomes the flat workKinds", () => {
    const config = resolveConfig(
      userConfig({ pipelines: { work: { kinds: { reviews: { effort: "low" } } } } }),
    );
    expect(selectPipeline(config, "work").workKinds).toEqual({ reviews: { effort: "low" } });
  });
});

describe("resolvePollIntervalMs", () => {
  const pipelineOf = (user: PhoebeUserConfig, name: string) =>
    declaredPipeline(resolveConfig(user), name);

  test("a declared interval outranks the env var", () => {
    const pipeline = pipelineOf(
      userConfig({ pipelines: { intake: { pollIntervalMs: 15_000 } } }),
      "intake",
    );
    expect(resolvePollIntervalMs(pipeline, { PHOEBE_POLL_INTERVAL_MS: "60000" })).toBe(15_000);
  });

  test("a pipeline declaring nothing takes the env value", () => {
    const pipeline = pipelineOf(userConfig({ pipelines: { intake: {} } }), "intake");
    expect(resolvePollIntervalMs(pipeline, { PHOEBE_POLL_INTERVAL_MS: "60000" })).toBe(60_000);
  });

  test("neither declared nor set falls to the default", () => {
    expect(resolvePollIntervalMs(pipelineOf(userConfig(), "work"), {})).toBe(300_000);
  });
});

describe("cross-pipeline validation", () => {
  test("a kind claimed by two pipelines is fatal, naming both", () => {
    expect(() =>
      validateUserConfig(
        userConfig({
          pipelines: { work: { order: ["checks"] }, intake: { order: ["checks"] } },
        }),
      ),
    ).toThrow(/work kind "checks" is claimed by both `pipelines.work` and `pipelines.intake`/);
  });

  test("a custom kind declared in two pipelines is the same violation", () => {
    expect(() =>
      validateUserConfig(
        userConfig({
          pipelines: {
            intake: { kinds: { custom: { slack: inlineKind("slack") } } },
            triage: { kinds: { custom: { slack: inlineKind("slack") } } },
          },
        }),
      ),
    ).toThrow(/work kind "slack" is claimed by both/);
  });

  test("one pipeline naming a kind twice is not a violation", () => {
    expect(() =>
      validateUserConfig(userConfig({ pipelines: { work: { order: ["checks", "checks"] } } })),
    ).not.toThrow();
  });
});
