// @vitest-environment jsdom
// "Run observer" in the History tab's header (#938): shown only with a tenant
// that declares the observer, a confirm with 14d filled in, the ask it sends,
// disabled with the start time while a run is in flight, each refusal's reason,
// "too old", the tab asking again when the run settles, and the drawer's `#N`
// links.

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HistoryQuery, ObserveRequest } from "phoebe-agent/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { DeploymentTabPanel } from "./deployment-tabs.tsx";
import { HistoryTab } from "./history-tab.tsx";
import type { HistoryReader } from "./history.ts";
import type { ObserveFetch, ObserveRunner, ObserverTarget } from "./observer.ts";
import {
  ago,
  cell,
  configReport,
  effectiveConfig,
  historyPage,
  historyRecord,
  NOW,
  report,
} from "./test-fixture.ts";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
});

async function mount(element: ReactElement): Promise<{ box: HTMLElement; root: Root }> {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(element));
  return { box, root };
}

function reader(): { read: HistoryReader; asked: HistoryQuery[] } {
  const asked: HistoryQuery[] = [];
  return {
    asked,
    read: (query) => {
      asked.push(query);
      return Promise.resolve({ kind: "page", page: historyPage([]) });
    },
  };
}

function runner(answer: ObserveFetch | Error): { run: ObserveRunner; asked: ObserveRequest[] } {
  const asked: ObserveRequest[] = [];
  return {
    asked,
    run: (request) => {
      asked.push(request);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

const TARGET: ObserverTarget = {
  label: "JesusFilm/youtube-studio",
  tenant: "JesusFilm/youtube-studio",
  pipeline: "observe",
  runningSince: null,
};

const STARTED: ObserveFetch = {
  kind: "answer",
  answer: {
    outcome: "started",
    tenant: "JesusFilm/youtube-studio",
    detail:
      "observer run started for JesusFilm/youtube-studio (pipeline observe), over the last 14d.",
  },
};

function tab(
  read: HistoryReader,
  observer?: { targets: ObserverTarget[]; run: ObserveRunner },
  now: Date = NOW,
): ReactElement {
  return (
    <HistoryTab
      reader={read}
      scope="/repos/youtube-studio"
      cells={[cell()]}
      now={now}
      {...(observer === undefined ? {} : { observer })}
    />
  );
}

function button(box: HTMLElement, text = "Run observer"): HTMLButtonElement | undefined {
  return [...box.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  await act(async () => {
    descriptor.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function confirm(box: HTMLElement): Promise<void> {
  const form = box.querySelector<HTMLFormElement>("form.run-observer-confirm")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("the button", () => {
  test("is not there when no tenant declares the observer, or the arm cannot start one", async () => {
    const { read } = reader();
    const { run } = runner(STARTED);

    expect(button((await mount(tab(read, { targets: [], run }))).box)).toBeUndefined();
    expect(button((await mount(tab(read))).box)).toBeUndefined();
  });

  test("opens a confirm with 14d filled in, and confirming sends that lookback", async () => {
    const { read } = reader();
    const { run, asked } = runner(STARTED);
    const { box } = await mount(tab(read, { targets: [TARGET], run }));

    await click(button(box)!);
    const lookback = box.querySelector<HTMLInputElement>('input[aria-label="Lookback"]')!;
    expect(lookback.value).toBe("14d");

    await confirm(box);
    expect(asked).toEqual([{ lookback: "14d" }]);
    expect(box.querySelector('[role="status"]')?.textContent).toContain(
      "Observer run started for JesusFilm/youtube-studio",
    );
    // Held down until the report shows the run, with the moment of the ask.
    expect(button(box)!.disabled).toBe(true);
    expect(button(box)!.title).toContain(new Date(NOW).toLocaleString());
  });

  test("an edited lookback is what is sent; one that is not a period cannot be", async () => {
    const { read } = reader();
    const { run, asked } = runner(STARTED);
    const { box } = await mount(tab(read, { targets: [TARGET], run }));

    await click(button(box)!);
    const lookback = box.querySelector<HTMLInputElement>('input[aria-label="Lookback"]')!;
    await type(lookback, "fortnight");
    expect(button(box, "Start")!.disabled).toBe(true);
    expect(box.textContent).toContain("A period like 14d or 36h.");

    await type(lookback, "30d");
    await confirm(box);
    expect(asked).toEqual([{ lookback: "30d" }]);
  });

  test("is disabled while a run is in flight, with its start time in the tooltip", async () => {
    const { read } = reader();
    const { run } = runner(STARTED);
    const since = "2026-09-18T11:30:00.000Z";
    const { box } = await mount(tab(read, { targets: [{ ...TARGET, runningSince: since }], run }));

    expect(button(box)!.disabled).toBe(true);
    expect(button(box)!.title).toBe(
      `An observer run has been in flight since ${new Date(since).toLocaleString()}.`,
    );
  });

  test("with two tenants, each has its own button and the ask names it", async () => {
    const { read } = reader();
    const { run, asked } = runner(STARTED);
    const other = { ...TARGET, label: "acme/widget", tenant: "acme/widget" };
    const { box } = await mount(tab(read, { targets: [TARGET, other], run }));

    await click(button(box, "Run observer: acme/widget")!);
    await confirm(box);
    expect(asked).toEqual([{ tenant: "acme/widget", lookback: "14d" }]);
  });
});

describe("what came back", () => {
  test("a refusal says the bootstrapper's reason", async () => {
    const { read } = reader();
    const { run } = runner({
      kind: "answer",
      answer: { outcome: "refused", detail: "the fleet is stopped (by device:phone at 10:00)." },
    });
    const { box } = await mount(tab(read, { targets: [TARGET], run }));

    await click(button(box)!);
    await confirm(box);
    expect(box.querySelector(".refusal")?.textContent).toBe(
      "The observer run was refused: the fleet is stopped (by device:phone at 10:00).",
    );
    expect(button(box)!.disabled).toBe(false);
  });

  test("a deployment that answers 404 is too old to run the observer", async () => {
    const { read } = reader();
    const { run } = runner({ kind: "too-old" });
    const { box } = await mount(tab(read, { targets: [TARGET], run }));

    await click(button(box)!);
    await confirm(box);
    expect(box.textContent).toContain("too old to run the observer");
  });

  test("an ask that could not reach the deployment says why", async () => {
    const { read } = reader();
    const { run } = runner(new Error("this session can only read"));
    const { box } = await mount(tab(read, { targets: [TARGET], run }));

    await click(button(box)!);
    await confirm(box);
    expect(box.textContent).toContain(
      "Could not ask for an observer run: this session can only read",
    );
  });

  test("the tab asks for its page again when the run in flight settles", async () => {
    const { read, asked } = reader();
    const { run } = runner(STARTED);
    const busy = { ...TARGET, runningSince: "2026-09-18T11:30:00.000Z" };
    const { root } = await mount(tab(read, { targets: [busy], run }));
    expect(asked).toHaveLength(1);

    await act(async () => root.render(tab(read, { targets: [TARGET], run })));
    expect(asked).toHaveLength(2);
  });
});

describe("the drawer", () => {
  test("links each #N in a unit's summary to the tenant's repo", async () => {
    const observed = historyRecord({
      unit: { kind: "observer", id: "observer" },
      detail: "Filed #12 and added evidence to #7.",
    });
    const read: HistoryReader = () =>
      Promise.resolve({ kind: "page", page: historyPage([observed]) });
    const { box } = await mount(tab(read));

    await click(box.querySelector<HTMLElement>("tr.history-row")!);
    const links = [...box.querySelectorAll<HTMLAnchorElement>(".unit-detail a")];
    expect(links.map((link) => [link.textContent, link.href])).toEqual([
      ["#12", "https://github.com/JesusFilm/youtube-studio/issues/12"],
      ["#7", "https://github.com/JesusFilm/youtube-studio/issues/7"],
    ]);
    expect(box.querySelector(".unit-detail")?.textContent).toBe(
      "Filed #12 and added evidence to #7.",
    );
  });
});

describe("the deployment's History tab", () => {
  test("shows the button for a deployment whose report declares the observer", async () => {
    const declared = effectiveConfig({
      tenant: "JesusFilm/youtube-studio",
      fields: {
        pipelines: {
          observe: {
            concurrency: { value: 1, source: "default", reader: "engine" },
            kinds: {
              observer: { runBudgetMs: { value: null, source: "default", reader: "engine" } },
            },
          },
        },
      },
    });
    const { read } = reader();
    const { run } = runner(STARTED);
    const { box } = await mount(
      <DeploymentTabPanel
        tab="history"
        reading={{
          kind: "read",
          receivedAt: ago(2),
          report: report({ config: configReport({ tenants: [declared] }) }),
        }}
        connection={{ arm: "local install", detail: "/repos/youtube-studio", note: "read here" }}
        config={null}
        now={NOW}
        empty={<p>nothing</p>}
        history={{ reader: read, scope: "/repos/youtube-studio", observe: run }}
      />,
    );
    expect(button(box)).toBeDefined();
  });
});
