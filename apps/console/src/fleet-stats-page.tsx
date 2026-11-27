// The rail's stats button and the fleet stats page it opens (#933). Variant D
// of the #919 prototype: a chart icon beside the settings gear that shows
// totals across every deployment on a timed hover, and a page in the main pane
// on click.
//
// What is added up and how is fleet-stats.ts. This file draws it.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChartNoAxesColumn } from "lucide-react";
import type { HistoryRecord, HistoryWindow } from "phoebe-agent/contracts";
import { age } from "./facts.ts";
import {
  byModel,
  didNotComplete,
  fleetTotals,
  leftOutNote,
  priciest,
  RANGE_MS,
  readWindow,
  RECORD_CAP,
  unitsPerDay,
  type StatsArm,
  type StatsDeployment,
  type StatsRange,
} from "./fleet-stats.ts";
import { Cost, UnitDrawer } from "./history-tab.tsx";
import {
  API_COST_NOTE,
  compactCount,
  ESTIMATE_NOTE,
  recordKey,
  unitCost,
  unitLabel,
  usd,
  type HistoryReader,
} from "./history.ts";
import { SpendHolds, SpendLimitTable } from "./spend-limits.tsx";
import { SPEND_LIFT_NOTE, spendRowsOver, type SpendHoldRow, type SpendRow } from "./spend.ts";

/** How long the pointer rests on the button before the card opens. */
export const HOVER_OPEN_MS = 500;

/** How long the card stays once the pointer has left both it and the button. */
export const HOVER_CLOSE_MS = 300;

const RANGE_LABEL: Record<StatsRange, { short: string; long: string }> = {
  last24h: { short: "24h", long: "Last 24 hours" },
  last7d: { short: "7d", long: "Last 7 days" },
};

function RangeToggle({
  range,
  onRange,
  long = false,
}: {
  range: StatsRange;
  onRange: (range: StatsRange) => void;
  long?: boolean;
}) {
  return (
    <div className="config-views stats-range" role="group" aria-label="Window">
      {(["last24h", "last7d"] as const).map((name) => (
        <button
          key={name}
          type="button"
          className={`config-view${range === name ? " current" : ""}`}
          aria-pressed={range === name}
          onClick={() => onRange(name)}
        >
          {long ? RANGE_LABEL[name].long : RANGE_LABEL[name].short}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────── the button ─────────────────────────────

/**
 * The chart icon at the rail's foot, in the gear's 28 px box. Resting on it
 * for {@link HOVER_OPEN_MS} opens the totals card; the card stays while the
 * pointer is on either, and closes {@link HOVER_CLOSE_MS} after it has left
 * both, so the pointer can cross from one to the other. A click opens the
 * fleet stats page.
 */
export function StatsButton({
  deployments,
  onOpen,
}: {
  deployments: readonly StatsDeployment[];
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<StatsRange>("last7d");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const enter = (): void => {
    clear();
    if (!open) timer.current = setTimeout(() => setOpen(true), HOVER_OPEN_MS);
  };
  const leave = (): void => {
    clear();
    if (open) timer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  };
  useEffect(() => clear, []);
  return (
    <>
      <button
        type="button"
        className="rail-settings rail-stats"
        aria-label="Stats"
        aria-expanded={open}
        title="Units and cost across every deployment"
        onClick={() => {
          clear();
          setOpen(false);
          onOpen();
        }}
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
        <ChartNoAxesColumn size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="stats-card"
          role="dialog"
          aria-label="Every deployment"
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          <div className="stats-card-head">
            <strong>Every deployment</strong>
            <RangeToggle range={range} onRange={setRange} />
          </div>
          <Headline deployments={deployments} range={range} />
          <DeploymentRows deployments={deployments} range={range} compact />
          <p className="muted stats-note">
            Added up from each deployment&apos;s report. A deployment that reports no history is
            left out, not counted as zero. Click the icon for the full page.
          </p>
        </div>
      ) : null}
    </>
  );
}

/** The four figures, the card's and the page's. API spend and the estimate side by side, never summed. */
function Headline({
  deployments,
  range,
  tiles = false,
}: {
  deployments: readonly StatsDeployment[];
  range: StatsRange;
  tiles?: boolean;
}) {
  const { window, counted } = fleetTotals(deployments, range);
  const unfinished = didNotComplete(window);
  const empty = counted === 0;
  const figure = (value: ReactNode): ReactNode =>
    empty ? <span className="muted">—</span> : value;
  const cells: { title: string; value: ReactNode; note?: ReactNode; tip?: string }[] = [
    { title: "API spend", value: figure(usd(window.costUsd.api)), tip: API_COST_NOTE },
    {
      title: "Subscription estimate",
      value: figure(
        <>
          {usd(window.costUsd.subscriptionEstimate)} <span className="est">est.</span>
        </>,
      ),
      note: "list price, not billed",
      tip: ESTIMATE_NOTE,
    },
    {
      title: "Units",
      value: figure(window.units),
      note: empty
        ? null
        : `${window.unitsWithoutCost} with no cost reported · ${window.unitsWithPartialUsage} partial`,
    },
    {
      title: "Did not complete",
      value: figure(<span className={unfinished > 0 ? "stats-bad" : undefined}>{unfinished}</span>),
      note: empty ? null : <OutcomeLine window={window} />,
    },
  ];
  return (
    <div className={tiles ? "stats-tiles" : "stats-figures"}>
      {cells.map((cell) => (
        <div key={cell.title} className="stats-figure" title={cell.tip}>
          {tiles ? <h3>{cell.title}</h3> : null}
          <div className="stats-big">{cell.value}</div>
          {tiles ? null : <div className="muted stats-label">{cell.title}</div>}
          {tiles && cell.note !== undefined && cell.note !== null ? (
            <div className="muted stats-label">{cell.note}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function OutcomeLine({ window }: { window: HistoryWindow }) {
  const parts = (["failed", "timed-out", "abandoned"] as const)
    .filter((outcome) => window.outcomes[outcome] > 0)
    .map((outcome) => `${window.outcomes[outcome]} ${outcome}`);
  return <>{parts.length === 0 ? "every unit completed" : parts.join(" · ")}</>;
}

/** One row per deployment: its own figures, or why it is not in the totals. */
function DeploymentRows({
  deployments,
  range,
  compact = false,
}: {
  deployments: readonly StatsDeployment[];
  range: StatsRange;
  compact?: boolean;
}) {
  if (deployments.length === 0) {
    return <p className="muted">This console knows no deployments yet.</p>;
  }
  return (
    <table className="rows stats-deployments">
      {compact ? null : (
        <thead>
          <tr>
            <th>Deployment</th>
            <th>Units</th>
            <th>Did not complete</th>
            <th>API spend</th>
            <th>Subscription estimate</th>
            <th>Tokens in / out</th>
          </tr>
        </thead>
      )}
      <tbody>
        {deployments.map((deployment) => {
          const history = deployment.history;
          const window = history.kind === "summary" ? history.windows[range] : null;
          return (
            <tr key={deployment.key}>
              <td>
                {deployment.name}
                <div className="muted stats-label">{deployment.where}</div>
              </td>
              {history.kind === "summary" ? null : (
                <td colSpan={compact ? 3 : 5} className="muted">
                  {leftOutNote(history)}
                </td>
              )}
              {window === null ? null : (
                <>
                  <td>
                    {window.units}
                    {compact ? " units" : null}
                  </td>
                  <td>
                    <Unfinished count={didNotComplete(window)} />
                  </td>
                  {compact ? (
                    <td>
                      <span title={API_COST_NOTE}>{usd(window.costUsd.api)}</span>
                      {" · "}
                      <span title={ESTIMATE_NOTE}>
                        {usd(window.costUsd.subscriptionEstimate)} <span className="est">est.</span>
                      </span>
                    </td>
                  ) : (
                    <>
                      <td title={API_COST_NOTE}>{usd(window.costUsd.api)}</td>
                      <td title={ESTIMATE_NOTE}>
                        {usd(window.costUsd.subscriptionEstimate)} <span className="est">est.</span>
                      </td>
                      <td>
                        {compactCount(window.tokens.input)} / {compactCount(window.tokens.output)}
                      </td>
                    </>
                  )}
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Unfinished({ count }: { count: number }) {
  return count === 0 ? <>0</> : <span className="chip fail">{count}</span>;
}

// ───────────────────────────── the page ─────────────────────────────

/** What reading one deployment's records for the window came to. */
type RecordsState =
  | { kind: "reading" }
  | { kind: "read"; records: HistoryRecord[]; capped: boolean }
  | { kind: "too-old" }
  | { kind: "failed"; message: string };

/**
 * Every deployment's records for the window, read once per range and set of
 * deployments. Only deployments that report a summary are asked: one that is
 * too old has no history to read.
 */
function useWindowRecords(
  deployments: readonly StatsDeployment[],
  readerOf: (arm: StatsArm) => HistoryReader | null,
  range: StatsRange,
  now: Date,
): Record<string, RecordsState> {
  const [states, setStates] = useState<Record<string, RecordsState>>({});
  const asked = deployments
    .filter((deployment) => deployment.history.kind === "summary")
    .map((deployment) => deployment.key);
  const askKey = `${range}|${asked.join("\n")}`;
  const latest = useRef({ deployments, readerOf, now });
  latest.current = { deployments, readerOf, now };
  useEffect(() => {
    let live = true;
    const { deployments, readerOf, now } = latest.current;
    const since = new Date(now.getTime() - RANGE_MS[range]).toISOString();
    const reading: Record<string, RecordsState> = {};
    for (const deployment of deployments) {
      if (deployment.history.kind !== "summary") continue;
      const reader = readerOf(deployment.arm);
      if (reader === null) {
        reading[deployment.key] = { kind: "failed", message: "no way to read it from here" };
        continue;
      }
      reading[deployment.key] = { kind: "reading" };
      readWindow(reader, since).then(
        (read) => {
          if (!live) return;
          setStates((held) => ({
            ...held,
            [deployment.key]:
              read.kind === "too-old"
                ? { kind: "too-old" }
                : { kind: "read", records: read.records, capped: read.capped },
          }));
        },
        (error: unknown) => {
          if (!live) return;
          setStates((held) => ({
            ...held,
            [deployment.key]: {
              kind: "failed",
              message: error instanceof Error ? error.message : String(error),
            },
          }));
        },
      );
    }
    setStates(reading);
    return () => {
      live = false;
    };
  }, [askKey, range]);
  return states;
}

/**
 * The fleet stats page: every deployment's units and cost over the last day
 * or week. The tiles and the by-deployment table are the reports' summaries;
 * the chart, the by-model table and the most expensive units are the records,
 * read from each deployment when the page opens.
 */
export function FleetStatsPage({
  deployments,
  readerOf,
  now,
}: {
  deployments: readonly StatsDeployment[];
  /** How to read one deployment's history; null when this console cannot. */
  readerOf: (arm: StatsArm) => HistoryReader | null;
  now: Date;
}) {
  const [range, setRange] = useState<StatsRange>("last7d");
  const [drawn, setDrawn] = useState<{ record: HistoryRecord; deployment: string } | null>(null);
  const states = useWindowRecords(deployments, readerOf, range, now);
  const totals = fleetTotals(deployments, range);

  const records: { record: HistoryRecord; deployment: string }[] = [];
  const troubles: string[] = [];
  let reading = 0;
  for (const deployment of deployments) {
    const state = states[deployment.key];
    if (state === undefined) continue;
    if (state.kind === "reading") reading += 1;
    if (state.kind === "too-old") {
      troubles.push(`${deployment.name} reports history but cannot serve its records.`);
    }
    if (state.kind === "failed") {
      troubles.push(`Could not read ${deployment.name}'s units: ${state.message}.`);
    }
    if (state.kind !== "read") continue;
    if (state.capped) {
      troubles.push(
        `${deployment.name} has more than ${RECORD_CAP} units in this window; only the newest ${RECORD_CAP} are below.`,
      );
    }
    for (const record of state.records) records.push({ record, deployment: deployment.name });
  }
  const deploymentOf = new Map(records.map((entry) => [entry.record, entry.deployment]));
  const all = records.map((entry) => entry.record);
  const top = priciest(all);
  const models = byModel(all);
  const leftOut = totals.tooOld + totals.unknown;

  return (
    <main className="main fleet-stats">
      <div className="stats-page-head">
        <h1>Every deployment</h1>
        <RangeToggle range={range} onRange={setRange} long />
      </div>
      <p className="muted stats-note">
        Added up from each deployment&apos;s report.
        {leftOut === 0
          ? null
          : ` ${leftOut} deployment${leftOut === 1 ? " is" : "s are"} left out rather than counted as zero; the table below says why.`}
      </p>

      <Headline deployments={deployments} range={range} tiles />

      {range === "last7d" ? (
        <>
          <h2>Units per day</h2>
          {reading > 0 && all.length === 0 ? (
            <p className="muted">Reading units…</p>
          ) : (
            <DayChart records={all} now={now} />
          )}
        </>
      ) : null}

      <h2>By deployment</h2>
      <DeploymentRows deployments={deployments} range={range} />

      <FleetSpendLimits deployments={deployments} range={range} now={now} />

      {troubles.length === 0 ? null : (
        <ul className="stats-troubles">
          {troubles.map((trouble) => (
            <li key={trouble} className="refusal">
              {trouble}
            </li>
          ))}
        </ul>
      )}

      <h2>By model</h2>
      {models.length === 0 ? (
        <p className="muted">{reading > 0 ? "Reading units…" : "No units in this window."}</p>
      ) : (
        <table className="rows">
          <thead>
            <tr>
              <th>Model</th>
              <th>Units</th>
              <th>Did not complete</th>
              <th>Cost</th>
              <th>Tokens in / out</th>
            </tr>
          </thead>
          <tbody>
            {models.map((row) => (
              <tr key={row.model ?? ""}>
                <td className="mono">{row.model ?? "—"}</td>
                <td>{row.units}</td>
                <td>
                  <Unfinished count={row.didNotComplete} />
                </td>
                <td>
                  <ModelCost api={row.api} estimate={row.estimate} />
                </td>
                <td>
                  {compactCount(row.input)} / {compactCount(row.output)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Most expensive units</h2>
      {top.length === 0 ? (
        <p className="muted">
          {reading > 0 ? "Reading units…" : "No unit in this window reported a cost."}
        </p>
      ) : (
        <table className="rows">
          <thead>
            <tr>
              <th>Started</th>
              <th>Deployment</th>
              <th>Unit</th>
              <th>Outcome</th>
              <th>Model</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {top.map((record) => {
              const deployment = deploymentOf.get(record) ?? "";
              const open = (): void => setDrawn({ record, deployment });
              return (
                <tr
                  key={`${deployment}|${recordKey(record)}`}
                  className="history-row"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      open();
                    }
                  }}
                >
                  <td className="muted" title={record.startedAt}>
                    {age(record.startedAt, now)} ago
                  </td>
                  <td>{deployment}</td>
                  <td>
                    <span className="mono">{record.unit.kind}</span> {unitLabel(record)}
                  </td>
                  <td>{record.outcome}</td>
                  <td className="mono">{record.model ?? "—"}</td>
                  <td>
                    <Cost view={unitCost(record)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {drawn === null ? null : (
        <UnitDrawer record={drawn.record} now={now} showTenant onClose={() => setDrawn(null)} />
      )}
    </main>
  );
}

/**
 * Every deployment's spend limits over the window on show, each beside its
 * figure, and every pipeline a ceiling holds whatever its window (#991).
 * Nothing at all when no deployment sets a limit.
 */
function FleetSpendLimits({
  deployments,
  range,
  now,
}: {
  deployments: readonly StatsDeployment[];
  range: StatsRange;
  now: Date;
}) {
  const window = range === "last24h" ? "24h" : "7d";
  const rows: SpendRow[] = [];
  const holds: SpendHoldRow[] = [];
  const nameOf = new Map<string, string>();
  for (const deployment of deployments) {
    for (const row of spendRowsOver(deployment.spend, window)) {
      const keyed = { ...row, key: `${deployment.key}|${row.key}` };
      nameOf.set(keyed.key, deployment.name);
      rows.push(keyed);
    }
    for (const hold of deployment.spend.holds) {
      const keyed = { ...hold, key: `${deployment.key}|${hold.key}` };
      nameOf.set(keyed.key, deployment.name);
      holds.push(keyed);
    }
  }
  const configured = deployments.some((deployment) => deployment.spend.rows.length > 0);
  if (!configured && holds.length === 0) return null;
  const named = (entry: { key: string }): string => nameOf.get(entry.key) ?? "";
  return (
    <>
      <h2>Spend limits</h2>
      <SpendHolds holds={holds} now={now} deployment={named} />
      {rows.length === 0 ? (
        <p className="muted">No limit is set over the {RANGE_LABEL[range].long.toLowerCase()}.</p>
      ) : (
        <SpendLimitTable rows={rows} deployment={named} />
      )}
      <p className="muted stats-note">{SPEND_LIFT_NOTE}</p>
    </>
  );
}

/** A model's cost by basis: never one figure made of both. */
function ModelCost({ api, estimate }: { api: number; estimate: number }) {
  if (api === 0 && estimate === 0) return <span className="muted">tokens only</span>;
  return (
    <>
      {api > 0 ? <span title={API_COST_NOTE}>{usd(api)}</span> : null}
      {api > 0 && estimate > 0 ? " · " : null}
      {estimate > 0 ? (
        <span title={ESTIMATE_NOTE}>
          {usd(estimate)} <span className="est">est.</span>
        </span>
      ) : null}
    </>
  );
}

/** Seven columns, one per day, completed units under the ones that did not complete. */
function DayChart({ records, now }: { records: readonly HistoryRecord[]; now: Date }) {
  const days = unitsPerDay(records, now);
  const most = Math.max(1, ...days.map((day) => day.completed + day.didNotComplete));
  return (
    <figure className="stats-chart">
      <div className="stats-columns">
        {days.map((day) => {
          const total = day.completed + day.didNotComplete;
          const name = new Date(day.day).toLocaleDateString(undefined, { weekday: "short" });
          return (
            <div
              key={day.day}
              className="stats-column"
              title={`${new Date(day.day).toLocaleDateString()}: ${total} unit${total === 1 ? "" : "s"}, ${day.didNotComplete} did not complete`}
            >
              <div className="stats-bars">
                {day.didNotComplete === 0 ? null : (
                  <span
                    className="stats-bar bad"
                    style={{ height: `${(day.didNotComplete / most) * 100}%` }}
                  />
                )}
                {day.completed === 0 ? null : (
                  <span
                    className="stats-bar ok"
                    style={{ height: `${(day.completed / most) * 100}%` }}
                  />
                )}
              </div>
              <span className="stats-count">{total}</span>
              <span className="muted stats-day">{name}</span>
            </div>
          );
        })}
      </div>
      <figcaption className="muted stats-legend">
        <span className="stats-swatch ok" /> completed <span className="stats-swatch bad" /> did not
        complete
      </figcaption>
    </figure>
  );
}
