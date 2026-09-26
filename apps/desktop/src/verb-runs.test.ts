// The rules a verb run holds to, with no verb and no Docker anywhere near it.

import { describe, expect, test } from "vite-plus/test";
import { MAX_RUN_LINES, type RunExit, type RunLine } from "phoebe-agent/contracts";
import { BridgeRefusal } from "./channels.ts";
import { createVerbRuns, type Dispatch, type Killable, type VerbRuns } from "./verb-runs.ts";

const AT = new Date("2026-09-18T09:00:00.000Z");
const STOPPED = { verb: "stop" as const, outcome: { kind: "stopped" as const } };

/** A run harness: the registry plus what it emitted. */
function harness(dispatch: Dispatch): {
  runs: VerbRuns;
  lines: RunLine[];
  exits: RunExit[];
} {
  const lines: RunLine[] = [];
  const exits: RunExit[] = [];
  const runs = createVerbRuns({
    dispatch,
    onLine: (line) => lines.push(line),
    onExit: (exit) => exits.push(exit),
    now: () => AT,
  });
  return { runs, lines, exits };
}

/** A dispatch that never finishes, so the run stays in flight. */
const forever: Dispatch = () => new Promise(() => {});

/** Yield to the microtask queue, which is where a settled dispatch lands. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("starting a run", () => {
  test("hands back an id and records what is running", () => {
    const { runs } = harness(forever);

    const runId = runs.start({ install: "/repos/one", verb: "start" });

    expect(runs.current("/repos/one")).toEqual({
      runId,
      install: "/repos/one",
      verb: "start",
      startedAt: AT.toISOString(),
      lines: [],
    });
  });

  test("refuses a second run on a busy install, rather than queueing it", () => {
    // A queue lets an operator stack `stop` behind `start` and watch the wrong
    // one win, minutes later (#527 §2).
    const { runs } = harness(forever);
    runs.start({ install: "/repos/one", verb: "start" });

    expect(() => runs.start({ install: "/repos/one", verb: "stop" })).toThrow(BridgeRefusal);
    try {
      runs.start({ install: "/repos/one", verb: "stop" });
    } catch (error) {
      expect((error as BridgeRefusal).error.code).toBe("busy");
      expect((error as BridgeRefusal).error.instruction).toContain("cancel");
    }
  });

  test("runs in parallel across installs, because they share nothing", () => {
    const { runs } = harness(forever);

    const one = runs.start({ install: "/repos/one", verb: "start" });
    const two = runs.start({ install: "/repos/two", verb: "start" });

    expect(one).not.toBe(two);
    expect(runs.current("/repos/one")?.runId).toBe(one);
    expect(runs.current("/repos/two")?.runId).toBe(two);
  });

  test("a finished run is replaced by the next one on that install", async () => {
    const { runs } = harness(() => Promise.resolve(STOPPED));
    runs.start({ install: "/repos/one", verb: "stop" });
    await settle();

    const second = runs.start({ install: "/repos/one", verb: "start" });

    expect(runs.current("/repos/one")?.runId).toBe(second);
  });

  test("an install that has never run says so rather than inventing an empty run", () => {
    const { runs } = harness(forever);

    expect(runs.current("/repos/never")).toBeNull();
  });
});

describe("lines", () => {
  test("go to the listener and into the buffer the next reload reads", async () => {
    const { runs, lines } = harness(async (_request, { io }) => {
      io.stdout("[phoebe] Stopping.");
      io.stderr("a warning");
      return STOPPED;
    });

    const runId = runs.start({ install: "/repos/one", verb: "stop" });
    await settle();

    expect(lines).toEqual([
      { runId, stream: "stdout", line: "[phoebe] Stopping." },
      { runId, stream: "stderr", line: "a warning" },
    ]);
    expect(runs.current("/repos/one")?.lines).toEqual(lines);
  });

  test("a chunk with newlines in it becomes one event per line", async () => {
    const { runs, lines } = harness(async (_request, { io }) => {
      io.stdout("first\nsecond");
      return STOPPED;
    });
    runs.start({ install: "/repos/one", verb: "stop" });
    await settle();

    expect(lines.map((line) => line.line)).toEqual(["first", "second"]);
  });

  test("the buffer is bounded, so one long run cannot grow main without end", async () => {
    const { runs } = harness(async (_request, { io }) => {
      for (let index = 0; index < MAX_RUN_LINES + 50; index += 1) io.stdout(`line ${index}`);
      return STOPPED;
    });
    runs.start({ install: "/repos/one", verb: "stop" });
    await settle();

    const buffered = runs.current("/repos/one")!.lines;
    expect(buffered).toHaveLength(MAX_RUN_LINES);
    // The tail is what the tab shows, so the oldest are the ones that go.
    expect(buffered[buffered.length - 1]!.line).toBe(`line ${MAX_RUN_LINES + 49}`);
  });
});

describe("ending", () => {
  test("carries the verb's own typed outcome, which is why nothing parses stdout", async () => {
    const { runs, exits } = harness(() => Promise.resolve(STOPPED));

    const runId = runs.start({ install: "/repos/one", verb: "stop" });
    await settle();

    expect(exits).toEqual([{ runId, code: 0, outcome: STOPPED }]);
    expect(runs.current("/repos/one")?.exit).toEqual(exits[0]);
  });

  test("a verb that threw exits non-zero with its reason as a line, and never rejects", async () => {
    const { runs, lines, exits } = harness(() =>
      Promise.reject(new Error("docker is not running")),
    );

    const runId = runs.start({ install: "/repos/one", verb: "start" });
    await settle();

    expect(lines).toEqual([{ runId, stream: "stderr", line: "docker is not running" }]);
    expect(exits).toEqual([{ runId, code: 1 }]);
  });
});

describe("cancelling", () => {
  function killable(): Killable & { signals: string[] } {
    const signals: string[] = [];
    return { signals, kill: (signal) => signals.push(signal) };
  }

  test("signals the child the verb spawned", async () => {
    const child = killable();
    const { runs, lines } = harness((_request, { register }) => {
      register(child);
      return new Promise(() => {});
    });

    const runId = runs.start({ install: "/repos/one", verb: "start" });
    runs.cancel(runId);

    expect(child.signals).toEqual(["SIGTERM"]);
    expect(lines.at(-1)?.line).toContain("cancelled");
  });

  test("reaches a child that was still spawning when the cancel landed", async () => {
    const child = killable();
    let registerLater: ((child: Killable) => void) | null = null;
    const { runs } = harness((_request, { register }) => {
      registerLater = register;
      return new Promise(() => {});
    });

    const runId = runs.start({ install: "/repos/one", verb: "start" });
    runs.cancel(runId);
    registerLater!(child);

    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("a cancelled run that still returns an outcome is not a success", async () => {
    let finish: (() => void) | null = null;
    const { runs, exits } = harness(
      () => new Promise((resolve) => (finish = () => resolve(STOPPED))),
    );

    const runId = runs.start({ install: "/repos/one", verb: "stop" });
    runs.cancel(runId);
    finish!();
    await settle();

    expect(exits).toEqual([{ runId, code: 1 }]);
  });

  test("refuses a verb that spawns nothing to signal", () => {
    const { runs } = harness(forever);
    const runId = runs.start({ install: "/repos/one", verb: "doctor" });

    expect(() => runs.cancel(runId)).toThrow(/spawns nothing/);
  });

  test("refuses a run that is already over", async () => {
    const { runs } = harness(() => Promise.resolve(STOPPED));
    const runId = runs.start({ install: "/repos/one", verb: "stop" });
    await settle();

    expect(() => runs.cancel(runId)).toThrow(/already finished/);
  });
});

describe("a secret value is a run argument and nothing else (#527 §7)", () => {
  const SECRET = "ghp_a_value_nobody_should_see";

  test("the run record the window reads back holds no value", () => {
    const { runs } = harness(forever);

    runs.start({ install: "/repos/one", verb: "secret set", key: "GH_TOKEN", value: SECRET });

    // The record is what `runs.current` hands a renderer on reload, and what the
    // buffer keeps for the life of the process. The value belongs to neither.
    expect(JSON.stringify(runs.current("/repos/one"))).not.toContain(SECRET);
  });

  test("the busy refusal names the verb, not what it was asked to write", () => {
    const { runs } = harness(forever);
    runs.start({ install: "/repos/one", verb: "secret set", key: "GH_TOKEN", value: SECRET });

    try {
      runs.start({ install: "/repos/one", verb: "secret set", key: "GH_TOKEN", value: SECRET });
      expect.unreachable("a second run on a busy install is refused");
    } catch (error) {
      expect((error as Error).message).toContain("phoebe secret set");
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
  });

  test("a dispatch that throws puts its message in the buffer, and it is not the value", async () => {
    // The writers' own failures name the key; this pins the registry's half —
    // whatever a write throws is what lands, so a writer must never throw a value.
    const { runs, lines } = harness(() => Promise.reject(new Error("GH_TOKEN was not written")));

    runs.start({ install: "/repos/one", verb: "secret set", key: "GH_TOKEN", value: SECRET });
    await settle();

    expect(lines.map((line) => line.line)).toEqual(["GH_TOKEN was not written"]);
  });
});
