// The supervisor's two questions about pipelines (#417): can this engine
// checkout enumerate rows at all, and — if it can — what does this tenant
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
  createRowEnumerator,
  IMPLICIT_WORK_ROW,
  PipelineEnumerationError,
  type EngineCommand,
  type EngineCommandResult,
} from "./pipeline-rows.ts";

const PROBE_OK = `{"version":1,"supported":true}\n`;

function rowsJson(...names: string[]): string {
  return `${JSON.stringify({
    version: 1,
    rows: names.map((name, index) => ({
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
    const rows = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    expect(rows.supported()).toBe(true);
    expect(engine.calls).toEqual([["pipelines", "--probe"]]);
  });

  test("it is asked once per enumerator, however often it is read", () => {
    const engine = engineReturning(rowsJson("work"));
    const rows = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    rows.supported();
    rows.supported();
    rows.rowsFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" });
    expect(engine.calls.filter((call) => call.includes("--probe"))).toHaveLength(1);
  });

  test("an engine without the subcommand gives every tenant one implicit work row", () => {
    const engine = fakeEngine(() => ({
      status: 1,
      stdout: "",
      stderr: "[phoebe] Unknown command `pipelines` for `phoebe` (phoebe-agent v0.10.0).",
    }));
    const rows = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    expect(rows.supported()).toBe(false);
    expect(rows.rowsFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" })).toEqual([
      IMPLICIT_WORK_ROW,
    ]);
    // Never invoked: the row set is known without asking about this tenant.
    expect(engine.calls).toEqual([["pipelines", "--probe"]]);
  });

  test("an engine that exits 0 saying nothing useful does not count as support", () => {
    const engine = fakeEngine(() => ({ status: 0, stdout: "ok\n", stderr: "" }));
    expect(createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run }).supported()).toBe(
      false,
    );
  });
});

describe("enumerating a tenant", () => {
  test("rows come back parsed, with the tenant's config on the command line", () => {
    const engine = engineReturning(rowsJson("work", "intake"));
    const rows = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run }).rowsFor({
      configPath: "/t/phoebe.config.ts",
      cwd: "/t",
      fingerprint: "a",
    });
    expect(rows.map((row) => row.name)).toEqual(["work", "intake"]);
    expect(engine.calls[1]).toEqual(["pipelines", "--config", "/t/phoebe.config.ts"]);
  });

  test("a chatty kind module cannot corrupt the answer", () => {
    const engine = engineReturning(`loading slack kind…\n${rowsJson("work")}`);
    const rows = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run }).rowsFor({
      configPath: "/t/phoebe.config.ts",
      fingerprint: "a",
    });
    expect(rows.map((row) => row.name)).toEqual(["work"]);
  });

  test("it runs only when the tenant's stat fingerprint moved", () => {
    const engine = engineReturning(rowsJson("work"));
    const enumerator = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    const target = { configPath: "/t/phoebe.config.ts", fingerprint: "a" };
    enumerator.rowsFor(target);
    enumerator.rowsFor(target);
    enumerator.rowsFor(target);
    expect(engine.calls.filter((call) => call.includes("--config"))).toHaveLength(1);
    enumerator.rowsFor({ ...target, fingerprint: "b" });
    expect(engine.calls.filter((call) => call.includes("--config"))).toHaveLength(2);
  });

  test("an unknown fingerprint is never cached — unknown is not unchanged", () => {
    const engine = engineReturning(rowsJson("work"));
    const enumerator = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    const target = { configPath: "/t/phoebe.config.ts", fingerprint: null };
    enumerator.rowsFor(target);
    enumerator.rowsFor(target);
    expect(engine.calls.filter((call) => call.includes("--config"))).toHaveLength(2);
  });

  test("each tenant is enumerated on its own", () => {
    const engine = engineReturning(rowsJson("work"));
    const enumerator = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    enumerator.rowsFor({ configPath: "/a/phoebe.config.ts", fingerprint: "a" });
    enumerator.rowsFor({ configPath: "/b/phoebe.config.ts", fingerprint: "a" });
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
    const enumerator = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
    expect(() =>
      enumerator.rowsFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" }),
    ).toThrow(PipelineEnumerationError);
    expect(() =>
      enumerator.rowsFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" }),
    ).toThrow(/claimed by both/);
  });

  test("garbage on stdout is a failure, not a row set", () => {
    for (const stdout of ["", "{}\n", '{"version":1,"rows":[]}\n', '{"rows":[{"name":1}]}\n']) {
      const engine = engineReturning(stdout);
      const enumerator = createRowEnumerator({ entry: "/engine/src/cli.ts", run: engine.run });
      expect(() =>
        enumerator.rowsFor({ configPath: "/t/phoebe.config.ts", fingerprint: "a" }),
      ).toThrow(PipelineEnumerationError);
    }
  });
});

describe("against the real engine entry", () => {
  const ENGINE_ENTRY = join(import.meta.dirname, "..", "src", "cli.ts");

  function tenantConfig(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-rows-"));
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
    expect(createRowEnumerator({ entry: ENGINE_ENTRY }).supported()).toBe(true);
  });

  test("a config declaring work and intake prints two rows with distinct fingerprints", () => {
    const configPath = tenantConfig(
      `  pipelines: { work: { order: ["checks"] }, intake: { pollIntervalMs: 15000 } },\n`,
    );
    const rows = createRowEnumerator({ entry: ENGINE_ENTRY }).rowsFor({
      configPath,
      fingerprint: "a",
    });
    expect(rows.map((row) => row.name)).toEqual(["work", "intake"]);
    expect(rows[0]?.fingerprint).not.toBe(rows[1]?.fingerprint);
  });

  test("a config with no pipelines block prints one work row", () => {
    const rows = createRowEnumerator({ entry: ENGINE_ENTRY }).rowsFor({
      configPath: tenantConfig(""),
      fingerprint: "a",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "work", concurrency: 1, needsClone: true });
  });

  test("a kind claimed by two pipelines exits non-zero with the validation message", () => {
    const configPath = tenantConfig(
      `  pipelines: { work: { order: ["checks"] }, intake: { order: ["checks"] } },\n`,
    );
    expect(() =>
      createRowEnumerator({ entry: ENGINE_ENTRY }).rowsFor({ configPath, fingerprint: "a" }),
    ).toThrow(/claimed by both `pipelines.work` and `pipelines.intake`/);
  });
}, 60_000);
