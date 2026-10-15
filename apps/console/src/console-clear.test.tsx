// @vitest-environment jsdom
// Pressing the console's clear button (#677).
//
// The render tests next door go to static markup, which is enough for anything
// a component draws from its props and nothing that it holds. A clear is held
// state — a mark per tab — and the button is how it gets set, so this one file
// mounts the console into a DOM and clicks. What the marks themselves do is
// logs.test.ts's; what is pinned here is the wiring: which tab a press acts on,
// what the two stores behind the pane do about it, and what survives one.

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DesktopBridge, LogLine, LogsEnded, RunLine, VerbRun } from "phoebe-agent/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { ConsoleView } from "./console-view.tsx";
import { bridge, install } from "./test-fixture.ts";

const LINES = [
  "[phoebe] boot: engine source local",
  "[phoebe:JesusFilm/phoebe:work] cycle: 1 candidate",
  "[JesusFilm/phoebe:work:claude] Reading the ticket…",
];

const INSTALL = install({ dir: "/repos/phoebe", name: "phoebe", state: "running" });

/** A run of `phoebe start`, with whatever it has printed so far. */
function run(runId: string, said: readonly string[]): VerbRun {
  return {
    runId,
    install: INSTALL.dir,
    verb: "start",
    startedAt: "2026-09-18T12:00:00.000Z",
    lines: said.map((line): RunLine => ({ runId, stream: "stdout", line })),
  };
}

/** What a test pushes down the streams the console subscribes to. */
type Streams = {
  bridge: DesktopBridge;
  /** One more container line. */
  line: (line: string) => Promise<void>;
  /** The stream stopped, for whatever reason. */
  end: (reason: string) => Promise<void>;
  /** A verb started on the install, replacing whatever ran before it. */
  started: (next: VerbRun) => Promise<void>;
  /** One more line from the run in flight. */
  said: (line: string) => Promise<void>;
};

/**
 * The fixture's bridge with its streams held onto, and the install's current
 * run kept here rather than fixed — a page that sees a line from a run it does
 * not hold asks main which run that is (verb-run.ts), and main has to answer
 * with the new one for the page to adopt it.
 */
function streams(current: VerbRun | null = null): Streams {
  const base = bridge({ logs: LINES });
  const sink: {
    line?: (line: LogLine) => void;
    ended?: (end: LogsEnded) => void;
    runLine?: (line: RunLine) => void;
  } = {};
  let held = current;
  return {
    bridge: {
      ...base,
      logs: {
        ...base.logs,
        lines: (callback) => {
          sink.line = callback;
          return () => undefined;
        },
        ended: (callback) => {
          sink.ended = callback;
          return () => undefined;
        },
      },
      runs: {
        ...base.runs,
        current: () => Promise.resolve(held),
        lines: (callback) => {
          sink.runLine = callback;
          return () => undefined;
        },
      },
    },
    line: (line) => act(async () => sink.line?.({ install: INSTALL.dir, line })),
    end: (reason) => act(async () => sink.ended?.({ install: INSTALL.dir, reason })),
    started: (next) =>
      act(async () => {
        held = next;
        for (const line of next.lines) sink.runLine?.(line);
      }),
    said: (line) =>
      act(async () => {
        if (held === null) return;
        const said: RunLine = { runId: held.runId, stream: "stdout", line };
        held = { ...held, lines: [...held.lines, said] };
        sink.runLine?.(said);
      }),
  };
}

const roots: Root[] = [];

beforeEach(() => {
  // React wants to be told the clicks below are a test's, not a browser's.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The console asks the OS whether it is dark (console-themes.ts) and jsdom
  // has no answer for that, so here it is never dark and never changes.
  window.matchMedia = ((media: string) => ({
    media,
    matches: false,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
});

/** The console, mounted and settled: the seed has landed and the effects have run. */
async function mount(element: ReactElement): Promise<HTMLElement> {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(element));
  return box;
}

/** The lines the pane is drawing, tags and all. */
function drawn(box: HTMLElement): string[] {
  return [...box.querySelectorAll(".logs-lines .log-line")].map((line) =>
    (line.textContent ?? "").trimEnd(),
  );
}

function control(box: HTMLElement, label: string): HTMLButtonElement {
  const found = box.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`no "${label}" button on the console`);
  return found;
}

function tabs(box: HTMLElement): HTMLButtonElement[] {
  return [...box.querySelectorAll<HTMLButtonElement>(".console-channel")];
}

function press(element: HTMLElement): Promise<void> {
  return act(async () => element.click());
}

async function open(box: HTMLElement, label: string): Promise<void> {
  const tab = tabs(box).find((one) => one.textContent === label);
  if (tab === undefined) throw new Error(`no "${label}" tab on the console`);
  await press(tab);
}

const CLEAR = "Clear the console";

describe("the clear button", () => {
  test("sits in the header, named, ahead of the gear", async () => {
    const box = await mount(
      <ConsoleView
        bridge={streams().bridge}
        install={INSTALL}
        host="linux"
        onSettings={() => undefined}
      />,
    );

    const clear = control(box, CLEAR);
    expect(clear.title).toBe(CLEAR);
    expect(clear.querySelector("svg")).not.toBeNull();
    const controls = [...(box.querySelector(".console-controls") as HTMLElement).children];
    expect(controls.indexOf(clear)).toBeLessThan(
      controls.indexOf(control(box, `Settings for ${INSTALL.name}`)),
    );
  });

  test("is disabled on a tab with nothing drawn: an empty console, and a cleared one", async () => {
    const quiet = await mount(
      <ConsoleView
        bridge={bridge({ logs: [] })}
        install={INSTALL}
        host={null}
        onSettings={() => undefined}
      />,
    );
    expect(control(quiet, CLEAR).disabled).toBe(true);

    const box = await mount(
      <ConsoleView
        bridge={streams().bridge}
        install={INSTALL}
        host={null}
        onSettings={() => undefined}
      />,
    );
    expect(control(box, CLEAR).disabled).toBe(false);

    await press(control(box, CLEAR));
    expect(control(box, CLEAR).disabled).toBe(true);
  });

  test("clears the tab that is open and leaves the other tabs their lines", async () => {
    const stream = streams();
    const box = await mount(
      <ConsoleView
        bridge={stream.bridge}
        install={INSTALL}
        host={null}
        onSettings={() => undefined}
      />,
    );

    await open(box, "phoebe:work");
    expect(drawn(box)).toEqual([LINES[1]]);

    await press(control(box, CLEAR));

    expect(drawn(box)).toEqual([]);
    // The tab stays, to come back to, and stays the one open.
    expect(tabs(box).map((tab) => tab.textContent)).toContain("phoebe:work");

    // Cleared from its own tab is read everywhere: all has lost that line too,
    // and kept every line the clear was not about.
    await open(box, "all");
    expect(drawn(box)).toEqual([LINES[0], LINES[2]]);

    // What the cleared channel says next is drawn again, on both tabs.
    const next = "[phoebe:JesusFilm/phoebe:work] cycle: 2 candidates";
    await stream.line(next);
    expect(drawn(box)).toEqual([LINES[0], LINES[2], next]);
    await open(box, "phoebe:work");
    expect(drawn(box)).toEqual([next]);
  });

  test("a press on all takes every tab's lines, and the ending stays under them", async () => {
    const stream = streams();
    const box = await mount(
      <ConsoleView
        bridge={stream.bridge}
        install={INSTALL}
        host={null}
        onSettings={() => undefined}
      />,
    );
    await stream.end("the container exited (code 0)");

    await press(control(box, CLEAR));

    expect(drawn(box)).toEqual([]);
    for (const tab of ["phoebe:work", "phoebe:work:claude"]) {
      await open(box, tab);
      expect(drawn(box), tab).toEqual([]);
    }
    // Status, not output: the ending is not the button's to clear.
    expect(box.querySelector(".console-ended")?.textContent).toBe("the container exited (code 0)");
  });

  test("on the cli tab drops the past runs and keeps what the run says next", async () => {
    const stream = streams(run("run-1", ["pulling the image", "started"]));
    const box = await mount(
      <ConsoleView
        bridge={stream.bridge}
        install={INSTALL}
        host={null}
        channel="cli"
        onSettings={() => undefined}
      />,
    );
    // A second verb pushes the first run up above the one in flight.
    await stream.started(run("run-2", ["stopping"]));
    expect(drawn(box)).toEqual(["pulling the image", "started", "stopping"]);

    await press(control(box, CLEAR));

    expect(drawn(box)).toEqual([]);
    expect(control(box, CLEAR).disabled).toBe(true);
    // The run is still going, and what it says from here shows.
    await stream.said("stopped");
    expect(drawn(box)).toEqual(["stopped"]);
    // Its footer is status too, and stays.
    expect(box.querySelector(".console-cli")?.textContent).toContain("phoebe start");
  });
});
