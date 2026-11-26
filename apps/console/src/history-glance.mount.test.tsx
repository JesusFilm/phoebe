// @vitest-environment jsdom
// History on the overview and pipelines tabs (#932): the 7-day card drawn off
// the report's summary with no records read for it, the "Needs a look" feed
// with its drawer and its link to the History tab, and each pipeline's
// breakdown behind an expansion, the first one open.

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DeploymentReport, HistoryQuery, HistoryRecord } from "phoebe-agent/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { DeploymentTabPanel } from "./deployment-tabs.tsx";
import type { HistoryReader } from "./history.ts";
import type { DeploymentTab } from "./tabs.ts";
import {
  ago,
  agentRun,
  cell,
  historyPage,
  historyRecord,
  historySummary,
  NOW,
  report,
  tenant,
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

async function mount(element: ReactElement): Promise<HTMLElement> {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(element));
  return box;
}

/** A reader that answers each outcome with its records, and remembers what it was asked. */
function reader(byOutcome: Partial<Record<string, HistoryRecord[]>> = {}): {
  read: HistoryReader;
  asked: HistoryQuery[];
} {
  const asked: HistoryQuery[] = [];
  return {
    asked,
    read: (query) => {
      asked.push(query);
      return Promise.resolve({
        kind: "page",
        page: historyPage(byOutcome[query.outcome ?? ""] ?? []),
      });
    },
  };
}

const WORK = cell({ history: historySummary() });
const REVIEW = cell({
  id: "/etc/phoebe#review",
  pipeline: "review",
  history: historySummary({
    last7d: { costUsd: { api: 0, subscriptionEstimate: 0 }, unitsWithoutCost: 10 },
  }),
});

function withHistory(overrides: Partial<DeploymentReport["fleet"]> = {}): DeploymentReport {
  return report({
    fleet: {
      tenants: [tenant()],
      cells: [WORK, REVIEW],
      history: historySummary({
        last7d: {
          units: 21,
          outcomes: { completed: 17, failed: 2, "timed-out": 1, abandoned: 1 },
          costUsd: { api: 4.2, subscriptionEstimate: 12.5 },
          unitsWithoutCost: 3,
        },
      }),
      updatedAt: ago(12),
      ...overrides,
    },
  });
}

function panel(
  tab: DeploymentTab,
  body: DeploymentReport,
  read?: HistoryReader,
  onTab?: (tab: DeploymentTab) => void,
): ReactElement {
  return (
    <DeploymentTabPanel
      tab={tab}
      reading={{ kind: "read", receivedAt: ago(2), report: body }}
      connection={{ arm: "local install", detail: "/repos/youtube-studio", note: "read here" }}
      config={null}
      now={NOW}
      empty={<p>nothing</p>}
      {...(read === undefined ? {} : { history: { reader: read, scope: "/repos/youtube-studio" } })}
      {...(onTab === undefined ? {} : { onTab })}
    />
  );
}

describe("the overview's 7-day card", () => {
  test("reads the report's summary, and asks for no records to draw it", async () => {
    const { read, asked } = reader();
    const box = await mount(panel("overview", withHistory(), read));

    const card = box.querySelector(".week-card")!;
    expect(card.textContent).toContain("21units · 3 a day");
    expect(card.textContent).toContain("$4.20");
    expect(card.textContent).toContain("$12.50 est.");
    expect(card.textContent).toContain("3 with no cost reported");
    expect(card.textContent).toContain("4did not complete · 2 failed, 1 timed out, 1 abandoned");
    // The only reads are the feed's, one per outcome that did not complete.
    expect(asked.map((query) => query.outcome)).toEqual(["failed", "timed-out", "abandoned"]);
  });

  test("draws without a reader at all, since the summary is in the report", async () => {
    const box = await mount(panel("overview", withHistory()));
    expect(box.querySelector(".week-card")?.textContent).toContain("21");
    expect(box.querySelector(".needs-a-look")).toBeNull();
  });

  test("a report with no summary says so, and asks for nothing", async () => {
    const { read, asked } = reader();
    const box = await mount(panel("overview", report(), read));
    expect(box.querySelector(".week-card")?.textContent).toContain(
      "This report carries no unit history",
    );
    expect(asked).toEqual([]);
  });

  test("units that reported no cost read as tokens only", async () => {
    const box = await mount(
      panel(
        "overview",
        withHistory({
          history: historySummary({
            last7d: { costUsd: { api: 0, subscriptionEstimate: 0 }, unitsWithoutCost: 10 },
          }),
        }),
      ),
    );
    expect(box.querySelector(".week-card")?.textContent).toContain("tokens only");
  });
});

describe("needs a look", () => {
  const at = (hours: number) => ago(hours * 3600);
  const failed = [1, 3, 5, 7, 9].map((h) =>
    historyRecord({
      outcome: "failed",
      detail: `failed ${h}h ago`,
      startedAt: at(h),
      unit: { kind: "issues", id: `issue:${h}` },
    }),
  );
  const timedOut = [2, 4].map((h) =>
    historyRecord({
      outcome: "timed-out",
      startedAt: at(h),
      unit: { kind: "issues", id: `issue:${h}` },
      agentRuns: [agentRun({ usageComplete: false })],
    }),
  );

  test("lists at most six units from the last 7 days, newest first", async () => {
    const { read, asked } = reader({ failed, "timed-out": timedOut });
    const box = await mount(panel("overview", withHistory(), read));

    const since = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
    expect(asked).toEqual([
      { outcome: "failed", since, limit: 6 },
      { outcome: "timed-out", since, limit: 6 },
      { outcome: "abandoned", since, limit: 6 },
    ]);
    const rows = [...box.querySelectorAll(".needs-a-look tr.history-row")];
    expect(rows.map((row) => row.querySelector("td:nth-child(3)")?.textContent)).toEqual([
      "issues issue #1",
      "issues issue #2",
      "issues issue #3",
      "issues issue #4",
      "issues issue #5",
      "issues issue #7",
    ]);
    expect(box.querySelector(".needs-a-look")?.textContent).toContain("failed 1h ago");
  });

  test("a unit opens the drawer", async () => {
    const { read } = reader({ failed });
    const box = await mount(panel("overview", withHistory(), read));

    const row = box.querySelector<HTMLElement>(".needs-a-look tr.history-row")!;
    await act(async () => row.click());

    const drawer = document.querySelector('[role="dialog"]')!;
    expect(drawer.getAttribute("aria-label")).toBe("issues issue #1");
    expect(drawer.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/JesusFilm/youtube-studio/issues/1",
    );
  });

  test("the link opens the History tab, and counts the units the feed left out", async () => {
    const { read } = reader({ failed, "timed-out": timedOut });
    const opened: DeploymentTab[] = [];
    const box = await mount(panel("overview", withHistory(), read, (tab) => opened.push(tab)));

    const link = [...box.querySelectorAll<HTMLButtonElement>(".needs-a-look button")].find(
      (button) => button.textContent?.includes("History tab"),
    )!;
    expect(link.textContent).toBe("1 more, and every unit, in the History tab →");
    await act(async () => link.click());
    expect(opened).toEqual(["history"]);
  });

  test("with none, it says every unit this week completed", async () => {
    const { read } = reader();
    const box = await mount(panel("overview", withHistory(), read, () => undefined));
    const feed = box.querySelector(".needs-a-look")!;
    expect(feed.textContent).toContain("Every unit this week completed.");
    expect(feed.textContent).toContain("Every unit in the History tab →");
  });

  test("a deployment too old to list units says so", async () => {
    const read: HistoryReader = () => Promise.resolve({ kind: "too-old" });
    const box = await mount(panel("overview", withHistory(), read));
    expect(box.querySelector(".needs-a-look")?.textContent).toContain("too old to list its units");
  });

  test("a read that fails says why and offers another try", async () => {
    let calls = 0;
    const read: HistoryReader = () => {
      calls += 1;
      return calls <= 3
        ? Promise.reject(new Error("compose exec failed"))
        : Promise.resolve({ kind: "page", page: historyPage([]) });
    };
    const box = await mount(panel("overview", withHistory(), read));
    expect(box.querySelector(".needs-a-look")?.textContent).toContain(
      "Could not read the units: compose exec failed",
    );

    const again = [...box.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => again.click());
    expect(box.querySelector(".needs-a-look")?.textContent).toContain(
      "Every unit this week completed.",
    );
  });
});

describe("the pipelines tab", () => {
  function expanders(box: HTMLElement): HTMLButtonElement[] {
    return [...box.querySelectorAll<HTMLButtonElement>("button.expander")];
  }

  test("every row has a breakdown behind an expansion, and the first arrives open", async () => {
    const box = await mount(panel("pipelines", withHistory()));

    const [work, review] = expanders(box);
    expect(work?.getAttribute("aria-expanded")).toBe("true");
    expect(review?.getAttribute("aria-expanded")).toBe("false");
    expect(box.querySelectorAll(".pipeline-breakdown")).toHaveLength(1);
    expect(box.querySelector(".pipeline-breakdown")?.textContent).toContain("Last 24 hours");

    await act(async () => review!.click());
    expect(box.querySelectorAll(".pipeline-breakdown")).toHaveLength(2);
    await act(async () => work!.click());
    expect(box.querySelectorAll(".pipeline-breakdown")).toHaveLength(1);
    expect(expanders(box)[0]?.getAttribute("aria-expanded")).toBe("false");
  });

  test("each row reads its own 7 days, and a pipeline with no cost reads tokens only", async () => {
    const box = await mount(panel("pipelines", withHistory()));

    const rows = [...box.querySelectorAll("tbody > tr:not(.breakdown-row)")].filter((row) =>
      row.querySelector("button.expander"),
    );
    const cells = (row: Element) =>
      [...row.querySelectorAll(":scope > td")].map((td) => td.textContent);
    expect(cells(rows[0]!).slice(-3)).toEqual(["10", "1", "$4.20"]);
    expect(cells(rows[1]!).slice(-3)).toEqual(["10", "1", "tokens only"]);
  });

  test("a report from before the summary shows dashes and says why when opened", async () => {
    const box = await mount(panel("pipelines", report()));
    expect(box.querySelector(".breakdown-row")?.textContent).toContain(
      "This report carries no unit history for this pipeline.",
    );
  });
});
