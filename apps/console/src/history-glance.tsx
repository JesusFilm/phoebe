// Unit history where an operator already looks (#932, variant D of the #919
// prototype): the overview's 7-day card and its "Needs a look" feed, and the
// breakdown behind each pipeline's expansion on the pipelines tab.
//
// The card and the breakdown draw the summary the report already carries
// (#929) and fetch nothing. The feed is the one part that reads records: the
// newest units that did not complete, asked for when the overview opens and
// again when the fleet's summary moves, which is when a record was written.
// Each feed entry opens the History tab's drawer; the link under it opens the
// History tab for the rest.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HistoryRecord, HistorySummary, HistoryWindow } from "phoebe-agent/contracts";
import { age } from "./facts.ts";
import { Cost, OutcomeChip, UnitDrawer } from "./history-tab.tsx";
import {
  compactCount,
  readNeedsALook,
  recordKey,
  summaryCost,
  TOKENS_ONLY_NOTE,
  unfinishedOf,
  unitCost,
  unitLabel,
  type HistoryReader,
  type NeedsALookFetch,
} from "./history.ts";

const WEEK_MS = 7 * 86_400_000;

/** A summed cost: dollars by basis, "tokens only", or a dash when no unit ran. */
export function SummaryCost({ window }: { window: HistoryWindow }) {
  const view = summaryCost(window);
  if (view.kind === "no-units") return <span className="muted">—</span>;
  if (view.kind === "tokens-only") {
    return (
      <span className="muted" title={TOKENS_ONLY_NOTE}>
        tokens only
      </span>
    );
  }
  return <Cost view={view} />;
}

/** `2 failed, 1 timed out`: each outcome that did not complete and has units. */
function unfinishedParts(window: HistoryWindow): string {
  const parts: string[] = [];
  if (window.outcomes.failed > 0) parts.push(`${window.outcomes.failed} failed`);
  if (window.outcomes["timed-out"] > 0) parts.push(`${window.outcomes["timed-out"]} timed out`);
  if (window.outcomes.abandoned > 0) parts.push(`${window.outcomes.abandoned} abandoned`);
  return parts.join(", ");
}

/** Units a day over the window: a count divided, which is formatting (#929). */
function perDay(units: number): string {
  const rate = units / 7;
  return rate >= 10 || Number.isInteger(rate) ? rate.toFixed(0) : rate.toFixed(1);
}

/** The overview's card: the fleet's last 7 days, read off the report. */
export function WeekCard({ summary, now }: { summary: HistorySummary | null; now: Date }) {
  if (summary === null) {
    return (
      <section className="week-card">
        <h2>Last 7 days</h2>
        <p className="muted">
          This report carries no unit history. The deployment&apos;s bootstrapper predates it, so
          there is nothing to sum, not a quiet week.
        </p>
      </section>
    );
  }
  const week = summary.last7d;
  const unfinished = unfinishedOf(week.outcomes);
  const notes: string[] = [];
  if (week.unitsWithoutCost > 0) notes.push(`${week.unitsWithoutCost} with no cost reported`);
  if (week.unitsWithPartialUsage > 0) {
    notes.push(`${week.unitsWithPartialUsage} with partial usage`);
  }
  return (
    <section className="week-card">
      <h2>Last 7 days</h2>
      <div className="week-tiles">
        <div className="week-tile">
          <div className="week-figure">{week.units}</div>
          <div className="muted">units · {perDay(week.units)} a day</div>
        </div>
        <div className="week-tile">
          <div className="week-figure">
            <SummaryCost window={week} />
          </div>
          <div className="muted">{notes.length === 0 ? "cost" : `cost · ${notes.join(", ")}`}</div>
        </div>
        <div className="week-tile">
          <div className={`week-figure${unfinished > 0 ? " unfinished" : ""}`}>{unfinished}</div>
          <div className="muted">
            did not complete{unfinished > 0 ? ` · ${unfinishedParts(week)}` : ""}
          </div>
        </div>
      </div>
      <p className="muted week-asof" title={summary.asOf}>
        Summed {age(summary.asOf, now)} ago.
      </p>
    </section>
  );
}

type FeedState =
  | { kind: "loading" }
  | { kind: "read"; fetched: NeedsALookFetch }
  | { kind: "failed"; message: string };

/**
 * Up to six units from the last 7 days that did not complete, newest first.
 * Each opens the drawer; the link under them opens the History tab.
 */
export function NeedsALook({
  reader,
  scope,
  asOf,
  now,
  showTenant,
  onHistory,
}: {
  reader: HistoryReader;
  /** What the reader reads, as a stable string, like the History tab's. */
  scope: string;
  /** The fleet summary's `asOf`: when it moves a record was written, so the feed asks again. */
  asOf: string;
  now: Date;
  showTenant: boolean;
  /** Opens the History tab. Absent, the feed has no link. */
  onHistory?: () => void;
}) {
  const [state, setState] = useState<FeedState>({ kind: "loading" });
  const [open, setOpen] = useState<HistoryRecord | null>(null);
  const [attempt, setAttempt] = useState(0);
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    let live = true;
    const since = new Date(nowRef.current.getTime() - WEEK_MS).toISOString();
    readNeedsALook(readerRef.current, since).then(
      (fetched) => {
        if (live) setState({ kind: "read", fetched });
      },
      (error: unknown) => {
        if (live) {
          setState({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [scope, asOf, attempt]);

  // The read was made at some earlier `now`; units that have since aged out of
  // the window are dropped here, and leave the total with them.
  const cutoff = new Date(now.getTime() - WEEK_MS).toISOString();
  const current =
    state.kind === "read" && state.fetched.kind === "units"
      ? state.fetched.records.filter((record) => record.startedAt >= cutoff)
      : [];
  // Omitted units are older than every returned one, so once any returned unit
  // has aged out, the omitted ones have too.
  const more =
    state.kind === "read" &&
    state.fetched.kind === "units" &&
    current.length === state.fetched.records.length
      ? state.fetched.total - state.fetched.records.length
      : 0;
  const body = ((): ReactNode => {
    if (state.kind === "loading") return <p className="muted">Reading units…</p>;
    if (state.kind === "failed") {
      return (
        <p className="refusal">
          Could not read the units: {state.message}{" "}
          <button type="button" className="quiet" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      );
    }
    if (state.fetched.kind === "too-old") {
      return (
        <p className="muted">
          This deployment is too old to list its units. Upgrade it, and units that did not complete
          show here.
        </p>
      );
    }
    const records = current;
    if (records.length === 0) return <p className="muted">Every unit this week completed.</p>;
    return (
      <table className="rows feed-rows">
        <tbody>
          {records.map((record) => (
            <tr key={recordKey(record)} className="history-row" onClick={() => setOpen(record)}>
              <td className="muted" title={record.startedAt}>
                {age(record.startedAt, now)} ago
              </td>
              <td>{showTenant ? `${record.tenant} ${record.pipeline}` : record.pipeline}</td>
              <td>
                <button
                  type="button"
                  className="quiet history-open"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(record);
                  }}
                >
                  <span className="mono">{record.unit.kind}</span> {unitLabel(record)}
                </button>
              </td>
              <td>
                <OutcomeChip record={record} />
              </td>
              <td className="muted feed-detail" title={record.detail ?? undefined}>
                {record.detail ?? ""}
              </td>
              <td>
                <Cost view={unitCost(record)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  })();

  return (
    <section className="needs-a-look">
      <h2>Needs a look</h2>
      {body}
      {onHistory === undefined ? null : (
        <p>
          <button type="button" className="quiet" onClick={onHistory}>
            {more > 0
              ? `${more} more, and every unit, in the History tab →`
              : "Every unit in the History tab →"}
          </button>
        </p>
      )}
      {open === null ? null : (
        <UnitDrawer record={open} now={now} showTenant={showTenant} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}

/** What a pipeline row says in its 7-day columns before it is opened. */
export function PipelineWeek({ summary }: { summary: HistorySummary | null }) {
  if (summary === null) {
    const none = (
      <span className="muted" title="This report carries no unit history for the pipeline.">
        —
      </span>
    );
    return (
      <>
        <td>{none}</td>
        <td>{none}</td>
        <td>{none}</td>
      </>
    );
  }
  const week = summary.last7d;
  const unfinished = unfinishedOf(week.outcomes);
  return (
    <>
      <td>{week.units}</td>
      <td>
        {unfinished === 0 ? (
          <span className="muted">0</span>
        ) : (
          <span className="chip fail outcome-chip" title={unfinishedParts(week)}>
            {unfinished}
          </span>
        )}
      </td>
      <td>
        <SummaryCost window={week} />
      </td>
    </>
  );
}

/** A window's outcomes as one bar, completed first. */
function OutcomeBar({ window }: { window: HistoryWindow }) {
  if (window.units === 0) return null;
  const share = (n: number): string => `${(n / window.units) * 100}%`;
  const { completed, failed, abandoned } = window.outcomes;
  const timedOut = window.outcomes["timed-out"];
  return (
    <div
      className="outcome-bar"
      role="img"
      aria-label={`${completed} completed, ${failed} failed, ${timedOut} timed out, ${abandoned} abandoned`}
      title={`${completed} completed, ${failed} failed, ${timedOut} timed out, ${abandoned} abandoned`}
    >
      <span className="completed" style={{ width: share(completed) }} />
      <span className="failed" style={{ width: share(failed) }} />
      <span className="timed-out" style={{ width: share(timedOut) }} />
      <span className="abandoned" style={{ width: share(abandoned) }} />
    </div>
  );
}

/**
 * One pipeline's history, opened: the last 24 hours beside the last 7 days,
 * every count and sum the report carries for it.
 */
export function PipelineBreakdown({ summary, now }: { summary: HistorySummary | null; now: Date }) {
  if (summary === null) {
    return (
      <p className="muted">
        This report carries no unit history for this pipeline. The deployment&apos;s bootstrapper
        predates it.
      </p>
    );
  }
  const windows = [summary.last24h, summary.last7d];
  const row = (label: string, cell: (window: HistoryWindow) => ReactNode) => (
    <tr>
      <th scope="row">{label}</th>
      {windows.map((window, index) => (
        <td key={index}>{cell(window)}</td>
      ))}
    </tr>
  );
  return (
    <div className="pipeline-breakdown">
      <OutcomeBar window={summary.last7d} />
      <table className="rows">
        <thead>
          <tr>
            <th />
            <th>Last 24 hours</th>
            <th>Last 7 days</th>
          </tr>
        </thead>
        <tbody>
          {row("Units", (window) => window.units)}
          {row("Completed", (window) => window.outcomes.completed)}
          {row("Failed", (window) => window.outcomes.failed)}
          {row("Timed out", (window) =>
            window.quarantined > 0
              ? `${window.outcomes["timed-out"]} (${window.quarantined} quarantined)`
              : window.outcomes["timed-out"],
          )}
          {row("Abandoned", (window) => window.outcomes.abandoned)}
          {row("Cost", (window) => (
            <SummaryCost window={window} />
          ))}
          {row(
            "Tokens in / out",
            (window) =>
              `${compactCount(window.tokens.input)} / ${compactCount(window.tokens.output)}`,
          )}
          {row(
            "Cache read / write",
            (window) =>
              `${compactCount(window.tokens.cacheRead)} / ${compactCount(window.tokens.cacheWrite)}`,
          )}
          {row("No cost reported", (window) => window.unitsWithoutCost)}
          {row("Partial usage", (window) => window.unitsWithPartialUsage)}
        </tbody>
      </table>
      <p className="muted history-foot" title={summary.asOf}>
        Summed {age(summary.asOf, now)} ago. The History tab lists the units themselves.
      </p>
    </div>
  );
}
