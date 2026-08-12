// `phoebe stop` (#186): argument construction and every behaviour branch with
// an injected command runner — no Docker in the test loop.

import { describe, expect, test } from "vite-plus/test";
import {
  COMPOSE_REL_PATH,
  DRAIN_TIMEOUT_SEC,
  MISSING_ENV_MESSAGE,
  type CommandRunner,
  type CommandResult,
} from "./deployment-compose.ts";
import { parseStopArgs, runStop, STOP_NOW_TIMEOUT_SEC } from "./stop.ts";

function deploymentExists(envPresent: boolean): (path: string) => boolean {
  return (path) => {
    if (path.endsWith(COMPOSE_REL_PATH)) return true;
    if (path.endsWith("phoebe.config.ts")) return true;
    if (path.endsWith(".env")) return envPresent;
    return false;
  };
}

function scriptedRunner(
  script: Array<CommandResult | ((args: readonly string[]) => CommandResult)>,
): {
  runner: CommandRunner;
  calls: Array<{ file: string; args: readonly string[]; inheritStdio?: boolean }>;
} {
  const calls: Array<{ file: string; args: readonly string[]; inheritStdio?: boolean }> = [];
  let i = 0;
  const runner: CommandRunner = async (spec) => {
    calls.push({
      file: spec.file,
      args: spec.args,
      ...(spec.inheritStdio !== undefined ? { inheritStdio: spec.inheritStdio } : {}),
    });
    const next = script[i++];
    if (next === undefined) {
      throw new Error(`unexpected command: docker ${spec.args.join(" ")}`);
    }
    return typeof next === "function" ? next(spec.args) : next;
  };
  return { runner, calls };
}

function psJson(row: { State: string; ExitCode?: number }): CommandResult {
  return {
    code: 0,
    stdout: `${JSON.stringify({ Service: "phoebe", ...row })}\n`,
    stderr: "",
  };
}

describe("parseStopArgs", () => {
  test("defaults and --now / --help", () => {
    expect(parseStopArgs([])).toEqual({ help: false, now: false });
    expect(parseStopArgs(["--now"])).toEqual({ help: false, now: true });
    expect(parseStopArgs(["--help"]).help).toBe(true);
  });

  test("unknown flags are rejected", () => {
    expect(() => parseStopArgs(["--force"])).toThrow(/Unknown flag/);
  });
});

describe("runStop", () => {
  const lines = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        stdout: (line: string) => out.push(line),
        stderr: (line: string) => err.push(line),
      },
    };
  };

  test("refuses inside the container", async () => {
    await expect(
      runStop({
        now: false,
        deps: { inContainer: true, dockerAvailable: true, exists: deploymentExists(true) },
      }),
    ).rejects.toThrow(/host/);
  });

  test("fails when docker is not on PATH", async () => {
    await expect(
      runStop({
        now: false,
        deps: {
          inContainer: false,
          dockerAvailable: false,
          exists: deploymentExists(true),
        },
      }),
    ).rejects.toThrow(/docker.*PATH/i);
  });

  test("fails in a tenant directory with a specific message", async () => {
    await expect(
      runStop({
        now: false,
        deps: {
          cwd: "/tenant",
          inContainer: false,
          dockerAvailable: true,
          exists: (p) => p.endsWith("phoebe.config.ts"),
        },
      }),
    ).rejects.toThrow(/tenant directory/);
  });

  test("fails when there is no compose file", async () => {
    await expect(
      runStop({
        now: false,
        deps: {
          cwd: "/empty",
          inContainer: false,
          dockerAvailable: true,
          exists: () => false,
        },
      }),
    ).rejects.toThrow(/container\/compose\.yml/);
  });

  test("no container exits 0 with distinguishable wording", async () => {
    const { runner, calls } = scriptedRunner([{ code: 0, stdout: "", stderr: "" }]);
    const log = lines();
    const outcome = await runStop({
      now: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
      },
    });
    expect(outcome).toEqual({ kind: "no-container" });
    expect(log.out.join("\n")).toMatch(/No container here/);
    expect(log.out.join("\n")).toMatch(/right deployment directory/);
    expect(calls[0]?.args).toContain("ps");
  });

  test("already stopped exits 0 with distinguishable wording", async () => {
    const { runner } = scriptedRunner([psJson({ State: "exited", ExitCode: 0 })]);
    const log = lines();
    const outcome = await runStop({
      now: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
      },
    });
    expect(outcome).toEqual({ kind: "already-stopped" });
    expect(log.out.join("\n")).toMatch(/Already stopped/);
    expect(log.out.join("\n")).not.toMatch(/No container here/);
  });

  test("drains with the fleet timeout, streams compose, reports success", async () => {
    const { runner, calls } = scriptedRunner([
      psJson({ State: "running" }),
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "exited", ExitCode: 0 }),
    ]);
    const log = lines();
    const outcome = await runStop({
      now: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
      },
    });
    expect(outcome).toEqual({ kind: "stopped" });
    expect(log.out.join("\n")).toMatch(/waiting up to 1h/);
    expect(log.out.join("\n")).toMatch(/Stopped\./);
    const stopCall = calls.find((c) => c.args.includes("stop"));
    expect(stopCall?.args).toEqual(
      expect.arrayContaining(["stop", "-t", String(DRAIN_TIMEOUT_SEC)]),
    );
    expect(stopCall?.args).toEqual(expect.arrayContaining(["--env-file", "/deploy/.env"]));
    expect(stopCall?.inheritStdio).toBe(true);
  });

  test("omits --env-file when .env is absent", async () => {
    const { runner, calls } = scriptedRunner([
      psJson({ State: "running" }),
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "exited", ExitCode: 0 }),
    ]);
    await runStop({
      now: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(false),
        runner,
        io: lines().io,
      },
    });
    for (const call of calls) {
      expect(call.args).not.toContain("--env-file");
    }
  });

  test("translates a missing required env var into a Phoebe-worded error", async () => {
    const { runner } = scriptedRunner([
      {
        code: 1,
        stdout: "",
        stderr:
          "error while interpolating services.phoebe.environment.GH_TOKEN: " +
          "required variable GH_TOKEN is missing a value: GH_TOKEN is required",
      },
    ]);
    await expect(
      runStop({
        now: false,
        deps: {
          cwd: "/deploy",
          inContainer: false,
          dockerAvailable: true,
          exists: deploymentExists(false),
          runner,
          io: lines().io,
        },
      }),
    ).rejects.toThrow(MISSING_ENV_MESSAGE);
  });

  test("a container killed after the grace produces a loud warning, not success", async () => {
    const { runner } = scriptedRunner([
      psJson({ State: "running" }),
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "exited", ExitCode: 137 }),
    ]);
    const log = lines();
    const outcome = await runStop({
      now: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
      },
    });
    expect(outcome).toEqual({ kind: "killed-mid-run" });
    expect(log.err.join("\n")).toMatch(/WARNING/);
    expect(log.err.join("\n")).toMatch(/SIGKILL|dirty/i);
    expect(log.out.join("\n")).not.toMatch(/^\[phoebe\] Stopped\.$/m);
  });

  test("--now uses a short grace and states what it abandoned", async () => {
    const { runner, calls } = scriptedRunner([
      psJson({ State: "running" }),
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "exited", ExitCode: 137 }),
    ]);
    const log = lines();
    const outcome = await runStop({
      now: true,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
      },
    });
    expect(outcome).toEqual({ kind: "abandoned-now" });
    expect(log.out.join("\n")).toMatch(/--now/);
    expect(log.out.join("\n")).toMatch(/abandon/i);
    expect(calls.find((c) => c.args.includes("stop"))?.args).toEqual(
      expect.arrayContaining(["stop", "-t", String(STOP_NOW_TIMEOUT_SEC)]),
    );
  });

  test("--now with a clean exit reports stopped-now, not abandoned", async () => {
    const { runner } = scriptedRunner([
      psJson({ State: "running" }),
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "exited", ExitCode: 0 }),
    ]);
    const log = lines();
    const outcome = await runStop({
      now: true,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
      },
    });
    expect(outcome).toEqual({ kind: "stopped-now" });
    expect(log.out.join("\n")).toMatch(/Stopped \(--now\)/);
    expect(log.err).toEqual([]);
  });
});
