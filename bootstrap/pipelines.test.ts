// The supervisor's two questions about pipelines (#417): can this engine
// checkout enumerate pipelines at all, and — if it can — what does this tenant
// declare? The split is the point: a checkout with no `pipelines` subcommand
// must be asked exactly once and then never invoked, so an old engine and a
// broken config can never be mistaken for one another.
//
// The last block runs the real subcommand against this repo's own engine entry,
// which is the only way to know the two sides still agree on the wire format.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  createPipelineEnumerator,
  IMPLICIT_WORK_PIPELINE,
  PipelineEnumerationError,
  diffPipelines,
  pipelineId,
  pipelineLabel,
  siblingOnlyEnvKeys,
  type EngineCommand,
  type EngineCommandResult,
  type PipelineSample,
  type SupervisedPipeline,
} from "./pipelines.ts";

const PROBE_OK = `{"version":1,"supported":true}\n`;

function rowsJson(...names: string[]): string {
  return `${JSON.stringify({
    version: 1,
    pipelines: names.map((name, index) => ({
      name,
      disabled: false,
      priority: 0,
      concurrency: 1,
      needsClone: true,
      fingerprint: `fp-${name}-${index}`,
    })),
  })}\n`;
}

/** A fake engine CLI: records every invocation, answers from a script. */
function fakeEngine(answers: (args: readonly string[]) => EngineCommandResult): {
  run: EngineCommand;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push([...args]);
      return answers(args);
    },
  };
}

/** The common case: an engine that probes true and enumerates whatever it is told. */
function engineReturning(stdout: string) {
  return fakeEngine((args) =>
    args.includes("--probe")
      ? { status: 0, stdout: PROBE_OK, stderr: "" }
      : { status: 0, stdout, stderr: "" },
  );
}

describe("the capability probe", () => {
  test("an engine that answers the probe supports enumeration", () => {
    const engine = engineReturning(rowsJson("work"));
    const pipelines = createPipelineEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    expect(pipelines.supported()).toBe(true);
    expect(engine.calls).toEqual([["pipelines", "--probe"]]);
  });

  test("it is asked once per enumerator, however often it is read", () => {
    const engine = engineReturning(rowsJson("work"));
    const pipelines = createPipelineEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    pipelines.supported();
    pipelines.supported();
    pipelines.pipelinesFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" });
    expect(engine.calls.filter((call) => call.includes("--probe"))).toHaveLength(1);
  });

  test("an engine without the subcommand gives every tenant one implicit work pipeline", () => {
    const engine = fakeEngine(() => ({
      status: 1,
      stdout: "",
      stderr: "[phoebe] Unknown command `pipelines` for `phoebe` (phoebe-agent v0.10.0).",
    }));
    const pipelines = createPipelineEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    expect(pipelines.supported()).toBe(false);
    expect(pipelines.pipelinesFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" })).toEqual(
      [IMPLICIT_WORK_PIPELINE],
    );
    // Never invoked: the pipeline set is known without asking about this tenant.
    expect(engine.calls).toEqual([["pipelines", "--probe"]]);
  });

  test("an engine that exits 0 saying nothing useful does not count as support", () => {
    const engine = fakeEngine(() => ({ status: 0, stdout: "ok\n", stderr: "" }));
    expect(
      createPipelineEnumerator({ entry: "/engine/src/cli.ts", run: engine.run }).supported(),
    ).toBe(false);
  });
});

describe("enumerating a tenant", () => {
  test("pipelines come back parsed, with the tenant's config on the command line", () => {
    const engine = engineReturning(rowsJson("work", "intake"));
    const pipelines = createPipelineEnumerator({
      entry: "/engine/src/cli.ts",
      run: engine.run,
    }).pipelinesFor({
      configPath: "/t/phoebe.config.ts",
      cwd: "/t",
      fingerprint: "a",
    });
    expect(pipelines.map((pipeline) => pipeline.name)).toEqual(["work", "intake"]);
    expect(engine.calls[1]).toEqual(["pipelines", "--config", "/t/phoebe.config.ts"]);
  });

  test("a chatty kind module cannot corrupt the answer", () => {
    const engine = engineReturning(`loading slack kind…\n${rowsJson("work")}`);
    const pipelines = createPipelineEnumerator({
      entry: "/engine/src/cli.ts",
      run: engine.run,
    }).pipelinesFor({
      configPath: "/t/phoebe.config.ts",
      fingerprint: "a",
    });
    expect(pipelines.map((pipeline) => pipeline.name)).toEqual(["work"]);
  });

  test("it runs only when the tenant's stat fingerprint moved", () => {
    const engine = engineReturning(rowsJson("work"));
    const enumerator = createPipelineEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    const target = { configPath: "/t/phoebe.config.ts", fingerprint: "a" };
    enumerator.pipelinesFor(target);
    enumerator.pipelinesFor(target);
    enumerator.pipelinesFor(target);
    expect(engine.calls.filter((call) => call.includes("--config"))).toHaveLength(1);
    enumerator.pipelinesFor({ ...target, fingerprint: "b" });
    expect(engine.calls.filter((call) => call.includes("--config"))).toHaveLength(2);
  });

  test("an unknown fingerprint is never cached — unknown is not unchanged", () => {
    const engine = engineReturning(rowsJson("work"));
    const enumerator = createPipelineEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    const target = { configPath: "/t/phoebe.config.ts", fingerprint: null };
    enumerator.pipelinesFor(target);
    enumerator.pipelinesFor(target);
    expect(engine.calls.filter((call) => call.includes("--config"))).toHaveLength(2);
  });

  test("each tenant is enumerated on its own", () => {
    const engine = engineReturning(rowsJson("work"));
    const enumerator = createPipelineEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    enumerator.pipelinesFor({ configPath: "/a/phoebe.config.ts", fingerprint: "a" });
    enumerator.pipelinesFor({ configPath: "/b/phoebe.config.ts", fingerprint: "a" });
    expect(engine.calls.filter((call) => call.includes("--config"))).toHaveLength(2);
  });

  test("a failing tenant is a tenant-level fault carrying the engine's own words", () => {
    const engine = fakeEngine((args) =>
      args.includes("--probe")
        ? { status: 0, stdout: PROBE_OK, stderr: "" }
        : {
            status: 1,
            stdout: "",
            stderr: '[phoebe] work kind "checks" is claimed by both `pipelines.work` and ...',
          },
    );
    const enumerator = createPipelineEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    expect(() =>
      enumerator.pipelinesFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" }),
    ).toThrow(PipelineEnumerationError);
    expect(() =>
      enumerator.pipelinesFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" }),
    ).toThrow(/claimed by both/);
  });

  test("garbage on stdout is a failure, not a pipeline set", () => {
    for (const stdout of [
      "",
      "{}\n",
      '{"version":1,"pipelines":[]}\n',
      '{"pipelines":[{"name":1}]}\n',
    ]) {
      const engine = engineReturning(stdout);
      const enumerator = createPipelineEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
      expect(() =>
        enumerator.pipelinesFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" }),
      ).toThrow(PipelineEnumerationError);
    }
  });
});

describe("against the real engine entry", () => {
  const ENGINE_ENTRY = join(import.meta.dirname, "..", "src", "cli.ts");

  function tenantConfig(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-pipelines-"));
    const path = join(dir, "phoebe.config.ts");
    writeFileSync(
      path,
      `export default {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
${body}};
`,
    );
    return path;
  }

  test("the subcommand answers the probe this checkout was built against", () => {
    expect(createPipelineEnumerator({ entry: ENGINE_ENTRY }).supported()).toBe(true);
  });

  test("a config declaring work and intake prints two pipelines with distinct fingerprints", () => {
    const configPath = tenantConfig(
      `  pipelines: { work: { order: ["checks"] }, intake: { pollIntervalMs: 15000 } },\n`,
    );
    const pipelines = createPipelineEnumerator({ entry: ENGINE_ENTRY }).pipelinesFor({
      configPath,
      fingerprint: "a",
    });
    expect(pipelines.map((pipeline) => pipeline.name)).toEqual(["work", "intake"]);
    expect(pipelines[0]?.fingerprint).not.toBe(pipelines[1]?.fingerprint);
  });

  test("a config with no pipelines block prints one work pipeline", () => {
    const pipelines = createPipelineEnumerator({ entry: ENGINE_ENTRY }).pipelinesFor({
      configPath: tenantConfig(""),
      fingerprint: "a",
    });
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]).toMatchObject({ name: "work", concurrency: 1, needsClone: true });
  });

  test("a kind claimed by two pipelines exits non-zero with the validation message", () => {
    const configPath = tenantConfig(
      `  pipelines: { work: { order: ["checks"] }, intake: { order: ["checks"] } },\n`,
    );
    expect(() =>
      createPipelineEnumerator({ entry: ENGINE_ENTRY }).pipelinesFor({
        configPath,
        fingerprint: "a",
      }),
    ).toThrow(/claimed by both `pipelines.work` and `pipelines.intake`/);
  });
}, 60_000);

describe("the pipeline matrix vocabulary", () => {
  const tenant = {
    id: "/etc/phoebe/repos/acme/widget",
    slug: "acme/widget",
    dir: "/etc/phoebe/repos/acme/widget",
    configPath: "/etc/phoebe/repos/acme/widget/phoebe.config.ts",
    envPath: "/etc/phoebe/repos/acme/widget/.env",
    gitIdentity: null,
  };

  function pipeline(name: string, fingerprint: string | null): PipelineSample {
    return {
      pipeline: {
        id: pipelineId(tenant.id, name),
        tenant,
        pipeline: {
          name,
          disabled: false,
          priority: 0,
          concurrency: 1,
          needsClone: true,
          env: [],
          fingerprint,
        },
        enumerated: fingerprint !== null,
        siblingEnv: [],
      },
      fingerprint,
    };
  }

  test("a pipeline id joins the tenant and the pipeline", () => {
    expect(pipelineId(tenant.id, "intake")).toBe("/etc/phoebe/repos/acme/widget#intake");
  });

  test("an operator reads a pipeline as slug:pipeline", () => {
    expect(pipelineLabel(pipeline("intake", "i1").pipeline)).toBe("acme/widget:intake");
  });

  test("a tenant with no slug falls back to its dir, so a pipeline is always nameable", () => {
    const solo = { ...pipeline("work", "w1").pipeline, tenant: { ...tenant, slug: null } };
    expect(pipelineLabel(solo)).toBe("/etc/phoebe/repos/acme/widget:work");
  });

  test("diffs added, removed and moved pipelines", () => {
    const previous = new Map([
      [pipelineId(tenant.id, "work"), "w1"],
      [pipelineId(tenant.id, "intake"), "i1"],
    ]);
    const diff = diffPipelines(previous, [pipeline("work", "w1"), pipeline("review", "r1")]);

    expect(diff.added.map((r) => r.pipeline.name)).toEqual(["review"]);
    expect(diff.removed).toEqual([pipelineId(tenant.id, "intake")]);
    expect(diff.changed).toEqual([]);
  });

  test("a moved fingerprint is the only thing that relaunches a pipeline", () => {
    const previous = new Map([[pipelineId(tenant.id, "intake"), "i1"]]);
    expect(diffPipelines(previous, [pipeline("intake", "i2")]).changed.map((r) => r.pipeline.name)) //
      .toEqual(["intake"]);
    expect(diffPipelines(previous, [pipeline("intake", "i1")]).changed).toEqual([]);
  });

  test("a null fingerprint on either side is unknown, never a change", () => {
    // What the implicit pipeline of a checkout that cannot enumerate always carries:
    // it must not churn its child every poll.
    expect(
      diffPipelines(new Map([[pipelineId(tenant.id, "work"), null]]), [pipeline("work", null)])
        .changed,
    ) //
      .toEqual([]);
    expect(
      diffPipelines(new Map([[pipelineId(tenant.id, "work"), "w1"]]), [pipeline("work", null)])
        .changed,
    ) //
      .toEqual([]);
  });

  test("a held pipeline is never reported as removed, however absent", () => {
    const previous = new Map([[pipelineId(tenant.id, "intake"), "i1"]]);
    const hold = new Set([pipelineId(tenant.id, "intake")]);
    expect(diffPipelines(previous, [], hold).removed).toEqual([]);
    expect(diffPipelines(previous, []).removed).toEqual([pipelineId(tenant.id, "intake")]);
  });
});

describe("a pipeline's declared `env` (#425)", () => {
  const withEnv = (env: unknown): string =>
    `${JSON.stringify({
      version: 1,
      pipelines: [
        {
          name: "work",
          disabled: false,
          priority: 0,
          concurrency: 1,
          needsClone: true,
          fingerprint: "fp-work",
        },
        {
          name: "intake",
          disabled: false,
          priority: 0,
          concurrency: 1,
          needsClone: true,
          env,
          fingerprint: "fp-intake",
        },
      ],
    })}\n`;

  const rowsOf = (stdout: string) =>
    createPipelineEnumerator({
      entry: "/engine/src/cli.ts",
      run: engineReturning(stdout).run,
    }).pipelinesFor({
      configPath: "/t/phoebe.config.ts",
      fingerprint: "a",
    });

  test("an engine too old to declare keys leaves every pipeline with none", () => {
    expect(rowsOf(rowsJson("work", "intake")).map((pipeline) => pipeline.env)).toEqual([[], []]);
  });

  test("declared keys come back as names", () => {
    expect(rowsOf(withEnv(["SLACK_BOT_TOKEN"]))[1]?.env).toEqual(["SLACK_BOT_TOKEN"]);
  });

  test("a malformed `env` is a tenant fault, not a silent empty scrub", () => {
    expect(() => rowsOf(withEnv("SLACK_BOT_TOKEN"))).toThrow(PipelineEnumerationError);
  });
});

describe("siblingOnlyEnvKeys", () => {
  const rowWith = (own: string[], siblings: string[]): SupervisedPipeline => ({
    id: `/t#intake`,
    tenant: {
      id: "/t",
      slug: "acme/widget",
      dir: "/t",
      configPath: "/t/phoebe.config.ts",
      envPath: "/t/.env",
      gitIdentity: null,
    },
    pipeline: { ...IMPLICIT_WORK_PIPELINE, name: "intake", env: own },
    enumerated: true,
    siblingEnv: siblings,
  });

  test("is what a sibling declared and this pipeline did not", () => {
    expect(siblingOnlyEnvKeys(rowWith([], ["SLACK_BOT_TOKEN", "LINEAR_KEY"]))).toEqual([
      "LINEAR_KEY",
      "SLACK_BOT_TOKEN",
    ]);
  });

  test("a key this pipeline declares too is not taken away", () => {
    expect(siblingOnlyEnvKeys(rowWith(["SLACK_BOT_TOKEN"], ["SLACK_BOT_TOKEN"]))).toEqual([]);
  });

  test("a tenant with one pipeline scrubs nothing", () => {
    expect(siblingOnlyEnvKeys(rowWith(["SLACK_BOT_TOKEN"], []))).toEqual([]);
  });
});
