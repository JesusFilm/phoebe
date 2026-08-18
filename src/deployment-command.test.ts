// The literal-command lifecycle path (#261): reading the `deployment` block off
// a real config file, and the shell invocation the lifecycle commands share.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { CommandRunner } from "./deployment-compose.ts";
import {
  LIFECYCLE_SHELL,
  readDeploymentCommands,
  resolveDeploymentCommands,
  runLifecycleStep,
} from "./deployment-command.ts";

describe("readDeploymentCommands", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // A fresh temp dir per test gives every config a unique URL, so Node's ESM
  // cache never hands one test the previous test's module.
  const writeConfig = (body: string): void => {
    writeFileSync(join(workDir, "phoebe.config.ts"), body, "utf8");
  };

  test("no config file at all is undefined, not an error", async () => {
    await expect(readDeploymentCommands(workDir)).resolves.toBeUndefined();
  });

  test("a config with no deployment block is undefined", async () => {
    writeConfig("export default { repoSlug: 'o/r' };");
    await expect(readDeploymentCommands(workDir)).resolves.toBeUndefined();
  });

  test("returns the block when present", async () => {
    writeConfig(
      "export default { deployment: { startCommand: 'up.sh', stopCommand: 'down.sh' } };",
    );
    await expect(readDeploymentCommands(workDir)).resolves.toEqual({
      startCommand: "up.sh",
      stopCommand: "down.sh",
    });
  });

  test("a half-declared block throws rather than falling back to compose", async () => {
    writeConfig("export default { deployment: { startCommand: 'up.sh' } };");
    await expect(readDeploymentCommands(workDir)).rejects.toThrow(/stopCommand/);
  });
});

describe("runLifecycleStep", () => {
  const record = (result: {
    code: number;
  }): { runner: CommandRunner; specs: Array<Record<string, unknown>> } => {
    const specs: Array<Record<string, unknown>> = [];
    return {
      specs,
      runner: async (spec) => {
        specs.push({ ...spec });
        return { stdout: "", stderr: "", ...result };
      },
    };
  };

  test("announces the field, then spawns under the shell with stdio inherited", async () => {
    const { runner, specs } = record({ code: 0 });
    const announced: string[] = [];
    await runLifecycleStep({
      field: "startCommand",
      command: "up.sh",
      cwd: "/deploy",
      announce: (line) => announced.push(line),
      runner,
    });
    expect(specs).toEqual([
      { file: LIFECYCLE_SHELL, args: ["-c", "up.sh"], cwd: "/deploy", inheritStdio: true },
    ]);
    expect(announced).toEqual(["[phoebe] Starting via `deployment.startCommand`: up.sh"]);
  });

  test("stop fields announce with the stopping verb", async () => {
    const { runner } = record({ code: 0 });
    const announced: string[] = [];
    await runLifecycleStep({
      field: "stopNowCommand",
      command: "kill.sh",
      cwd: "/deploy",
      announce: (line) => announced.push(line),
      runner,
    });
    expect(announced).toEqual(["[phoebe] Stopping via `deployment.stopNowCommand`: kill.sh"]);
  });

  test("a non-zero exit throws, naming the field and the command", async () => {
    const { runner } = record({ code: 4 });
    await expect(
      runLifecycleStep({
        field: "stopCommand",
        command: "systemctl stop phoebe",
        cwd: "/deploy",
        announce: () => undefined,
        runner,
      }),
    ).rejects.toThrow(/`deployment\.stopCommand` exited 4: systemctl stop phoebe/);
  });

  test("really runs the string through a shell when no runner is injected", async () => {
    await expect(
      runLifecycleStep({
        field: "startCommand",
        command: "exit 7",
        cwd: process.cwd(),
        announce: () => undefined,
      }),
    ).rejects.toThrow(/exited 7/);
  });
});

describe("resolveDeploymentCommands", () => {
  const block = { startCommand: "up.sh", stopCommand: "down.sh" };

  test("refuses in-container before the config is ever read", async () => {
    // cwd is deliberately unreadable — reaching the config at all is the bug.
    await expect(
      resolveDeploymentCommands({ command: "start", cwd: "/nope", inContainer: true }),
    ).rejects.toThrow(/host/);
  });

  test("a provided block short-circuits the config read", async () => {
    await expect(
      resolveDeploymentCommands({
        command: "stop",
        cwd: "/nope",
        inContainer: false,
        provided: block,
      }),
    ).resolves.toEqual(block);
  });
});
