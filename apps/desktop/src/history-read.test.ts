// Reading a local install's history with a stub where Docker would be: the
// argv the exec carries, the page it reads back, an engine too old to know the
// verb, and every other failure as a refusal with the container's own words.

import { describe, expect, test } from "vite-plus/test";
import type { HistoryPage } from "phoebe-agent/contracts";
import type { CommandRunner, DeploymentCompose } from "../../../src/deployment-compose.ts";
import { BridgeRefusal } from "./channels.ts";
import { historyExecArgs, readContainerHistory } from "./history-read.ts";

const DEPLOYMENT: DeploymentCompose = {
  deploymentDir: "/repos/youtube-studio",
  composeFile: "/repos/youtube-studio/container/compose.yml",
  containerDir: "/repos/youtube-studio/container",
  envFile: "/repos/youtube-studio/.env",
};

const PAGE: HistoryPage = {
  records: [],
  summary: {
    units: 0,
    byOutcome: { completed: 0, failed: 0, "timed-out": 0, abandoned: 0 },
    quarantined: 0,
    costUsd: { api: 0, subscriptionEstimate: 0 },
    unitsWithoutCost: 0,
    unitsWithPartialUsage: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  nextBefore: null,
  retained: { "JesusFilm/phoebe#issues": null },
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

async function refusalOf(promise: Promise<unknown>): Promise<BridgeRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BridgeRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the exec", () => {
  test("execs `phoebe history --json` with no TTY and each filter as one --name=value word", () => {
    expect(
      historyExecArgs({
        cell: "JesusFilm/phoebe#issues",
        outcome: "failed",
        model: "-odd",
        before: "2026-11-20T10:00:00.000Z~issues~issue:5",
        limit: 50,
      }),
    ).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "history",
      "--cell=JesusFilm/phoebe#issues",
      "--outcome=failed",
      "--model=-odd",
      "--before=2026-11-20T10:00:00.000Z~issues~issue:5",
      "--limit=50",
      "--json",
    ]);
  });

  test("runs it through the install's compose file", async () => {
    const { runner, calls } = compose({ stdout: JSON.stringify(PAGE) });

    await readContainerHistory({ deployment: DEPLOYMENT, query: {}, runner });

    expect(calls[0]).toEqual([
      "compose",
      "-f",
      DEPLOYMENT.composeFile,
      "--env-file",
      DEPLOYMENT.envFile,
      ...historyExecArgs({}),
    ]);
  });
});

describe("what comes back", () => {
  test("a page the verb printed is answered as it stands", async () => {
    const { runner } = compose({ stdout: `${JSON.stringify(PAGE)}\n` });

    expect(await readContainerHistory({ deployment: DEPLOYMENT, query: {}, runner })).toEqual(PAGE);
  });

  test("an engine that predates the verb is too old, not a failure", async () => {
    const { runner } = compose({
      code: 1,
      stderr:
        "[phoebe] Unknown command `history` for `phoebe` (phoebe-agent v0.40.0). Known commands: boot, init, status.",
    });

    expect(await readContainerHistory({ deployment: DEPLOYMENT, query: {}, runner })).toBeNull();
  });

  test("any other failure is a refusal carrying the container's first line", async () => {
    const { runner } = compose({
      code: 1,
      stderr: "[phoebe] No deployment report, so no list of cells.\nmore",
    });

    const refusal = await refusalOf(
      readContainerHistory({ deployment: DEPLOYMENT, query: {}, runner }),
    );

    expect(refusal.error).toEqual({
      code: "unknown",
      message: "[phoebe] No deployment report, so no list of cells.",
    });
  });

  test("output that is not a page is refused rather than drawn", async () => {
    for (const stdout of ["not json", '{"schema":1}']) {
      const { runner } = compose({ stdout });
      const refusal = await refusalOf(
        readContainerHistory({ deployment: DEPLOYMENT, query: {}, runner }),
      );
      expect(refusal.error.code).toBe("unknown");
    }
  });

  test("a Docker that will not spawn is a refusal too", async () => {
    const runner: CommandRunner = () => Promise.reject(new Error("spawn docker ENOENT"));

    const refusal = await refusalOf(
      readContainerHistory({ deployment: DEPLOYMENT, query: {}, runner }),
    );

    expect(refusal.message).toBe("spawn docker ENOENT");
  });
});
