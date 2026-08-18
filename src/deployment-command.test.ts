// The literal-command lifecycle path (#261): reading the `deployment` block off
// a real config file, and the shell invocation the lifecycle commands share.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  lifecycleFailureError,
  LIFECYCLE_SHELL,
  readDeploymentCommands,
  runLifecycleCommand,
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

describe("runLifecycleCommand", () => {
  test("spawns the command under the shell with stdio inherited", async () => {
    const specs: Array<Record<string, unknown>> = [];
    const result = await runLifecycleCommand({
      command: "echo hi",
      cwd: "/deploy",
      runner: async (spec) => {
        specs.push({ ...spec });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    expect(specs).toEqual([
      { file: LIFECYCLE_SHELL, args: ["-c", "echo hi"], cwd: "/deploy", inheritStdio: true },
    ]);
  });

  test("really runs the string through a shell", async () => {
    const result = await runLifecycleCommand({ command: "exit 7", cwd: process.cwd() });
    expect(result.code).toBe(7);
  });
});

describe("lifecycleFailureError", () => {
  test("names the config field and the command", () => {
    const error = lifecycleFailureError({
      field: "stopNowCommand",
      command: "systemctl kill phoebe",
      result: { code: 4, stdout: "", stderr: "" },
    });
    expect(error.message).toMatch(/deployment\.stopNowCommand/);
    expect(error.message).toMatch(/exited 4/);
    expect(error.message).toMatch(/systemctl kill phoebe/);
  });
});
