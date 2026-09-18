// Reading a container and watching one, with a stub where Docker would be.
//
// The exec's contract is the interesting half: it never throws, and everything
// that can go wrong comes back as a sentence the tab can print. The watcher's is
// that it re-opens a stream that ended — Docker Desktop restarting must not be
// the moment the loop goes quiet for good.

import { describe, expect, test } from "vite-plus/test";
import type { CommandRunner, DeploymentCompose } from "../../../src/deployment-compose.ts";
import {
  readContainerReport,
  STATUS_ARGV,
  watchContainerEvents,
  type EventChild,
  type EventSpawner,
} from "./container-read.ts";

const DEPLOYMENT: DeploymentCompose = {
  deploymentDir: "/repos/youtube-studio",
  composeFile: "/repos/youtube-studio/container/compose.yml",
  containerDir: "/repos/youtube-studio/container",
  envFile: "/repos/youtube-studio/.env",
};

/** A Compose that answers one exec with whatever the test names. */
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

describe("reading the report", () => {
  test("execs `phoebe status --json` in the container, with no TTY", async () => {
    const { runner, calls } = compose({ stdout: '{"schema":1}' });

    await readContainerReport({ deployment: DEPLOYMENT, runner });

    expect(calls[0]).toEqual([
      "compose",
      "-f",
      DEPLOYMENT.composeFile,
      "--env-file",
      DEPLOYMENT.envFile,
      ...STATUS_ARGV,
    ]);
    expect(STATUS_ARGV).toContain("-T");
  });

  test("hoists the schema, so a reader decides before it indexes a field", async () => {
    const { runner } = compose({ stdout: '{"schema":1,"identity":{"name":"studio"}}\n' });

    const read = await readContainerReport({ deployment: DEPLOYMENT, runner });

    expect(read).toEqual({
      ok: true,
      schema: 1,
      report: { schema: 1, identity: { name: "studio" } },
    });
  });

  test("a non-zero exit is the container's own first line, not a stack", async () => {
    const { runner } = compose({
      code: 1,
      stderr: "service phoebe is not running\nrun `docker compose up`",
    });

    const read = await readContainerReport({ deployment: DEPLOYMENT, runner });

    expect(read).toEqual({ ok: false, reason: "service phoebe is not running" });
  });

  test("output that is not JSON is a reason, never a thrown parse error", async () => {
    const { runner } = compose({ stdout: "phoebe: unknown command `status`" });

    const read = await readContainerReport({ deployment: DEPLOYMENT, runner });

    expect(read).toEqual({ ok: false, reason: "the container did not print a report as JSON" });
  });

  test("JSON with no schema integer is refused rather than guessed at", async () => {
    const { runner } = compose({ stdout: '{"identity":{"name":"studio"}}' });

    const read = await readContainerReport({ deployment: DEPLOYMENT, runner });

    expect(read).toEqual({ ok: false, reason: "the report carries no `schema`" });
  });

  test("a runner that throws is a reason too, because the loop must keep reading", async () => {
    const read = await readContainerReport({
      deployment: DEPLOYMENT,
      runner: () => Promise.reject(new Error("spawn docker ENOENT")),
    });

    expect(read).toEqual({ ok: false, reason: "spawn docker ENOENT" });
  });
});

/** A spawned `docker compose events` a test can feed lines to and close. */
function fakeStream() {
  const spawned: { args: readonly string[] }[] = [];
  let data: ((chunk: string) => void) | undefined;
  let close: (() => void) | undefined;
  let killed = 0;

  const spawn: EventSpawner = (spec) => {
    spawned.push({ args: spec.args });
    const child: EventChild = {
      stdout: {
        on: (_event, listener) => {
          data = listener as (chunk: string) => void;
        },
      },
      on: (event, listener) => {
        if (event === "close") close = listener as () => void;
      },
      kill: () => {
        killed += 1;
      },
    };
    return child;
  };

  return {
    spawn,
    spawned,
    send: (chunk: string) => data?.(chunk),
    end: () => close?.(),
    get killed() {
      return killed;
    },
  };
}

describe("watching the container", () => {
  test("subscribes to this deployment's own Compose stream", () => {
    const stream = fakeStream();

    watchContainerEvents({
      deployment: DEPLOYMENT,
      onChange: () => undefined,
      deps: { spawn: stream.spawn },
    });

    expect(stream.spawned[0]?.args).toEqual([
      "compose",
      "-f",
      DEPLOYMENT.composeFile,
      "--env-file",
      DEPLOYMENT.envFile,
      "events",
      "--json",
    ]);
  });

  test("one change per event, however the chunks were split", () => {
    const stream = fakeStream();
    let changes = 0;
    watchContainerEvents({
      deployment: DEPLOYMENT,
      onChange: () => {
        changes += 1;
      },
      deps: { spawn: stream.spawn },
    });

    stream.send('{"service":"phoebe","action":"st');
    expect(changes).toBe(0);
    stream.send('art"}\n{"service":"phoebe","action":"die"}\n');

    expect(changes).toBe(2);
  });

  test("a sibling service moving is not this install's container moving", () => {
    const stream = fakeStream();
    let changes = 0;
    watchContainerEvents({
      deployment: DEPLOYMENT,
      onChange: () => {
        changes += 1;
      },
      deps: { spawn: stream.spawn },
    });

    stream.send('{"service":"caddy","action":"start"}\nnot json at all\n');

    expect(changes).toBe(0);
  });

  test("a stream that ended is re-opened, so a Docker restart is not the end of it", () => {
    const stream = fakeStream();
    const due: (() => void)[] = [];
    watchContainerEvents({
      deployment: DEPLOYMENT,
      onChange: () => undefined,
      deps: { spawn: stream.spawn, setTimer: (fn) => due.push(fn), clearTimer: () => undefined },
    });

    stream.end();
    due.forEach((fn) => fn());

    expect(stream.spawned.length).toBe(2);
  });

  test("unsubscribing kills the stream and stops it coming back", () => {
    const stream = fakeStream();
    const due: (() => void)[] = [];
    const stop = watchContainerEvents({
      deployment: DEPLOYMENT,
      onChange: () => undefined,
      deps: { spawn: stream.spawn, setTimer: (fn) => due.push(fn), clearTimer: () => undefined },
    });

    stop();
    stream.end();
    due.forEach((fn) => fn());

    expect(stream.killed).toBe(1);
    expect(stream.spawned.length).toBe(1);
  });
});
