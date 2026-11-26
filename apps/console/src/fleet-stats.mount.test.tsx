// @vitest-environment jsdom
// The stats button and the fleet stats page (#933): the button beside the
// gear, the card that opens only after a 500 ms hover and survives the pointer
// crossing onto it, the click that opens the page, a deployment too old to
// report history listed as such, and the most expensive units opening the
// drawer.

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HistoryQuery, HistoryWindow } from "phoebe-agent/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { App } from "./app.tsx";
import { FleetStatsPage, HOVER_CLOSE_MS, HOVER_OPEN_MS, StatsButton } from "./fleet-stats-page.tsx";
import type { StatsArm, StatsDeployment } from "./fleet-stats.ts";
import type { HistoryFetch, HistoryReader } from "./history.ts";
import { Rail } from "./rail.tsx";
import { STATS_HREF } from "./route.ts";
import {
  agentRun,
  ago,
  bridge,
  historyPage,
  historyRecord,
  install,
  localReport,
  NOW,
  report,
  stored,
} from "./test-fixture.ts";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
  vi.useRealTimers();
  window.location.hash = "";
});

async function mount(element: ReactElement): Promise<HTMLElement> {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(element));
  return box;
}

function window7(overrides: Partial<HistoryWindow> = {}): HistoryWindow {
  return {
    units: 12,
    outcomes: { completed: 9, unproductive: 0, failed: 2, "timed-out": 1, abandoned: 0 },
    quarantined: 0,
    costUsd: { api: 4.2, subscriptionEstimate: 9.75 },
    unitsWithoutCost: 1,
    unitsWithPartialUsage: 0,
    tokens: { input: 120_000, output: 30_000, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

const REPORTING: StatsDeployment = {
  key: "local:/repos/youtube-studio",
  name: "youtube-studio",
  where: "this machine",
  arm: { kind: "local", dir: "/repos/youtube-studio" },
  history: {
    kind: "summary",
    windows: {
      last24h: window7({ units: 3, costUsd: { api: 1, subscriptionEstimate: 2 } }),
      last7d: window7(),
    },
    asOf: ago(60),
  },
};

const TOO_OLD: StatsDeployment = {
  key: "remote:dep_P",
  name: "partner-site",
  where: "partner-site.tail4f2c.ts.net",
  arm: { kind: "remote", deploymentId: "dep_P" },
  history: { kind: "too-old" },
};

function pointer(target: Element, type: "mouseover" | "mouseout", related: Element | null): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: related }));
}

describe("the stats button", () => {
  test("sits beside the gear in the rail's foot, in the gear's box", async () => {
    const box = await mount(
      <Rail surface="companion" installs={[]} stats={[REPORTING]} onStats={() => undefined} />,
    );
    const foot = box.querySelector(".rail-foot")!;
    const [gear, stats] = [...foot.children];
    expect(gear!.getAttribute("aria-label")).toBe("Settings");
    expect(stats!.getAttribute("aria-label")).toBe("Stats");
    expect(stats!.className).toBe("rail-settings rail-stats");
    expect(stats!.querySelector("svg")!.getAttribute("class")).toContain(
      "lucide-chart-no-axes-column",
    );
    expect(stats!.querySelector("svg")!.getAttribute("width")).toBe("16");
  });

  test("is not there without a way to open the page", async () => {
    const box = await mount(<Rail surface="browser" />);
    expect(box.querySelector('[aria-label="Stats"]')).toBeNull();
  });

  test("opens the card only after a 500 ms hover, and keeps it while the pointer moves onto it", async () => {
    vi.useFakeTimers();
    const box = await mount(
      <StatsButton deployments={[REPORTING, TOO_OLD]} onOpen={() => undefined} />,
    );
    const button = box.querySelector('[aria-label="Stats"]')!;
    const card = (): Element | null => box.querySelector(".stats-card");

    act(() => pointer(button, "mouseover", null));
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_MS - 1);
    });
    expect(card()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(card()).not.toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // Off the button and onto the card, inside the close delay.
    act(() => pointer(button, "mouseout", null));
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_MS - 50);
    });
    act(() => pointer(card()!, "mouseover", null));
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_MS * 3);
    });
    expect(card()).not.toBeNull();

    // Off the card: gone 300 ms later, not before.
    act(() => pointer(card()!, "mouseout", null));
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_MS - 1);
    });
    expect(card()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(card()).toBeNull();
  });

  test("a pointer that passes over without resting opens nothing", async () => {
    vi.useFakeTimers();
    const box = await mount(<StatsButton deployments={[REPORTING]} onOpen={() => undefined} />);
    const button = box.querySelector('[aria-label="Stats"]')!;
    act(() => pointer(button, "mouseover", null));
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_MS - 100);
    });
    act(() => pointer(button, "mouseout", null));
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_MS * 2);
    });
    expect(box.querySelector(".stats-card")).toBeNull();
  });

  test("the card's totals keep API spend and the estimate apart and list a too-old deployment as such", async () => {
    vi.useFakeTimers();
    const box = await mount(
      <StatsButton deployments={[REPORTING, TOO_OLD]} onOpen={() => undefined} />,
    );
    act(() => pointer(box.querySelector('[aria-label="Stats"]')!, "mouseover", null));
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_MS);
    });
    const text = box.querySelector(".stats-card")!.textContent!;
    expect(text).toContain("$4.20API spend");
    expect(text).toContain("$9.75 est.Subscription estimate");
    expect(text).not.toContain("$13.95");
    expect(text).toContain("12Units");
    expect(text).toContain("3Did not complete");
    expect(text).toContain("partner-site");
    expect(text).toContain("too old to report history, so not counted");

    await act(async () => {
      (box.querySelector('button[aria-pressed="false"]') as HTMLButtonElement).click();
    });
    expect(box.querySelector(".stats-card")!.textContent).toContain("$1.00API spend");
  });

  test("a click opens the page and closes the card", async () => {
    vi.useFakeTimers();
    let opened = 0;
    const box = await mount(<StatsButton deployments={[REPORTING]} onOpen={() => (opened += 1)} />);
    const button = box.querySelector<HTMLButtonElement>('[aria-label="Stats"]')!;
    act(() => pointer(button, "mouseover", null));
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_MS);
    });
    act(() => button.click());
    expect(opened).toBe(1);
    expect(box.querySelector(".stats-card")).toBeNull();
  });
});

/** A reader per deployment, by key, each remembering what it was asked. */
function readers(answers: Record<string, HistoryFetch | Error>): {
  readerOf: (arm: StatsArm) => HistoryReader | null;
  asked: { arm: string; query: HistoryQuery }[];
} {
  const asked: { arm: string; query: HistoryQuery }[] = [];
  return {
    asked,
    readerOf: (arm) => {
      const key = arm.kind === "local" ? `local:${arm.dir}` : `remote:${arm.deploymentId}`;
      return (query) => {
        asked.push({ arm: key, query });
        const answer = answers[key];
        if (answer === undefined) return Promise.reject(new Error(`nothing for ${key}`));
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      };
    },
  };
}

const PRICEY = historyRecord({
  unit: { kind: "issues", id: "issue:501" },
  agentRuns: [agentRun({ costUsd: 3.1 })],
});
const CHEAP = historyRecord({
  unit: { kind: "issues", id: "issue:502" },
  agentRuns: [agentRun({ costUsd: 0.2 })],
});
const ESTIMATED = historyRecord({
  unit: { kind: "reviews", id: "pr:77" },
  model: "claude-sonnet-5-5",
  agentRuns: [agentRun({ costUsd: 1.4, costBasis: "subscription-estimate" })],
});

describe("the fleet stats page", () => {
  test("tiles from the summaries, a too-old deployment listed and not counted, records read on demand", async () => {
    const { readerOf, asked } = readers({
      [REPORTING.key]: { kind: "page", page: historyPage([CHEAP, ESTIMATED, PRICEY]) },
    });
    const box = await mount(
      <FleetStatsPage deployments={[REPORTING, TOO_OLD]} readerOf={readerOf} now={NOW} />,
    );
    const tiles = box.querySelector(".stats-tiles")!.textContent!;
    expect(tiles).toContain("API spend$4.20");
    expect(tiles).toContain("Subscription estimate$9.75 est.");
    expect(tiles).not.toContain("$13.95");
    expect(tiles).toContain("Units12");
    expect(tiles).toContain("Did not complete3");
    expect(box.textContent).toContain("1 deployment is left out rather than counted as zero");

    const rows = [...box.querySelectorAll(".stats-deployments tbody tr")].map(
      (row) => row.textContent,
    );
    expect(rows[1]).toContain("partner-site");
    expect(rows[1]).toContain("too old to report history, so not counted");

    // Only the deployment that reports history is asked, from the window's start.
    expect(asked).toEqual([{ arm: REPORTING.key, query: { since: ago(7 * 86_400), limit: 200 } }]);
    expect(box.textContent).toContain("Units per day");

    const top = [...box.querySelectorAll("h2")].find(
      (h) => h.textContent === "Most expensive units",
    )!;
    const ranked = [...top.nextElementSibling!.querySelectorAll("tbody tr")].map(
      (row) => row.textContent,
    );
    expect(ranked[0]).toContain("issue #501");
    expect(ranked[1]).toContain("PR #77");
    expect(ranked[2]).toContain("issue #502");

    const models = [...box.querySelectorAll("h2")].find((h) => h.textContent === "By model")!;
    expect(models.nextElementSibling!.textContent).toContain("claude-sonnet-5-5");
  });

  test("a most expensive unit opens the drawer", async () => {
    const { readerOf } = readers({
      [REPORTING.key]: { kind: "page", page: historyPage([PRICEY]) },
    });
    const box = await mount(
      <FleetStatsPage deployments={[REPORTING]} readerOf={readerOf} now={NOW} />,
    );
    const row = box.querySelector<HTMLElement>(".history-row")!;
    await act(async () => row.click());
    const drawer = box.querySelector(".unit-drawer")!;
    expect(drawer.getAttribute("aria-label")).toBe("issues issue #501");
    expect(drawer.textContent).toContain("$3.10");
  });

  test("the 24 hour window reads again from its own start and has no per-day chart", async () => {
    const { readerOf, asked } = readers({
      [REPORTING.key]: { kind: "page", page: historyPage([CHEAP]) },
    });
    const box = await mount(
      <FleetStatsPage deployments={[REPORTING]} readerOf={readerOf} now={NOW} />,
    );
    const day = [...box.querySelectorAll("button")].find((b) => b.textContent === "Last 24 hours")!;
    await act(async () => day.click());
    expect(asked.at(-1)!.query).toEqual({ since: ago(86_400), limit: 200 });
    expect(box.textContent).not.toContain("Units per day");
    expect(box.querySelector(".stats-tiles")!.textContent).toContain("Units3");
  });

  test("a deployment whose records cannot be read says so", async () => {
    const { readerOf } = readers({ [REPORTING.key]: new Error("the container is not running") });
    const box = await mount(
      <FleetStatsPage deployments={[REPORTING]} readerOf={readerOf} now={NOW} />,
    );
    expect(box.textContent).toContain(
      "Could not read youtube-studio's units: the container is not running.",
    );
  });
});

describe("in the companion", () => {
  beforeEach(() => {
    // jsdom has no media queries; the app asks one for the system's dark mode.
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });

  test("the button opens the page, and choosing an install on the rail leaves it", async () => {
    const studio = install();
    const box = await mount(
      <App
        surface="companion"
        bridge={bridge({
          installs: [studio],
          reports: [
            localReport({
              facts: studio,
              report: stored(
                report({
                  fleet: {
                    ...report().fleet,
                    history: { asOf: ago(60), last24h: window7(), last7d: window7() },
                  },
                }),
              ),
            }),
          ],
          history: [historyPage([PRICEY])],
        })}
      />,
    );
    await act(async () => {
      box.querySelector<HTMLButtonElement>('[aria-label="Stats"]')!.click();
    });
    expect(window.location.hash).toBe(STATS_HREF);
    await act(async () => undefined);
    expect(box.querySelector(".fleet-stats")).not.toBeNull();
    expect(box.querySelector(".fleet-stats")!.textContent).toContain("youtube-studio");

    const entry = [...box.querySelectorAll<HTMLElement>(".rail button, .rail a")].find(
      (candidate) => candidate.textContent?.includes("youtube-studio"),
    )!;
    await act(async () => entry.click());
    expect(box.querySelector(".fleet-stats")).toBeNull();

    // And the button brings it back, though the hash never moved.
    await act(async () => {
      box.querySelector<HTMLButtonElement>('[aria-label="Stats"]')!.click();
    });
    expect(box.querySelector(".fleet-stats")).not.toBeNull();
  });
});
