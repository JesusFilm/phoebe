// Pipeline enumeration (#417): the answer the bootstrapper gets when it asks a
// materialized engine checkout which pipelines a tenant declares. The cases that
// matter are the fingerprint's two halves — what must move it (a cadence edit,
// a kind gained) and what must never (the hot `disabled` and `priority` knobs
// at any depth) — plus the paths where enumeration is the first thing to fail:
// a kind two pipelines both claim, and a custom kind module that will not load.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PhoebeUserConfig } from "./config-schema.ts";
import {
  enumerateDeclaredEnv,
  enumeratePipelines,
  parsePipelinesArgs,
} from "./pipeline-enumerate.ts";

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

/** Enumerate a user config the way the subcommand does, minus the file I/O. */
async function enumerate(overrides: Partial<PhoebeUserConfig> = {}, configDir = process.cwd()) {
  return await enumeratePipelines(
    resolveConfig(userConfig(overrides), { dataBase: "/tmp/phoebe-test" }),
    configDir,
  );
}

/** A kind module on disk, as a tenant declares it: `nudge: "./nudge.ts"`. */
function kindModule(source: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-enumerate-"));
  const path = join(dir, "nudge.ts");
  writeFileSync(path, source);
  return { dir, path };
}

const SCRATCH_KIND_SOURCE = `export default {
  name: "nudge",
  oneShotEligible: true,
  promptFile: "prompts/custom.md",
  workspace: "scratch",
  report: { noun: "nudge(s)", describe: (unit) => unit.ref },
  fetch: () => Promise.resolve([]),
  select: () => ({ unit: null, skipped: [], total: 0 }),
  run: () => Promise.resolve(),
};
`;

describe("enumeratePipelines", () => {
  test("a config with no pipelines block enumerates one work pipeline", async () => {
    const pipelines = await enumerate();
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]).toMatchObject({
      name: "work",
      disabled: false,
      priority: 0,
      concurrency: 1,
      needsClone: true,
    });
    expect(pipelines[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test("two declared pipelines enumerate with distinct fingerprints", async () => {
    const pipelines = await enumerate({
      pipelines: {
        work: { order: ["conflicts", "checks"] },
        intake: { pollIntervalMs: 15_000 },
      },
    });
    expect(pipelines.map((pipeline) => pipeline.name)).toEqual(["work", "intake"]);
    expect(pipelines[0]?.fingerprint).not.toBe(pipelines[1]?.fingerprint);
  });

  test("the hot knobs never move a fingerprint, at the pipeline or its kinds", async () => {
    const pipelines = {
      work: { order: ["conflicts"] },
      intake: { pollIntervalMs: 15_000, kinds: { checks: { model: "sonnet" } } },
    };
    const before = await enumerate({ pipelines });
    const after = await enumerate({
      pipelines: {
        ...pipelines,
        intake: {
          ...pipelines.intake,
          disabled: true,
          priority: 5,
          kinds: { checks: { model: "sonnet", disabled: true } },
        },
      },
    });
    expect(after.map((pipeline) => pipeline.fingerprint)).toEqual(
      before.map((pipeline) => pipeline.fingerprint),
    );
    // The knobs still arrive — hot means "act without relaunching", not "hide".
    expect(after[1]).toMatchObject({ name: "intake", disabled: true, priority: 5 });
  });

  test("a cold knob moves only its own pipeline's fingerprint", async () => {
    const before = await enumerate({
      pipelines: { work: { order: ["conflicts"] }, intake: { pollIntervalMs: 15_000 } },
    });
    const after = await enumerate({
      pipelines: { work: { order: ["conflicts"] }, intake: { pollIntervalMs: 30_000 } },
    });
    expect(after[0]?.fingerprint).toBe(before[0]?.fingerprint);
    expect(after[1]?.fingerprint).not.toBe(before[1]?.fingerprint);
  });

  test("two pipelines tuned identically still differ, because the name is in the digest", async () => {
    const pipelines = await enumerate({
      pipelines: { work: { concurrency: 2 }, intake: { concurrency: 2 } },
    });
    expect(pipelines[0]?.fingerprint).not.toBe(pipelines[1]?.fingerprint);
  });

  test("an edited inline kind moves the fingerprint of the pipeline that declares it", async () => {
    const inline = (run: () => Promise<void>) => ({
      pipelines: {
        intake: {
          kinds: {
            nudge: {
              name: "nudge",
              oneShotEligible: true,
              promptFile: "prompts/custom.md",
              workspace: "scratch" as const,
              report: { noun: "nudge(s)", describe: (unit: { ref: string }) => unit.ref },
              fetch: () => Promise.resolve([]),
              select: () => ({ unit: null, skipped: [], total: 0 }),
              run,
            },
          },
        },
      },
    });
    const before = await enumerate(inline(() => Promise.resolve()));
    const after = await enumerate(
      inline(async () => {
        await Promise.resolve("an edited body");
      }),
    );
    expect(after[1]?.fingerprint).not.toBe(before[1]?.fingerprint);
  });

  test("a pipeline whose kinds all want the repo needs a clone", async () => {
    const pipelines = await enumerate({ pipelines: { work: {}, intake: { order: [] } } });
    expect(pipelines[0]?.needsClone).toBe(true);
  });

  test("a pipeline owning only a scratch kind needs no clone", async () => {
    const { dir } = kindModule(SCRATCH_KIND_SOURCE);
    const pipelines = await enumerate(
      {
        pipelines: {
          work: { order: ["conflicts", "checks", "reviews", "issues", "research"] },
          intake: { kinds: { nudge: "./nudge.ts" } },
        },
      },
      dir,
    );
    expect(pipelines[1]).toMatchObject({ name: "intake", needsClone: false });
  });

  test("a disabled worktree kind still keeps its pipeline's clone", async () => {
    const { dir } = kindModule(SCRATCH_KIND_SOURCE);
    const pipelines = await enumerate(
      {
        pipelines: {
          work: { order: ["conflicts", "reviews", "issues", "research"] },
          intake: {
            order: ["checks"],
            kinds: { checks: { disabled: true }, nudge: "./nudge.ts" },
          },
        },
      },
      dir,
    );
    expect(pipelines[1]).toMatchObject({ name: "intake", needsClone: true });
  });

  test("a kind module that throws on load surfaces as an enumerate failure", async () => {
    const { dir } = kindModule(`throw new Error("prompts/nudge.md is missing");\n`);
    await expect(
      enumerate({ pipelines: { intake: { kinds: { nudge: "./nudge.ts" } } } }, dir),
    ).rejects.toThrow(/prompts\/nudge.md is missing/);
  });
});

const DECLARING_KIND_SOURCE = `export default {
  name: "nudge",
  oneShotEligible: true,
  promptFile: "prompts/custom.md",
  workspace: "scratch",
  requiredEnv: ["SLACK_BOT_TOKEN"],
  agentEnv: ["SLACK_BOT_TOKEN"],
  report: { noun: "nudge(s)", describe: (unit) => unit.ref },
  fetch: () => Promise.resolve([]),
  select: () => ({ unit: null, skipped: [], total: 0 }),
  run: () => Promise.resolve(),
};
`;

describe("the per-pipeline `env` (#425)", () => {
  test("a pipeline whose kinds declare nothing reports no keys", async () => {
    const pipelines = await enumerate();
    expect(pipelines[0]?.env).toEqual([]);
  });

  test("the declaring pipeline reports the key and its sibling does not", async () => {
    const { dir } = kindModule(DECLARING_KIND_SOURCE);
    const pipelines = await enumerate(
      { pipelines: { intake: { kinds: { nudge: "./nudge.ts" } } } },
      dir,
    );
    expect(pipelines.find((pipeline) => pipeline.name === "intake")?.env).toEqual([
      "SLACK_BOT_TOKEN",
    ]);
    expect(pipelines.find((pipeline) => pipeline.name === "work")?.env).toEqual([]);
  });

  test("a kind switched off contributes no key — `env` is the reach of live work", async () => {
    const { dir } = kindModule(DECLARING_KIND_SOURCE);
    const pipelines = await enumerate(
      {
        pipelines: {
          intake: { kinds: { nudge: { path: "./nudge.ts", disabled: true } } },
        },
      },
      dir,
    );
    expect(pipelines.find((pipeline) => pipeline.name === "intake")?.env).toEqual([]);
  });
});

describe("enumerateDeclaredEnv", () => {
  test("attributes each declared key to the pipeline and kind that named it", async () => {
    const { dir } = kindModule(DECLARING_KIND_SOURCE);
    const declarations = await enumerateDeclaredEnv(
      resolveConfig(userConfig({ pipelines: { intake: { kinds: { nudge: "./nudge.ts" } } } }), {
        dataBase: "/tmp/phoebe-test",
      }),
      dir,
    );
    expect(declarations).toEqual([
      { pipeline: "intake", kind: "nudge", keys: ["SLACK_BOT_TOKEN"] },
    ]);
  });
});

describe("the tenant faults enumeration reports", () => {
  test("a kind claimed by two pipelines is fatal before any pipeline is enumerated", () => {
    expect(() =>
      resolveConfig(
        userConfig({
          pipelines: { work: { order: ["checks"] }, intake: { order: ["checks"] } },
        }),
        { dataBase: "/tmp/phoebe-test" },
      ),
    ).toThrow(/claimed by both `pipelines.work` and `pipelines.intake`/);
  });
});

describe("parsePipelinesArgs", () => {
  test("reads both --config spellings", () => {
    expect(parsePipelinesArgs(["--config", "/t/phoebe.config.ts"]).configPath).toBe(
      "/t/phoebe.config.ts",
    );
    expect(parsePipelinesArgs(["--config=/t/phoebe.config.ts"]).configPath).toBe(
      "/t/phoebe.config.ts",
    );
    expect(parsePipelinesArgs(["-c", "/t/phoebe.config.ts"]).configPath).toBe(
      "/t/phoebe.config.ts",
    );
  });

  test("--probe asks about the engine and wants no config", () => {
    expect(parsePipelinesArgs(["--probe"])).toEqual({
      configPath: undefined,
      probe: true,
      help: false,
    });
  });

  test("an unknown argument is rejected rather than ignored", () => {
    expect(() => parsePipelinesArgs(["--pipeline", "intake"])).toThrow(/Unknown argument/);
    expect(() => parsePipelinesArgs(["--config"])).toThrow(/requires a path argument/);
  });
});
