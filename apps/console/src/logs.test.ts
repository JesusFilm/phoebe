import { MAX_LOG_LINES } from "phoebe-agent/contracts";
import type { RunLine, VerbRun } from "phoebe-agent/contracts";
import { describe, expect, test } from "vite-plus/test";
import {
  appendLogLine,
  drawnLines,
  EMPTY_LOGS,
  logsCleared,
  logsEnded,
  logsSeeded,
  runDrawn,
  type LogsView,
} from "./logs.ts";
import { ALL_CHANNEL, BOOT_CHANNEL, channelOf, tenantChannel } from "./logs-channels.ts";

const LINES = [
  "[phoebe] boot: engine source local",
  "[phoebe:JesusFilm/phoebe:work] cycle: 1 candidate",
  "[phoebe:JesusFilm/phoebe:work][issues issue:88][claude] Reading the ticket…",
  "[phoebe:JesusFilm/youtube-studio:work] cycle: nothing ready",
  "npm warn deprecated something",
];

/** A view holding every line above, as a pane that followed them would. */
function held(lines: readonly string[] = LINES): LogsView {
  let view = EMPTY_LOGS;
  for (const line of lines) view = appendLogLine(view, line);
  return view;
}

describe("the logs pane's view", () => {
  test("starts from what main held, and runs", () => {
    expect(logsSeeded(["a", "b"])).toMatchObject({ lines: ["a", "b"], ended: null });
  });

  test("a seed longer than the bound keeps its newest lines", () => {
    const many = Array.from({ length: MAX_LOG_LINES + 5 }, (_, i) => `line ${i}`);

    const view = logsSeeded(many);

    expect(view.lines).toHaveLength(MAX_LOG_LINES);
    expect(view.lines[0]).toBe("line 5");
  });

  test("appending past the bound drops the oldest line", () => {
    let view = EMPTY_LOGS;
    for (const line of ["one", "two", "three"]) view = appendLogLine(view, line, 2);

    expect(view.lines).toEqual(["two", "three"]);
  });

  test("an ending keeps the lines and records why", () => {
    const view = logsEnded(appendLogLine(EMPTY_LOGS, "last words"), "the container exited");

    expect(view).toMatchObject({ lines: ["last words"], ended: "the container exited" });
  });
});

describe("the channels a view has seen", () => {
  test("a seed and a fresh view carry the channels of the lines they hold, and no marks", () => {
    expect(EMPTY_LOGS.channels.size).toBe(0);
    expect(EMPTY_LOGS.marks.size).toBe(0);

    const seeded = logsSeeded(LINES);

    expect([...seeded.channels]).toEqual([
      BOOT_CHANNEL,
      "JesusFilm/phoebe:work",
      "JesusFilm/youtube-studio:work",
    ]);
    expect(seeded.marks.size).toBe(0);
  });

  test("each line that arrives adds its own channel", () => {
    const view = appendLogLine(
      appendLogLine(EMPTY_LOGS, "[phoebe] boot: ok"),
      "[phoebe:acme/a:work] cycle",
    );

    expect([...view.channels]).toEqual([BOOT_CHANNEL, "acme/a:work"]);
  });

  test("a channel keeps its place once seen, however many of its lines follow", () => {
    const view = appendLogLine(held(), "[phoebe:JesusFilm/phoebe:work] cycle: 2 candidates");

    expect([...view.channels]).toEqual([...held().channels]);
  });

  test("and keeps it after the bound has dropped every line it said", () => {
    let view = held(LINES.slice(0, 2));
    for (const line of ["[phoebe] boot: on", "[phoebe] boot: and on"]) {
      view = appendLogLine(view, line, 2);
    }

    expect(view.lines.every((line) => channelOf(line) === BOOT_CHANNEL)).toBe(true);
    expect([...view.channels]).toContain("JesusFilm/phoebe:work");
  });
});

describe("clearing a tab", () => {
  test("the stream's mark hides every line held and none that follows", () => {
    const view = appendLogLine(logsCleared(held(), ALL_CHANNEL), "[phoebe] boot: and on we go");

    expect(drawnLines(view, ALL_CHANNEL)).toEqual(["[phoebe] boot: and on we go"]);
    expect(view.lines).toHaveLength(LINES.length + 1);
  });

  test("a channel's mark hides that channel's earlier lines and nobody else's", () => {
    const cleared = logsCleared(held(), "JesusFilm/phoebe:work");

    // The agent's line is the pipeline's own (#686), so it goes with the engine's.
    expect(drawnLines(cleared, "JesusFilm/phoebe:work")).toEqual([]);
    expect(drawnLines(cleared, "JesusFilm/youtube-studio:work")).toEqual([LINES[3]]);
    expect(drawnLines(cleared, BOOT_CHANNEL)).toEqual([LINES[0], LINES[4]]);
  });

  test("a line cleared from its own tab is read on all too", () => {
    const cleared = logsCleared(held(), "JesusFilm/phoebe:work");

    expect(drawnLines(cleared, ALL_CHANNEL)).toEqual([LINES[0], LINES[3], LINES[4]]);
  });

  test("a tenant's mark covers every channel under the slug", () => {
    const cleared = logsCleared(held(), tenantChannel("JesusFilm/phoebe"));

    expect(drawnLines(cleared, tenantChannel("JesusFilm/phoebe"))).toEqual([]);
    expect(drawnLines(cleared, ALL_CHANNEL)).toEqual([LINES[0], LINES[3], LINES[4]]);
    expect(drawnLines(cleared, tenantChannel("JesusFilm/youtube-studio"))).toEqual([LINES[3]]);
  });

  test("a line that arrives after a channel's clear shows on its tab again", () => {
    const next = "[phoebe:JesusFilm/phoebe:work] cycle: 2 candidates";
    const view = appendLogLine(logsCleared(held(), "JesusFilm/phoebe:work"), next);

    expect(drawnLines(view, "JesusFilm/phoebe:work")).toEqual([next]);
    expect(drawnLines(view, ALL_CHANNEL)).toContain(next);
  });

  test("the ending stays through a clear: it is status, not output", () => {
    const view = logsCleared(logsEnded(held(), "the container exited"), ALL_CHANNEL);

    expect(view.ended).toBe("the container exited");
    expect(drawnLines(view, ALL_CHANNEL)).toEqual([]);
  });

  test("the marks shift down as the bound drops lines, and floor at zero", () => {
    let view = logsCleared(held(LINES.slice(0, 3)), ALL_CHANNEL);
    view = logsCleared(view, BOOT_CHANNEL);
    expect([...view.marks]).toEqual([
      [ALL_CHANNEL, 3],
      [BOOT_CHANNEL, 3],
    ]);

    view = appendLogLine(view, "[phoebe] boot: four", 3);
    expect([...view.marks]).toEqual([
      [ALL_CHANNEL, 2],
      [BOOT_CHANNEL, 2],
    ]);

    for (const line of ["five", "six", "seven"]) view = appendLogLine(view, line, 3);
    expect([...view.marks]).toEqual([
      [ALL_CHANNEL, 0],
      [BOOT_CHANNEL, 0],
    ]);
    // A mark at zero hides nothing, so every line still held is drawn.
    expect(drawnLines(view, ALL_CHANNEL)).toEqual(["five", "six", "seven"]);
  });

  test("a wider clear takes over from the marks it covers", () => {
    const view = logsCleared(logsCleared(held(), "JesusFilm/phoebe:work"), ALL_CHANNEL);

    expect([...view.marks]).toEqual([[ALL_CHANNEL, LINES.length]]);
  });

  test("a reset leaves no marks and no channels", () => {
    expect(EMPTY_LOGS).toEqual({
      lines: [],
      ended: null,
      channels: new Set(),
      marks: new Map(),
    });
  });
});

describe("clearing the cli tab", () => {
  const run: VerbRun = {
    runId: "run-1",
    install: "/repos/youtube-studio",
    verb: "start",
    startedAt: "2026-09-18T12:00:00.000Z",
    lines: [
      { runId: "run-1", stream: "stdout", line: "pulling" },
      { runId: "run-1", stream: "stdout", line: "started" },
    ],
  };

  /** The clear the operator presses with the run as it stands. */
  function readSoFar(one: VerbRun) {
    return { runId: one.runId, after: one.lines.at(-1) ?? null };
  }

  test("the run's lines so far go, and what arrives next shows", () => {
    const mark = readSoFar(run);
    const up: RunLine = { runId: "run-1", stream: "stdout", line: "up" };
    const later: VerbRun = { ...run, lines: [...run.lines, up] };

    expect(runDrawn(run, mark).lines).toEqual([]);
    expect(runDrawn(later, mark).lines).toEqual([up]);
  });

  // The run store is bounded as well, and a build or a migrate prints enough
  // to reach it. The mark names the last line it covered rather than counting
  // them, so the output that arrived since a clear is never mistaken for it.
  test("a run long enough to drop the line the mark named draws everything left", () => {
    const mark = readSoFar(run);
    const since = Array.from({ length: 3 }, (_, at): RunLine => {
      return { runId: "run-1", stream: "stdout", line: `and on ${at}` };
    });

    expect(runDrawn({ ...run, lines: since }, mark).lines).toEqual(since);
  });

  test("a clear on a run that has printed nothing hides nothing of what follows", () => {
    const mark = readSoFar({ ...run, lines: [] });

    expect(runDrawn(run, mark)).toEqual(run);
  });

  test("a mark left on an earlier run hides nothing of the next one", () => {
    expect(runDrawn(run, { runId: "run-0", after: run.lines[0] as RunLine })).toEqual(run);
    expect(runDrawn(run, null)).toEqual(run);
  });
});
