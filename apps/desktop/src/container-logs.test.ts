import { MAX_LOG_LINES, type LogLine, type LogsEnded } from "phoebe-agent/contracts";
import { describe, expect, test } from "vite-plus/test";
import type { DeploymentCompose } from "../../../src/deployment-compose.ts";
import { createContainerLogs } from "./container-logs.ts";
import type { EventChild, EventSpawner } from "./container-read.ts";

const DIR = "/repos/youtube-studio";
const DEPLOYMENT: DeploymentCompose = {
  deploymentDir: DIR,
  composeFile: `${DIR}/container/compose.yml`,
  containerDir: `${DIR}/container`,
  envFile: `${DIR}/.env`,
};

/** A spawned `docker compose logs` a test can feed chunks to, close, or fail. */
function fakeStream() {
  const spawned: { args: readonly string[]; cwd: string }[] = [];
  let data: ((chunk: string) => void) | undefined;
  let close: (() => void) | undefined;
  let error: ((reason: Error) => void) | undefined;
  let killed = 0;

  const spawn: EventSpawner = (spec) => {
    spawned.push({ args: spec.args, cwd: spec.cwd });
    const child: EventChild = {
      stdout: {
        on: (_event, listener) => {
          data = listener as (chunk: string) => void;
        },
      },
      on: (event, listener) => {
        if (event === "close") close = listener as () => void;
        if (event === "error") error = listener as (reason: Error) => void;
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
    fail: (reason: Error) => error?.(reason),
    get killed() {
      return killed;
    },
  };
}

function harness() {
  const lines: LogLine[] = [];
  const ended: LogsEnded[] = [];
  const logs = createContainerLogs({
    onLine: (line) => lines.push(line),
    onEnded: (end) => ended.push(end),
  });
  return { logs, lines, ended };
}

describe("following a container's output", () => {
  test("is `logs --follow` on the phoebe service, with a tail and no prefix", () => {
    const stream = fakeStream();
    const { logs } = harness();

    const held = logs.follow(DIR, DEPLOYMENT, stream.spawn);

    expect(held).toEqual([]);
    expect(stream.spawned).toHaveLength(1);
    expect(stream.spawned[0]?.cwd).toBe(`${DIR}/container`);
    const args = stream.spawned[0]?.args ?? [];
    expect(args.slice(0, 2)).toEqual(["compose", "-f"]);
    expect(args).toContain("--env-file");
    expect(args.slice(-6)).toEqual([
      "logs",
      "--follow",
      "--tail",
      "200",
      "--no-log-prefix",
      "phoebe",
    ]);
  });

  test("lines arrive whole, tagged with the install, however the chunks fall", () => {
    const stream = fakeStream();
    const { logs, lines } = harness();
    logs.follow(DIR, DEPLOYMENT, stream.spawn);

    stream.send("[phoebe] boot\n[phoebe] po");
    stream.send("lling\r\n");

    expect(lines).toEqual([
      { install: DIR, line: "[phoebe] boot" },
      { install: DIR, line: "[phoebe] polling" },
    ]);
  });

  test("a second follow joins the stream and gets the lines so far", () => {
    const stream = fakeStream();
    const { logs } = harness();
    logs.follow(DIR, DEPLOYMENT, stream.spawn);
    stream.send("one\ntwo\n");

    const held = logs.follow(DIR, DEPLOYMENT, stream.spawn);

    expect(held).toEqual(["one", "two"]);
    expect(stream.spawned).toHaveLength(1);
  });

  test("keeps the newest lines within the bound", () => {
    const stream = fakeStream();
    const { logs } = harness();
    logs.follow(DIR, DEPLOYMENT, stream.spawn);
    for (let i = 0; i < MAX_LOG_LINES + 3; i++) stream.send(`line ${i}\n`);

    const held = logs.follow(DIR, DEPLOYMENT, stream.spawn);

    expect(held).toHaveLength(MAX_LOG_LINES);
    expect(held[0]).toBe("line 3");
  });

  test("a stream that closes on its own is reported, with the partial line first", () => {
    const stream = fakeStream();
    const { logs, lines, ended } = harness();
    logs.follow(DIR, DEPLOYMENT, stream.spawn);
    stream.send("last words");

    stream.end();

    expect(lines.map((line) => line.line)).toEqual(["last words"]);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.install).toBe(DIR);
    expect(ended[0]?.reason).toContain("ended");
    // Gone: the next follow is a fresh stream.
    logs.follow(DIR, DEPLOYMENT, stream.spawn);
    expect(stream.spawned).toHaveLength(2);
  });

  test("a child that fails to start is an ending with its reason, not a throw", () => {
    const { logs, ended } = harness();
    const spawn: EventSpawner = () => {
      throw new Error("spawn docker ENOENT");
    };

    expect(logs.follow(DIR, DEPLOYMENT, spawn)).toEqual([]);
    expect(ended[0]?.reason).toBe("spawn docker ENOENT");
  });

  test("a stream error is an ending too", () => {
    const stream = fakeStream();
    const { logs, ended } = harness();
    logs.follow(DIR, DEPLOYMENT, stream.spawn);

    stream.fail(new Error("EPIPE"));

    expect(ended[0]?.reason).toBe("EPIPE");
  });

  test("stop kills the child and reports nothing — the operator asked", () => {
    const stream = fakeStream();
    const { logs, ended } = harness();
    logs.follow(DIR, DEPLOYMENT, stream.spawn);

    logs.stop(DIR);
    stream.end();

    expect(stream.killed).toBe(1);
    expect(ended).toEqual([]);
    expect(logs.follow(DIR, DEPLOYMENT, stream.spawn)).toEqual([]);
  });

  test("stopping an install that is not followed is nothing", () => {
    const { logs } = harness();

    expect(() => logs.stop(DIR)).not.toThrow();
  });

  test("stopAll ends every stream", () => {
    const stream = fakeStream();
    const { logs } = harness();
    logs.follow(DIR, DEPLOYMENT, stream.spawn);
    logs.follow("/repos/two", { ...DEPLOYMENT, deploymentDir: "/repos/two" }, stream.spawn);

    logs.stopAll();

    expect(stream.killed).toBe(2);
  });
});
