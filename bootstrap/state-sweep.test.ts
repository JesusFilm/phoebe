// The supervisor's side of the stale-state sweep (#426): it asks the engine
// checkout to reclaim a tenant's orphaned disk, and reads the answer. Every
// failure — a checkout too old to have the subcommand, a config that will not
// load, an answer that is not JSON — has to arrive as one error the caller can
// shrug off, because the caller's next act is to spawn rows regardless.
//
// The last block runs the real subcommand against this repo's own engine entry,
// which is the only way to know the two sides still agree on the wire format.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { EngineCommandResult } from "./pipeline-rows.ts";
import { createStateSweeper, StateSweepError } from "./state-sweep.ts";

function engineAnswering(result: Partial<EngineCommandResult>): {
  run: (args: readonly string[]) => EngineCommandResult;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push([...args]);
      return { status: 0, stdout: "", stderr: "", ...result };
    },
  };
}

const TARGET = { configPath: "/etc/phoebe/repos/acme/widget/phoebe.config.ts", cwd: "/etc/phoebe" };

describe("createStateSweeper", () => {
  test("asks the engine to sweep this tenant's config, in JSON", () => {
    const engine = engineAnswering({
      stdout: `{"version":1,"removed":[],"kept":[],"failed":[]}\n`,
    });
    createStateSweeper({ entry: "/engine/src/cli.ts", run: engine.run }).sweep(TARGET);
    expect(engine.calls[0]).toEqual(["sweep-state", "--config", TARGET.configPath, "--json"]);
  });

  test("counts what was reclaimed and carries the protected tier out whole", () => {
    const engine = engineAnswering({
      stdout: `noise from a kind module\n${JSON.stringify({
        version: 1,
        removed: [{ tier: "state", path: "/data/state/intake", detail: "no row", reclaim: null }],
        kept: [
          {
            tier: "worktree",
            path: "/data/worktrees/issue-9",
            detail: "not clean",
            reclaim: "remove it by hand",
          },
        ],
        failed: [],
      })}\n`,
    });

    const outcome = createStateSweeper({ entry: "/e", run: engine.run }).sweep(TARGET);

    expect(outcome.removed).toBe(1);
    expect(outcome.failed).toBe(0);
    expect(outcome.kept).toEqual([
      { path: "/data/worktrees/issue-9", detail: "not clean", reclaim: "remove it by hand" },
    ]);
  });

  test("a non-zero exit is one error carrying the engine's own diagnosis", () => {
    const engine = engineAnswering({ status: 1, stderr: "Unknown command `sweep-state`" });
    expect(() => createStateSweeper({ entry: "/e", run: engine.run }).sweep(TARGET)).toThrow(
      StateSweepError,
    );
    expect(() => createStateSweeper({ entry: "/e", run: engine.run }).sweep(TARGET)).toThrow(
      /Unknown command/,
    );
  });

  test("an answer that is not JSON is a failure, not an empty sweep", () => {
    const engine = engineAnswering({ stdout: "swept everything, trust me\n" });
    expect(() => createStateSweeper({ entry: "/e", run: engine.run }).sweep(TARGET)).toThrow(
      StateSweepError,
    );
  });
});

describe("against the real engine entry", () => {
  const ENGINE_ENTRY = join(import.meta.dirname, "..", "src", "cli.ts");
  const previousDataDir = process.env["PHOEBE_DATA_DIR"];

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env["PHOEBE_DATA_DIR"];
    else process.env["PHOEBE_DATA_DIR"] = previousDataDir;
  });

  /** A tenant config plus the data directory its `repoSlug` derives. */
  function tenant(pipelines: string): { configPath: string; stateDir: string } {
    const root = mkdtempSync(join(tmpdir(), "phoebe-sweep-"));
    const configPath = join(root, "phoebe.config.ts");
    writeFileSync(
      configPath,
      `export default {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
${pipelines}};
`,
    );
    const stateDir = join(root, "data", "acme", "widget", "state");
    mkdirSync(stateDir, { recursive: true });
    process.env["PHOEBE_DATA_DIR"] = join(root, "data");
    return { configPath, stateDir };
  }

  test("a row the config no longer declares loses its state directory", () => {
    const { configPath, stateDir } = tenant(`  pipelines: { work: {} },\n`);
    mkdirSync(join(stateDir, "intake"), { recursive: true });
    writeFileSync(join(stateDir, "intake", "status.json"), "{}\n");
    mkdirSync(join(stateDir, "work"), { recursive: true });

    const outcome = createStateSweeper({ entry: ENGINE_ENTRY }).sweep({ configPath });

    expect(outcome.removed).toBe(1);
    expect(existsSync(join(stateDir, "intake"))).toBe(false);
    expect(existsSync(join(stateDir, "work"))).toBe(true);
  });

  test("a config that will not enumerate deletes nothing and says why", () => {
    const { configPath, stateDir } = tenant(
      `  pipelines: { work: { order: ["checks"] }, intake: { order: ["checks"] } },\n`,
    );
    mkdirSync(join(stateDir, "gone"), { recursive: true });

    expect(() => createStateSweeper({ entry: ENGINE_ENTRY }).sweep({ configPath })).toThrow(
      /claimed by both/,
    );
    expect(existsSync(join(stateDir, "gone"))).toBe(true);
  });
}, 60_000);
