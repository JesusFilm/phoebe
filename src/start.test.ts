// `phoebe start` (#187): argument construction and every behaviour branch with
// an injected command runner — no Docker in the test loop.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { LIFECYCLE_SHELL } from "./deployment-command.ts";
import {
  COMPOSE_REL_PATH,
  MISSING_ENV_MESSAGE,
  type CommandRunner,
  type CommandResult,
} from "./deployment-compose.ts";
import { parseStartArgs, runStart, runStartCli, START_SETTLE_MS } from "./start.ts";

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

function lines(): {
  out: string[];
  err: string[];
  io: { stdout: (line: string) => void; stderr: (line: string) => void };
} {
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

// The literal-command path (#189/#261): a `deployment` block replaces the
// compose driver entirely. `exists` and `dockerAvailable` are deliberately set
// to the failing values in these tests — reaching them at all is the bug.
describe("runStart with a deployment block", () => {
  const literalDeps = (
    result: CommandResult,
  ): { runner: CommandRunner; calls: Array<{ file: string; args: readonly string[] }> } => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    return {
      calls,
      runner: async (spec) => {
        calls.push({ file: spec.file, args: spec.args });
        return result;
      },
    };
  };

  test("runs startCommand via /bin/sh -c and skips every compose step", async () => {
    const { runner, calls } = literalDeps({ code: 0, stdout: "", stderr: "" });
    const log = lines();
    const waits: number[] = [];
    const outcome = await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: false,
        exists: () => false,
        deploymentCommands: {
          startCommand: "systemctl start phoebe",
          stopCommand: "systemctl stop phoebe",
        },
        runner,
        io: log.io,
        waitMs: async (ms) => {
          waits.push(ms);
        },
      },
    });
    expect(outcome).toEqual({ kind: "started" });
    expect(calls).toEqual([{ file: LIFECYCLE_SHELL, args: ["-c", "systemctl start phoebe"] }]);
    expect(waits).toEqual([]);
    expect(log.out.join("\n")).toMatch(/systemctl start phoebe/);
  });

  test("inherits stdio and runs in the deployment directory", async () => {
    const specs: Array<{ cwd?: string; inheritStdio?: boolean }> = [];
    const outcome = await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        deploymentCommands: { startCommand: "up.sh", stopCommand: "down.sh" },
        runner: async (spec) => {
          specs.push({ cwd: spec.cwd, inheritStdio: spec.inheritStdio });
          return { code: 0, stdout: "", stderr: "" };
        },
        io: lines().io,
      },
    });
    expect(outcome).toEqual({ kind: "started" });
    expect(specs).toEqual([{ cwd: "/deploy", inheritStdio: true }]);
  });

  test("a non-zero exit is a failure", async () => {
    const { runner } = literalDeps({ code: 3, stdout: "", stderr: "" });
    await expect(
      runStart({
        build: false,
        deps: {
          cwd: "/deploy",
          inContainer: false,
          deploymentCommands: { startCommand: "up.sh", stopCommand: "down.sh" },
          runner,
          io: lines().io,
        },
      }),
    ).rejects.toThrow(/exited 3.*up\.sh|up\.sh.*exited 3/s);
  });

  test("--build warns and is otherwise a no-op", async () => {
    const { runner, calls } = literalDeps({ code: 0, stdout: "", stderr: "" });
    const log = lines();
    const outcome = await runStart({
      build: true,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        deploymentCommands: { startCommand: "up.sh", stopCommand: "down.sh" },
        runner,
        io: log.io,
      },
    });
    expect(outcome).toEqual({ kind: "started" });
    expect(calls).toEqual([{ file: LIFECYCLE_SHELL, args: ["-c", "up.sh"] }]);
    expect(log.err.join("\n")).toMatch(/--build/);
    expect(log.err.join("\n")).toMatch(/deployment/i);
  });

  test("the in-container refusal still fires", async () => {
    await expect(
      runStart({
        build: false,
        deps: {
          inContainer: true,
          deploymentCommands: { startCommand: "up.sh", stopCommand: "down.sh" },
          runner: async () => {
            throw new Error("must not run");
          },
        },
      }),
    ).rejects.toThrow(/host/);
  });
});

describe("runStartCli config threading", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "phoebe-start-cli-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("reads the deployment block off the config on disk and runs it", async () => {
    writeFileSync(
      join(workDir, "phoebe.config.ts"),
      "export default { deployment: { startCommand: 'up.sh', stopCommand: 'down.sh' } };",
      "utf8",
    );
    const calls: Array<readonly string[]> = [];
    const log = lines();
    await runStartCli([], {
      cwd: workDir,
      inContainer: false,
      dockerAvailable: false,
      io: log.io,
      runner: async (spec) => {
        calls.push(spec.args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual([["-c", "up.sh"]]);
    expect(log.out.join("\n")).toMatch(/Started\./);
  });
});

describe("runStart with a `remote` block (map #690)", () => {
  const exists = deploymentExists(false);

  test("no block: no overlay, no env export, and --remove-orphans always", async () => {
    const { runner, calls } = scriptedRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "running" }),
    ]);
    const outcome = await runStart({
      build: false,
      deps: { cwd: "/deploy", dockerAvailable: true, exists, runner, waitMs: async () => {} },
    });
    expect(outcome).toEqual({ kind: "started" });
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(up.args).toEqual([
      "compose",
      "-f",
      "/deploy/container/compose.yml",
      "up",
      "-d",
      "--remove-orphans",
    ]);
    expect(calls.every((c) => !("env" in c))).toBe(true);
  });

  test("sidecar arm: the overlay joins every Compose call, nothing is exported, Serve is not touched", async () => {
    const { runner, calls } = scriptedRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "running" }),
    ]);
    let served = 0;
    const outcome = await runStart({
      build: true,
      deps: {
        cwd: "/deploy",
        dockerAvailable: true,
        exists,
        runner,
        waitMs: async () => {},
        remote: { arm: "sidecar" },
        serve: async () => {
          served += 1;
          return { state: "ready", url: "https://x" };
        },
      },
    });
    expect(outcome).toEqual({ kind: "started" });
    expect(served).toBe(0);
    for (const call of calls) {
      expect(call.args.slice(0, 5)).toEqual([
        "compose",
        "-f",
        "/deploy/container/compose.yml",
        "-f",
        "/deploy/container/compose.tailscale-sidecar.yml",
      ]);
    }
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(up.args.slice(-4)).toEqual(["up", "-d", "--build", "--remove-orphans"]);
  });

  test("host arm: overlay, PHOEBE_REMOTE_PORT from remote.port, Serve reconciled, URL handed over", async () => {
    const { runner, calls } = scriptedRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "running" }),
      { code: 0, stdout: "", stderr: "" }, // phoebe remote-url
    ]);
    const log = lines();
    const asked: Array<{ port: number; httpsPort: number }> = [];
    const outcome = await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        dockerAvailable: true,
        exists,
        runner,
        io: log.io,
        env: { PATH: "/usr/bin" },
        waitMs: async () => {},
        remote: { arm: "host", port: 9000, httpsPort: 8443 },
        serve: async (ports) => {
          asked.push(ports);
          return { state: "ready", url: "https://beast.tail4f2c.ts.net:8443" };
        },
      },
    });
    expect(outcome).toEqual({
      kind: "started",
      serve: { state: "ready", url: "https://beast.tail4f2c.ts.net:8443" },
    });
    expect(asked).toEqual([{ port: 9000, httpsPort: 8443 }]);
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(up.args).toContain("/deploy/container/compose.tailscale-host.yml");
    const handoff = calls[3]!;
    expect(handoff.args.slice(-6)).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "remote-url",
      "https://beast.tail4f2c.ts.net:8443",
    ]);
    expect(log.out.join("\n")).toContain(
      "Reachable on the tailnet at https://beast.tail4f2c.ts.net:8443",
    );
  });

  test("host arm: a refused Serve is reported, the URL is not handed over, and the start still counts", async () => {
    const { runner, calls } = scriptedRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      psJson({ State: "running" }),
    ]);
    const log = lines();
    const outcome = await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        dockerAvailable: true,
        exists,
        runner,
        io: log.io,
        waitMs: async () => {},
        remote: { arm: "host", port: 7463, httpsPort: 443 },
        serve: async () => ({ state: "refused", detail: "a mapping points elsewhere." }),
      },
    });
    expect(outcome).toEqual({
      kind: "started",
      serve: { state: "refused", detail: "a mapping points elsewhere." },
    });
    expect(calls.some((c) => c.args.includes("remote-url"))).toBe(false);
    expect(log.err.join("\n")).toMatch(/Serve not reconciled: a mapping points elsewhere/);
  });

  test("already running on the host arm still reconciles Serve", async () => {
    const { runner } = scriptedRunner([
      psJson({ State: "running" }),
      { code: 0, stdout: "", stderr: "" }, // remote-url
    ]);
    let served = 0;
    const outcome = await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        dockerAvailable: true,
        exists,
        runner,
        remote: { arm: "host", port: 7463, httpsPort: 443 },
        serve: async () => {
          served += 1;
          return { state: "pending", url: "https://x.ts.net" };
        },
      },
    });
    expect(outcome).toEqual({
      kind: "already-running",
      serve: { state: "pending", url: "https://x.ts.net" },
    });
    expect(served).toBe(1);
  });
});

describe("the env the host overlay reads", () => {
  test("PHOEBE_REMOTE_PORT rides on the Compose child's env, over this process's", async () => {
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const runner: CommandRunner = async (spec) => {
      envs.push(spec.env);
      if (spec.args.includes("ps"))
        return envs.length === 1
          ? { code: 0, stdout: "", stderr: "" }
          : psJson({ State: "running" });
      return { code: 0, stdout: "", stderr: "" };
    };
    await runStart({
      build: false,
      deps: {
        cwd: "/deploy",
        dockerAvailable: true,
        exists: deploymentExists(false),
        runner,
        env: { PATH: "/usr/bin", HOME: "/home/me" },
        waitMs: async () => {},
        remote: { arm: "host", port: 9000, httpsPort: 443 },
        serve: async () => ({ state: "refused", detail: "no" }),
      },
    });
    for (const env of envs)
      expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/me", PHOEBE_REMOTE_PORT: "9000" });
  });
});
