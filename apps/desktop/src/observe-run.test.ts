// Starting an observer run on a local install with a stub where Docker would
// be: the argv the exec carries, a start read off the verb's first line, a
// refusal in the bootstrapper's own words, and an engine too old to know the
// verb.

import { describe, expect, test } from "vite-plus/test";
import type { CommandRunner, DeploymentCompose } from "../../../src/deployment-compose.ts";
import { BridgeRefusal } from "./channels.ts";
import { observeExecArgs, runContainerObserve } from "./observe-run.ts";

const DEPLOYMENT: DeploymentCompose = {
  deploymentDir: "/repos/youtube-studio",
  composeFile: "/repos/youtube-studio/container/compose.yml",
  containerDir: "/repos/youtube-studio/container",
  envFile: "/repos/youtube-studio/.env",
};

function compose(result: { code?: number; stdout?: string; stderr?: string }): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: (spec) => {
      calls.push([...spec.args]);
      return Promise.resolve({
        code: result.code ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
    },
  };
}

describe("observeExecArgs", () => {
  test("asks the running service, with each field as one --name=value word", () => {
    expect(observeExecArgs({})).toEqual(["exec", "-T", "phoebe", "phoebe", "observe"]);
    expect(observeExecArgs({ tenant: "JesusFilm/phoebe", lookback: "14d" })).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "observe",
      "--tenant=JesusFilm/phoebe",
      "--lookback=14d",
    ]);
  });
});

describe("runContainerObserve", () => {
  test("a clean exit is a start, read off the verb's first line", async () => {
    const { runner, calls } = compose({
      stdout:
        "[phoebe] observer run started for JesusFilm/phoebe (pipeline observe), over the last 14d.\n" +
        "[phoebe] Its record lands in `phoebe history --kind observer` when it settles.\n",
    });
    const answer = await runContainerObserve({
      deployment: DEPLOYMENT,
      request: { lookback: "14d" },
      runner,
    });

    expect(answer).toEqual({
      outcome: "started",
      detail: "observer run started for JesusFilm/phoebe (pipeline observe), over the last 14d.",
    });
    expect(calls[0]).toContain("--lookback=14d");
  });

  test("a refusal carries the bootstrapper's reason, without the verb's lead-in", async () => {
    const { runner } = compose({
      code: 1,
      stderr:
        "[phoebe] the observer run was refused: an observer run is already in flight for " +
        "JesusFilm/phoebe, started at 2026-11-25T10:00:00.000Z.\n",
    });

    expect(await runContainerObserve({ deployment: DEPLOYMENT, request: {}, runner })).toEqual({
      outcome: "refused",
      detail:
        "an observer run is already in flight for JesusFilm/phoebe, started at 2026-11-25T10:00:00.000Z.",
    });
  });

  test("a bootstrapper that never answered is a refusal that says so", async () => {
    const { runner } = compose({
      code: 1,
      stderr: "[phoebe] the bootstrapper did not answer within 10 s — is `phoebe boot` running?\n",
    });
    const answer = await runContainerObserve({ deployment: DEPLOYMENT, request: {}, runner });

    expect(answer?.outcome).toBe("refused");
    expect(answer?.detail).toBe(
      "the bootstrapper did not answer within 10 s — is `phoebe boot` running?",
    );
  });

  test("an engine that predates the verb is too old (null), not a refusal", async () => {
    const { runner } = compose({
      code: 1,
      stderr: "[phoebe] Unknown command `observe` for `phoebe` (phoebe-agent v0.13.0).\n",
    });

    expect(await runContainerObserve({ deployment: DEPLOYMENT, request: {}, runner })).toBeNull();
  });

  test("an exec that could not run at all rejects with its first line", async () => {
    const runner: CommandRunner = () => Promise.reject(new Error("docker: not found\nmore"));
    let caught: unknown;
    try {
      await runContainerObserve({ deployment: DEPLOYMENT, request: {}, runner });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BridgeRefusal);
    expect((caught as BridgeRefusal).message).toBe("docker: not found");
  });
});
