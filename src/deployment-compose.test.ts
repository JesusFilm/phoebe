// Deployment Compose plumbing (#186): discovery, argv construction, env-file
// gating, and Compose ps parsing — the seam `phoebe stop` / `phoebe start` share.

import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_DRAIN_TIMEOUT_MS } from "../bootstrap/supervise-fleet.ts";
import {
  buildComposeArgv,
  COMPOSE_REL_PATH,
  DRAIN_TIMEOUT_SEC,
  dockerOnPath,
  findPhoebeService,
  formatResolveFailure,
  inContainerLifecycleMessage,
  isContainerRunning,
  isMissingRequiredEnvError,
  MISSING_ENV_MESSAGE,
  parseComposePsJson,
  resolveDeploymentCompose,
  wasKilledAfterGrace,
  type DeploymentCompose,
} from "./deployment-compose.ts";

describe("DRAIN_TIMEOUT_SEC", () => {
  test("matches the fleet supervisor drain timeout", () => {
    expect(DRAIN_TIMEOUT_SEC * 1000).toBe(DEFAULT_DRAIN_TIMEOUT_MS);
  });
});

describe("resolveDeploymentCompose", () => {
  const deploymentDir = "/deploy";
  const compose = `${deploymentDir}/${COMPOSE_REL_PATH}`;
  const config = `${deploymentDir}/phoebe.config.ts`;
  const env = `${deploymentDir}/.env`;

  test("resolves compose + env when both exist", () => {
    const exists = (p: string) => p === compose || p === env || p === config;
    expect(resolveDeploymentCompose(deploymentDir, exists)).toEqual({
      deploymentDir,
      composeFile: compose,
      containerDir: `${deploymentDir}/container`,
      envFile: env,
    } satisfies DeploymentCompose);
  });

  test("envFile is null when .env is absent — never pass a missing path", () => {
    const exists = (p: string) => p === compose || p === config;
    const resolved = resolveDeploymentCompose(deploymentDir, exists);
    expect(resolved).toMatchObject({ envFile: null, composeFile: compose });
  });

  test("no compose + config present → tenant-directory", () => {
    const exists = (p: string) => p === config;
    expect(resolveDeploymentCompose(deploymentDir, exists)).toEqual({
      kind: "tenant-directory",
      deploymentDir,
    });
    expect(formatResolveFailure({ kind: "tenant-directory", deploymentDir })).toMatch(
      /tenant directory/,
    );
    expect(formatResolveFailure({ kind: "tenant-directory", deploymentDir })).toMatch(
      /workspace root/,
    );
  });

  test("no compose + no config → no-compose", () => {
    expect(resolveDeploymentCompose(deploymentDir, () => false)).toEqual({
      kind: "no-compose",
      deploymentDir,
    });
    expect(formatResolveFailure({ kind: "no-compose", deploymentDir })).toMatch(
      /container\/compose\.yml/,
    );
  });

  test("does not walk upward — parent compose is irrelevant", () => {
    const exists = (p: string) => p === "/deploy/../container/compose.yml";
    expect(resolveDeploymentCompose(deploymentDir, exists)).toMatchObject({ kind: "no-compose" });
  });
});

describe("buildComposeArgv", () => {
  test("includes --env-file only when present", () => {
    expect(
      buildComposeArgv({
        composeFile: "/d/container/compose.yml",
        envFile: "/d/.env",
        args: ["stop", "-t", "3600"],
      }),
    ).toEqual([
      "compose",
      "-f",
      "/d/container/compose.yml",
      "--env-file",
      "/d/.env",
      "stop",
      "-t",
      "3600",
    ]);

    expect(
      buildComposeArgv({
        composeFile: "/d/container/compose.yml",
        envFile: null,
        args: ["stop", "-t", "3600"],
      }),
    ).toEqual(["compose", "-f", "/d/container/compose.yml", "stop", "-t", "3600"]);
  });
});

describe("dockerOnPath", () => {
  test("finds an executable docker on PATH", () => {
    const access = (path: string) => {
      if (path === "/usr/bin/docker") return;
      throw new Error("ENOENT");
    };
    expect(dockerOnPath("/usr/bin:/bin", access)).toBe(true);
    expect(dockerOnPath("/bin", access)).toBe(false);
    expect(dockerOnPath("", access)).toBe(false);
  });
});

describe("isMissingRequiredEnvError", () => {
  test("recognises Compose's required-variable failure", () => {
    expect(
      isMissingRequiredEnvError(
        "error while interpolating services.phoebe.environment.GH_TOKEN: " +
          "required variable GH_TOKEN is missing a value: GH_TOKEN is required",
      ),
    ).toBe(true);
    expect(isMissingRequiredEnvError("cannot connect to the Docker daemon")).toBe(false);
    expect(MISSING_ENV_MESSAGE).toMatch(/\.env\.example/);
  });
});

describe("parseComposePsJson / service state", () => {
  test("parses newline-delimited JSON objects", () => {
    const rows = parseComposePsJson(
      [
        JSON.stringify({ Service: "phoebe", State: "running", ExitCode: 0 }),
        JSON.stringify({ Service: "other", State: "exited", ExitCode: 1 }),
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(findPhoebeService(rows)?.Service).toBe("phoebe");
  });

  test("parses a JSON array", () => {
    const rows = parseComposePsJson(
      JSON.stringify([{ Service: "phoebe", State: "exited", ExitCode: 137 }]),
    );
    expect(wasKilledAfterGrace(rows[0]!)).toBe(true);
    expect(isContainerRunning(rows[0]!)).toBe(false);
  });

  test("empty output is no containers; unknown services are ignored", () => {
    expect(parseComposePsJson("")).toEqual([]);
    expect(findPhoebeService([])).toBeUndefined();
    expect(findPhoebeService([{ Service: "other", State: "running" }])).toBeUndefined();
  });

  test("running / restarting count as up; exited does not", () => {
    expect(isContainerRunning({ State: "running" })).toBe(true);
    expect(isContainerRunning({ State: "restarting" })).toBe(true);
    expect(isContainerRunning({ State: "exited" })).toBe(false);
  });
});

describe("in-container message", () => {
  test("points at the host and names the command", () => {
    expect(inContainerLifecycleMessage("stop")).toMatch(/host/);
    expect(inContainerLifecycleMessage("stop")).toMatch(/phoebe stop/);
  });
});
