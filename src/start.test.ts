// `phoebe start` (#187): argument construction and every behaviour branch with
// an injected command runner — no Docker in the test loop.

import { describe, expect, test } from "vite-plus/test";
import {
  COMPOSE_REL_PATH,
  MISSING_ENV_MESSAGE,
  type CommandRunner,
  type CommandResult,
} from "./deployment-compose.ts";
import { parseStartArgs, runStart, START_SETTLE_MS } from "./start.ts";

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

describe("parseStartArgs", () => {
  test("defaults and --build / --help", () => {
    expect(parseStartArgs([])).toEqual({ help: false, build: false });
    expect(parseStartArgs(["--build"])).toEqual({ help: false, build: true });
    expect(parseStartArgs(["--help"]).help).toBe(true);
  });

  test("unknown flags are rejected", () => {
    expect(() => parseStartArgs(["--force"])).toThrow(/Unknown flag/);
  });
});

describe("runStart", () => {
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

  const noWait = { waitMs: async () => undefined };

  test("refuses inside the container", async () => {
    await expect(
      runStart({
        build: false,
        deps: { inContainer: true, dockerAvailable: true, exists: deploymentExists(true) },
      }),
    ).rejects.toThrow(/host/);
  });

  test("fails when docker is not on PATH", async () => {
    await expect(
      runStart({
        build: false,
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
      runStart({
        build: false,
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
      runStart({
        build: false,
        deps: {
          cwd: "/empty",
          inContainer: false,
          dockerAvailable: true,
          exists: () => false,
        },
      }),
    ).rejects.toThrow(/container\/compose\.yml/);
  });

  test("already running exits 0 and says so", async () => {
    const { runner, calls } = scriptedRunner([psJson({ State: "running" })]);
    const log = lines();
    const outcome = await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
        ...noWait,
      },
    });
    expect(outcome).toEqual({ kind: "already-running" });
    expect(log.out.join("\n")).toMatch(/Already running/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("ps");
  });

  test("default up -d does not pass --build", async () => {
    const { runner, calls } = scriptedRunner([
      psJson({ State: "exited", ExitCode: 0 }),
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "running" }),
    ]);
    const log = lines();
    const waits: number[] = [];
    const outcome = await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
        waitMs: async (ms) => {
          waits.push(ms);
        },
      },
    });
    expect(outcome).toEqual({ kind: "started" });
    expect(waits).toEqual([START_SETTLE_MS]);
    const upCall = calls.find((c) => c.args.includes("up"));
    expect(upCall?.args).toEqual(
      expect.arrayContaining(["up", "-d", "--env-file", "/deploy/.env"]),
    );
    expect(upCall?.args).not.toContain("--build");
    expect(upCall?.inheritStdio).toBe(true);
    expect(log.out.join("\n")).toMatch(/Started/);
    expect(log.out.join("\n")).toMatch(/logs -f/);
    expect(log.out.join("\n")).toMatch(/--env-file \.env/);
  });

  test("--build forces a rebuild", async () => {
    const { runner, calls } = scriptedRunner([
      { code: 0, stdout: "", stderr: "" }, // no prior container
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "running" }),
    ]);
    const log = lines();
    const outcome = await runStart({
      build: true,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
        ...noWait,
      },
    });
    expect(outcome).toEqual({ kind: "started" });
    expect(log.out.join("\n")).toMatch(/--build/);
    const upCall = calls.find((c) => c.args.includes("up"));
    expect(upCall?.args).toEqual(expect.arrayContaining(["up", "-d", "--build"]));
  });

  test("omits --env-file when .env is absent", async () => {
    const { runner, calls } = scriptedRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "running" }),
    ]);
    const log = lines();
    await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(false),
        runner,
        io: log.io,
        ...noWait,
      },
    });
    for (const call of calls) {
      expect(call.args).not.toContain("--env-file");
    }
    expect(log.out.join("\n")).toMatch(/logs -f/);
    expect(log.out.join("\n")).not.toMatch(/--env-file/);
  });

  test("translates a missing required env var into a Phoebe-worded error", async () => {
    const { runner } = scriptedRunner([
      { code: 0, stdout: "", stderr: "" },
      {
        code: 1,
        stdout: "",
        stderr:
          "error while interpolating services.phoebe.environment.GH_TOKEN: " +
          "required variable GH_TOKEN is missing a value: GH_TOKEN is required",
      },
    ]);
    await expect(
      runStart({
        build: false,
        deps: {
          cwd: "/deploy",
          inContainer: false,
          dockerAvailable: true,
          exists: deploymentExists(false),
          runner,
          io: lines().io,
          ...noWait,
        },
      }),
    ).rejects.toThrow(MISSING_ENV_MESSAGE);
  });

  test("a container that exits immediately is reported as a failure", async () => {
    const { runner } = scriptedRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "exited", ExitCode: 1 }),
    ]);
    const log = lines();
    const outcome = await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
        ...noWait,
      },
    });
    expect(outcome).toEqual({ kind: "exited-immediately", exitCode: 1 });
    expect(log.err.join("\n")).toMatch(/exited immediately/);
    expect(log.err.join("\n")).toMatch(/exit code 1/);
    expect(log.out.join("\n")).not.toMatch(/Started\./);
  });

  test("missing service after up is also an immediate-exit failure", async () => {
    const { runner } = scriptedRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ]);
    const log = lines();
    const outcome = await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists: deploymentExists(true),
        runner,
        io: log.io,
        ...noWait,
      },
    });
    expect(outcome.kind).toBe("exited-immediately");
    expect(log.err.join("\n")).toMatch(/exited immediately/);
  });
});
