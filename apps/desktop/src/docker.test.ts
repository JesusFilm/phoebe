// The Docker check: three answers, three sentences.

import { describe, expect, test } from "vite-plus/test";
import type { CommandRunner } from "../../../src/deployment-compose.ts";
import { probeDocker } from "./docker.ts";

/** A PATH with nothing executable on it — the binary check finds no docker. */
const NO_PATH = "";

/** A machine where `docker` is on PATH, without one having to be installed. */
const ON_PATH = { pathEnv: "/usr/bin", access: () => undefined };

/** Answers each `docker …` probe from a table, keyed by the first argument. */
function docker(answers: Record<string, { code: number; stdout?: string }>): CommandRunner {
  return (spec) => {
    const answer = answers[spec.args[0] ?? ""];
    if (answer === undefined) return Promise.reject(new Error("spawn docker ENOENT"));
    return Promise.resolve({ code: answer.code, stdout: answer.stdout ?? "", stderr: "" });
  };
}

describe("probing docker", () => {
  test("no binary on PATH is the one answer that needs no probe", async () => {
    expect(await probeDocker({ pathEnv: NO_PATH })).toEqual({
      present: false,
      composeVersion: null,
      daemonRunning: false,
    });
  });

  test("reads the Compose version and the daemon separately", async () => {
    // Three facts, because they need three different sentences: install Docker,
    // start Docker, and neither.
    const environment = await probeDocker({
      ...ON_PATH,
      runner: docker({
        compose: { code: 0, stdout: "v2.29.7\n" },
        version: { code: 0, stdout: "27.1.1\n" },
      }),
    });

    expect(environment).toEqual({
      present: true,
      composeVersion: "v2.29.7",
      daemonRunning: true,
    });
  });

  test("an installed Docker whose daemon is down says exactly that", async () => {
    const environment = await probeDocker({
      ...ON_PATH,
      runner: docker({
        compose: { code: 0, stdout: "v2.29.7" },
        version: { code: 1 },
      }),
    });

    expect(environment.present).toBe(true);
    expect(environment.daemonRunning).toBe(false);
  });

  test("a Docker with no Compose plugin keeps the daemon's answer", async () => {
    const environment = await probeDocker({
      ...ON_PATH,
      runner: docker({ compose: { code: 125 }, version: { code: 0, stdout: "27.1.1" } }),
    });

    expect(environment).toEqual({ present: true, composeVersion: null, daemonRunning: true });
  });

  test("a probe that hangs is a no rather than a window that never draws", async () => {
    const environment = await probeDocker({
      ...ON_PATH,
      runner: () => new Promise(() => {}),
      timeoutMs: 5,
    });

    expect(environment).toEqual({ present: true, composeVersion: null, daemonRunning: false });
  });

  test("never throws — a machine without Docker is a fact, not a failure", async () => {
    await expect(
      probeDocker({ ...ON_PATH, runner: () => Promise.reject(new Error("no")) }),
    ).resolves.toEqual({ present: true, composeVersion: null, daemonRunning: false });
  });
});
