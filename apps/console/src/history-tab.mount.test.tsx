// @vitest-environment jsdom
// The History tab with a reader behind it (#931): the list newest first as the
// page holds it, each filter sent as a query rather than applied to the page,
// a row opening the drawer, each kind of cost with its line, "show more", a
// deployment too old to serve history, and an export that walks every page
// under the active filters (#992).

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HistoryQuery, HistoryRecord } from "phoebe-agent/contracts";
import { historyExportHead, historyExportLines } from "phoebe-agent/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { HistoryTab } from "./history-tab.tsx";
import {
  API_COST_NOTE,
  ESTIMATE_NOTE,
  type ExportFile,
  type HistoryFetch,
  type HistoryReader,
} from "./history.ts";
import { agentRun, cell, historyPage, historyRecord, NOW } from "./test-fixture.ts";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
});

async function mount(element: ReactElement): Promise<HTMLElement> {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(element));
  return box;
}

/** A reader that answers each ask with the next fetch, and remembers what it was asked. */
function reader(...answers: (HistoryFetch | Error)[]): {
  read: HistoryReader;
  asked: HistoryQuery[];
} {
  const asked: HistoryQuery[] = [];
  return {
    asked,
    read: (query) => {
      asked.push(query);
      const answer = answers[Math.min(asked.length, answers.length) - 1]!;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

const CELLS = [cell(), cell({ id: "/etc/phoebe#review", pipeline: "review" })];

const NEWER = historyRecord({ unit: { kind: "issues", id: "issue:90" } });
const OLDER = historyRecord({
  unit: { kind: "reviews", id: "pr:21" },
  pipeline: "review",
  cell: "/etc/phoebe#review",
  outcome: "timed-out",
  provider: "codex",
  model: "gpt-5",
  startedAt: "2026-09-17T08:00:00.000Z",
  agentRuns: [agentRun({ costUsd: null, costBasis: null, usageComplete: false })],
});
const ESTIMATED = historyRecord({
  unit: { kind: "issues", id: "issue:77" },
  agentRuns: [agentRun({ costUsd: 1.5, costBasis: "subscription-estimate" })],
});

function tab(read: HistoryReader): ReactElement {
  return <HistoryTab reader={read} scope="/repos/youtube-studio" cells={CELLS} now={NOW} />;
}

async function choose(box: HTMLElement, label: string, value: string): Promise<void> {
  const select = box.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function rows(box: HTMLElement): string[] {
  return [...box.querySelectorAll("tr.history-row")].map((row) => row.textContent ?? "");
}

describe("the list", () => {
  test("draws the page as it came, newest first, with no filter in the first ask", async () => {
    const { read, asked } = reader({ kind: "page", page: historyPage([NEWER, OLDER]) });
    const box = await mount(tab(read));

    expect(asked).toEqual([{}]);
    const drawn = rows(box);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toContain("issue #90");
    expect(drawn[1]).toContain("PR #21");
    expect(box.textContent).toContain("holds units back to");
  });

  test("each filter asks again with it in the query, not over the page it holds", async () => {
    const { read, asked } = reader(
      { kind: "page", page: historyPage([NEWER, OLDER]) },
      { kind: "page", page: historyPage([OLDER]) },
    );
    const box = await mount(tab(read));

    await choose(box, "Pipeline", "/etc/phoebe#review");
    await choose(box, "Work kind", "reviews");
    await choose(box, "Outcome", "timed-out");
    await choose(box, "Model", "gpt-5");

    expect(asked).toEqual([
      {},
      { cell: "/etc/phoebe#review" },
      { cell: "/etc/phoebe#review", kind: "reviews" },
      { cell: "/etc/phoebe#review", kind: "reviews", outcome: "timed-out" },
      { cell: "/etc/phoebe#review", kind: "reviews", outcome: "timed-out", model: "gpt-5" },
    ]);
    expect(rows(box)).toHaveLength(1);

    await choose(box, "Model", "");
    expect(asked.at(-1)).toEqual({
      cell: "/etc/phoebe#review",
      kind: "reviews",
      outcome: "timed-out",
    });
  });

  test("show more asks for the page after the cursor and adds it under the first", async () => {
    const { read, asked } = reader(
      { kind: "page", page: historyPage([NEWER, OLDER]) },
      { kind: "page", page: historyPage([NEWER], { nextBefore: "cursor-1" }) },
      { kind: "page", page: historyPage([OLDER]) },
    );
    const box = await mount(tab(read));
    await choose(box, "Outcome", "failed");

    const more = [...box.querySelectorAll("button")].find((b) => b.textContent === "Show more")!;
    await act(async () => more.click());

    expect(asked.at(-1)).toEqual({ outcome: "failed", before: "cursor-1" });
    expect(rows(box)).toHaveLength(2);
    expect(box.textContent).not.toContain("Show more");
  });

  test("an empty history says so rather than drawing an empty table", async () => {
    const { read } = reader({ kind: "page", page: historyPage([], { retained: {} }) });
    const box = await mount(tab(read));

    expect(box.querySelector("table")).toBeNull();
    expect(box.textContent).toContain("No units recorded yet.");
  });

  test("a read that fails says why and can be tried again", async () => {
    const { read, asked } = reader(new Error("the container is not running"), {
      kind: "page",
      page: historyPage([NEWER]),
    });
    const box = await mount(tab(read));
    expect(box.textContent).toContain("Could not read history: the container is not running");

    const retry = [...box.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => retry.click());
    expect(asked).toHaveLength(2);
    expect(rows(box)).toHaveLength(1);
  });
});

describe("too old", () => {
  test("a deployment that predates history says so, with no table and no filters", async () => {
    const { read } = reader({ kind: "too-old" });
    const box = await mount(tab(read));

    expect(box.textContent).toContain("too old to keep unit history");
    expect(box.querySelector("table")).toBeNull();
    expect(box.querySelector("select")).toBeNull();
  });
});

describe("cost", () => {
  test("API spend in dollars, an estimate with a muted est., none as a dash — each with its line", async () => {
    const { read } = reader({ kind: "page", page: historyPage([NEWER, ESTIMATED, OLDER]) });
    const box = await mount(tab(read));
    const cost = (row: number): HTMLElement =>
      box.querySelectorAll("tr.history-row")[row]!.querySelectorAll<HTMLElement>("td")[6]!;

    expect(cost(0).textContent).toBe("$0.42");
    expect(cost(0).querySelector("span")!.title).toBe(API_COST_NOTE);

    expect(cost(1).textContent).toBe("$1.50 est.");
    expect(cost(1).querySelector(".est")).not.toBeNull();
    expect(cost(1).querySelector("span")!.title).toBe(ESTIMATE_NOTE);

    expect(cost(2).textContent).toBe("—");
    expect(cost(2).querySelector(".cost-none")!.getAttribute("title")).toBe(
      "codex reports tokens but no cost.",
    );
  });
});

describe("the drawer", () => {
  test("a row opens the unit's facts, its runs and its GitHub link; Escape closes it", async () => {
    const { read } = reader({ kind: "page", page: historyPage([NEWER, OLDER]) });
    const box = await mount(tab(read));

    const row = box.querySelectorAll<HTMLElement>("tr.history-row")[1]!;
    await act(async () => row.click());

    const drawer = box.querySelector<HTMLElement>("aside.unit-drawer")!;
    expect(drawer.getAttribute("aria-label")).toBe("reviews PR #21");
    expect(drawer.textContent).toContain("timed-out");
    expect(drawer.textContent).toContain("codex");
    expect(drawer.textContent).toContain("gpt-5");
    expect(drawer.textContent).toContain("high");
    expect(drawer.textContent).toContain("10 min");
    expect(drawer.textContent).toContain("12.3k in");
    const link = drawer.querySelector<HTMLAnchorElement>("a")!;
    expect(link.href).toBe("https://github.com/JesusFilm/youtube-studio/pull/21");
    expect(link.target).toBe("_blank");

    const runs = drawer.querySelectorAll("table tbody tr");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.textContent).toContain("partial");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(box.querySelector("aside.unit-drawer")).toBeNull();
  });
});

describe("export", () => {
  test("walks every page under the active filters, shows progress, then saves the file and its count", async () => {
    // The tab's own pages come back at once; each export page waits to be let go.
    const asked: HistoryQuery[] = [];
    const held: Array<(fetch: HistoryFetch) => void> = [];
    const drawn: HistoryFetch = {
      kind: "page",
      page: historyPage([NEWER], { nextBefore: "drawn-1" }),
    };
    const read: HistoryReader = (query) => {
      asked.push(query);
      if (query.limit === undefined) return Promise.resolve(drawn);
      return new Promise((resolve) => held.push(resolve));
    };
    const saved: ExportFile[] = [];
    const box = await mount(
      <HistoryTab
        reader={read}
        scope="/repos/youtube-studio"
        cells={CELLS}
        now={NOW}
        save={(file) => saved.push(file)}
      />,
    );
    await choose(box, "Pipeline", "/etc/phoebe#work");
    await choose(box, "Work kind", "issues");

    const exportButton = [...box.querySelectorAll("button")].find(
      (b) => b.textContent === "Export",
    )!;
    await act(async () => exportButton.click());
    expect(asked.at(-1)).toEqual({ cell: "/etc/phoebe#work", kind: "issues", limit: 200 });
    expect(exportButton.disabled).toBe(true);

    const total = (records: HistoryRecord[], nextBefore: string | null): HistoryFetch => {
      const page = historyPage(records, { nextBefore });
      return { kind: "page", page: { ...page, summary: { ...page.summary, units: 3 } } };
    };
    await act(async () => held.shift()!(total([NEWER], "export-1")));
    expect(box.textContent).toContain("Exporting… 1 of 3 units");
    expect(asked.at(-1)).toEqual({
      cell: "/etc/phoebe#work",
      kind: "issues",
      before: "export-1",
      limit: 200,
    });

    await act(async () => held.shift()!(total([ESTIMATED, OLDER], null)));
    expect(held).toHaveLength(0);
    expect(saved).toHaveLength(1);
    const file = saved[0]!;
    expect(file.name).toBe(`phoebe-history-${NOW.toISOString().slice(0, 10)}.csv`);
    expect(file.type).toBe("text/csv");
    expect(file.text).toBe(
      historyExportHead("csv") + historyExportLines("csv", [NEWER, ESTIMATED, OLDER]),
    );
    expect(box.textContent).toContain("Saved 3 units as CSV.");
    expect(exportButton.disabled).toBe(false);
    // The drawn list is the tab's own: the export added nothing to it.
    expect(rows(box)).toHaveLength(1);
  });

  test("JSON Lines saves one record per line", async () => {
    const { read } = reader({ kind: "page", page: historyPage([NEWER, OLDER]) });
    const saved: ExportFile[] = [];
    const box = await mount(
      <HistoryTab
        reader={read}
        scope="/repos/youtube-studio"
        cells={CELLS}
        now={NOW}
        save={(file) => saved.push(file)}
      />,
    );
    await choose(box, "Export format", "jsonl");
    const exportButton = [...box.querySelectorAll("button")].find(
      (b) => b.textContent === "Export",
    )!;
    await act(async () => exportButton.click());

    expect(saved[0]!.name).toMatch(/\.jsonl$/);
    expect(
      saved[0]!.text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([NEWER, OLDER]);
    expect(box.textContent).toContain("Saved 2 units as JSON Lines.");
  });

  test("a page that fails mid-export saves nothing and says why", async () => {
    const { read } = reader(
      { kind: "page", page: historyPage([NEWER]) },
      { kind: "page", page: historyPage([NEWER], { nextBefore: "export-1" }) },
      new Error("the container stopped"),
    );
    const saved: ExportFile[] = [];
    const box = await mount(
      <HistoryTab
        reader={read}
        scope="/repos/youtube-studio"
        cells={CELLS}
        now={NOW}
        save={(file) => saved.push(file)}
      />,
    );
    const exportButton = [...box.querySelectorAll("button")].find(
      (b) => b.textContent === "Export",
    )!;
    await act(async () => exportButton.click());

    expect(saved).toEqual([]);
    expect(box.textContent).toContain("Could not export: the container stopped");
  });
});
