// Row selection (#415): a `--pipeline <name>` flag plus the tenant's
// `pipelines` block, flattened into the config shape every existing module
// reads. The cases that matter are the ones a consumer can get wrong — a
// partial order, a kind two rows both want, a cadence the environment tries to
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
  pipelineRow,
  resolvePollIntervalMs,
  selectPipelineRow,
} from "./pipeline-row.ts";
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
  test("defaults to the reserved work row", () => {
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

describe("pipelineRow", () => {
  test("the work row exists undeclared", () => {
    const config = resolveConfig(userConfig());
    expect(pipelineRow(config, "work").concurrency).toBe(1);
  });

  test("an unknown name is a boot error naming what is declared", () => {
    const config = resolveConfig(userConfig({ pipelines: { intake: {} } }));
    expect(() => pipelineRow(config, "intak")).toThrow(/Unknown pipeline "intak".*work, intake/s);
  });
});

describe("selectPipelineRow", () => {
  test("order is priority: named kinds first, every other registered kind after", () => {
    const config = resolveConfig(
      userConfig({ pipelines: { work: { order: ["checks"], concurrency: 2 } } }),
    );
    expect(selectPipelineRow(config, "work").workOrder).toEqual([
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
    expect(selectPipelineRow(config, "work").workOrder).toEqual(EVERY_BUILT_IN);
  });

  test("the deprecated workOrder alias resolves as pipelines.work.order", () => {
    const config = resolveConfig(userConfig({ workOrder: ["issues", "checks"] }));
    expect(config.pipelines["work"]?.order).toEqual(["issues", "checks"]);
    expect(selectPipelineRow(config, "work").workOrder).toEqual([
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
    expect(selectPipelineRow(config, "work").workOrder).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
    ]);
  });

  test("a kind another row claims does not follow into work", () => {
    const config = resolveConfig(userConfig({ pipelines: { intake: { order: ["research"] } } }));
    expect(selectPipelineRow(config, "work").workOrder).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
    ]);
    expect(selectPipelineRow(config, "intake").workOrder).toEqual(["research"]);
  });

  test("a row's custom kinds are its own, and follow its named ones", () => {
    const config = resolveConfig(
      userConfig({
        pipelines: {
          intake: { kinds: { custom: { slack: inlineKind("slack") } } },
          work: { order: ["issues"] },
        },
      }),
    );
    expect(selectPipelineRow(config, "intake").workOrder).toEqual(["slack"]);
    expect(selectPipelineRow(config, "work").workOrder).toEqual([
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
    expect(selectPipelineRow(config, "work").workOrder).toEqual([
      "checks",
      "conflicts",
      "reviews",
      "issues",
      "research",
    ]);
  });

  test("an unknown kind in a row's order names the row", () => {
    const config = resolveConfig(userConfig({ pipelines: { intake: { order: ["bogus"] } } }));
    expect(() => selectPipelineRow(config, "intake")).toThrow(
      /Unknown work kind "bogus" in `pipelines.intake.order`/,
    );
  });

  test("kinds.<name>.promptFile re-points a built-in's prompt", () => {
    const config = resolveConfig(
      userConfig({ pipelines: { work: { kinds: { issues: { promptFile: "p/mine.md" } } } } }),
    );
    const row = selectPipelineRow(config, "work");
    expect(row.promptFiles.issue).toBe("p/mine.md");
    expect(row.promptFiles.reviews).toBe(CONFIG_DEFAULTS.promptFiles.reviews);
  });

  test("the promptFiles alias still lands when no kind block re-points it", () => {
    const config = resolveConfig(userConfig({ promptFiles: { issue: "p/alias.md" } }));
    expect(selectPipelineRow(config, "work").promptFiles.issue).toBe("p/alias.md");
  });

  test("the row's kinds block becomes the flat workKinds", () => {
    const config = resolveConfig(
      userConfig({ pipelines: { work: { kinds: { reviews: { effort: "low" } } } } }),
    );
    expect(selectPipelineRow(config, "work").workKinds).toEqual({ reviews: { effort: "low" } });
  });
});

describe("resolvePollIntervalMs", () => {
  const rowOf = (user: PhoebeUserConfig, name: string) => pipelineRow(resolveConfig(user), name);

  test("a declared interval outranks the env var", () => {
    const row = rowOf(userConfig({ pipelines: { intake: { pollIntervalMs: 15_000 } } }), "intake");
    expect(resolvePollIntervalMs(row, { PHOEBE_POLL_INTERVAL_MS: "60000" })).toBe(15_000);
  });

  test("a row declaring nothing takes the env value", () => {
    const row = rowOf(userConfig({ pipelines: { intake: {} } }), "intake");
    expect(resolvePollIntervalMs(row, { PHOEBE_POLL_INTERVAL_MS: "60000" })).toBe(60_000);
  });

  test("neither declared nor set falls to the default", () => {
    expect(resolvePollIntervalMs(rowOf(userConfig(), "work"), {})).toBe(300_000);
  });
});

describe("cross-row validation", () => {
  test("a kind claimed by two rows is fatal, naming both", () => {
    expect(() =>
      validateUserConfig(
        userConfig({
          pipelines: { work: { order: ["checks"] }, intake: { order: ["checks"] } },
        }),
      ),
    ).toThrow(/work kind "checks" is claimed by both `pipelines.work` and `pipelines.intake`/);
  });

  test("a custom kind declared in two rows is the same violation", () => {
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

  test("one row naming a kind twice is not a violation", () => {
    expect(() =>
      validateUserConfig(userConfig({ pipelines: { work: { order: ["checks", "checks"] } } })),
    ).not.toThrow();
  });
});
