// PROTOTYPE — throwaway, map #914 ticket #919. Not production code.
//
// Three structurally different answers to "where do unit history and cost
// live in the console, how does an operator filter and drill in, and how does
// a missing cost read":
//
//   A  a sixth deployment tab, `history`: summary tiles, a filter bar, one
//      flat table, rows that expand in place. Rail and overview unchanged.
//   B  no new tab: the pipelines tab grows a 7-day strip and a per-kind
//      breakdown per pipeline, kinds expand into their units; the rail gets
//      a spend and failure line. Tokens lead, dollars follow.
//   C  overview-first: a "last 7 days" card with a per-day chart, a "needs a
//      look" list, a day-grouped feed, and a side drawer for one unit.
//   D  the owner's pick after the first look: A's tab with C's drawer, C's
//      card on the overview, B's breakdown behind a per-pipeline expansion,
//      and a stats button at the rail's foot with totals across deployments.

import { ChartNoAxesColumn } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  KINDS,
  MODELS,
  OUTCOMES,
  RECORDS,
  ageOf,
  cellsOfHistory,
  compact,
  costOf,
  filterRecords,
  githubHref,
  mins,
  retainedSince,
  summarize,
  tokensOf,
  usd,
  type Filters,
  type Outcome,
  type UnitRecord,
  type Window,
} from "./data.ts";

const STYLE = `
.ph-tiles { display: flex; gap: 12px; margin: 8px 0 14px; flex-wrap: wrap; }
.ph-tile { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; min-width: 220px; }
.ph-tile h3 { margin: 0 0 6px; font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.ph-big { font-size: 22px; font-weight: 600; }
.ph-filters { display: flex; gap: 8px; margin: 6px 0 10px; flex-wrap: wrap; align-items: center; }
.ph-filters select { font: inherit; font-size: 13px; padding: 2px 6px; background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; }
.ph-row { cursor: pointer; }
.ph-row:hover td { background: var(--chip); }
.ph-detail td { background: var(--panel); }
.ph-est { color: var(--muted); font-style: italic; }
.ph-none { color: var(--muted); }
.ph-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--chip); min-width: 160px; }
.ph-bar span { display: block; height: 100%; }
.ph-ok { background: var(--ok); } .ph-failc { background: var(--fail); } .ph-to { background: var(--warn); } .ph-ab { background: var(--dark); }
.ph-pipeline { border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; background: var(--panel); }
.ph-pipeline header { display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; }
.ph-chart { display: flex; gap: 6px; align-items: flex-end; height: 90px; margin: 10px 0 4px; }
.ph-col { display: flex; flex-direction: column-reverse; width: 34px; }
.ph-col span { display: block; width: 100%; }
.ph-days { display: flex; gap: 6px; font-size: 11px; color: var(--muted); }
.ph-days span { width: 34px; text-align: center; }
.ph-feed h4 { margin: 14px 0 4px; font-size: 12px; color: var(--muted); }
.ph-item { display: grid; grid-template-columns: 90px 1fr 120px 110px; gap: 10px; padding: 6px 4px; border-bottom: 1px solid var(--line); cursor: pointer; font-size: 13px; }
.ph-item:hover { background: var(--chip); }
.ph-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 440px; background: var(--bg); border-left: 1px solid var(--line); box-shadow: -8px 0 24px rgba(0,0,0,.18); padding: 18px 20px 80px; overflow: auto; z-index: 900; }
.ph-kv { display: grid; grid-template-columns: 130px 1fr; gap: 4px 10px; font-size: 13px; }
.ph-kv dt { color: var(--muted); }
.ph-kv dd { margin: 0; }
.ph-rail { font-size: 11px; }
`;

export function PrototypeStyle() {
  return <style>{STYLE}</style>;
}

// ── shared bits ────────────────────────────────────────────────────────────

function OutcomeChip({ record }: { record: UnitRecord }) {
  const tone =
    record.outcome === "failed"
      ? "chip fail"
      : record.outcome === "timed-out"
        ? "chip warn"
        : record.outcome === "abandoned"
          ? "chip"
          : "chip";
  return (
    <>
      <span className={tone} style={{ marginLeft: 0 }}>
        {record.outcome}
      </span>
      {record.quarantined ? <span className="chip warn">quarantined</span> : null}
    </>
  );
}

function OutcomeBar({ window }: { window: Window }) {
  const total = Math.max(window.units, 1);
  const pct = (n: number): string => `${(n / total) * 100}%`;
  return (
    <div
      className="ph-bar"
      title={`${window.byOutcome.completed} completed, ${window.byOutcome.failed} failed, ${window.byOutcome["timed-out"]} timed out, ${window.byOutcome.abandoned} abandoned`}
    >
      <span className="ph-ok" style={{ width: pct(window.byOutcome.completed) }} />
      <span className="ph-failc" style={{ width: pct(window.byOutcome.failed) }} />
      <span className="ph-to" style={{ width: pct(window.byOutcome["timed-out"]) }} />
      <span className="ph-ab" style={{ width: pct(window.byOutcome.abandoned) }} />
    </div>
  );
}

function UnitFacts({ record }: { record: UnitRecord }) {
  const href = githubHref(record);
  return (
    <dl className="ph-kv">
      <dt>unit</dt>
      <dd className="mono">
        {record.unit.kind} {record.unit.id}
      </dd>
      <dt>on GitHub</dt>
      <dd>
        {href === null ? (
          <span className="muted">no issue or PR</span>
        ) : (
          <a href={href} target="_blank" rel="noreferrer">
            {href.replace("https://github.com/", "")}
          </a>
        )}
      </dd>
      <dt>branch</dt>
      <dd className="mono">{record.branch ?? "—"}</dd>
      <dt>head</dt>
      <dd className="mono">{record.headSha ?? "—"}</dd>
      <dt>provider</dt>
      <dd>
        {record.provider} · {record.model}
        {record.effort === null ? "" : ` · effort ${record.effort}`}
      </dd>
      <dt>duration</dt>
      <dd>
        {mins(record.durationMs)} of {mins(record.runBudgetMs)} budget
      </dd>
      <dt>engine</dt>
      <dd className="mono">{record.engineCommit}</dd>
      {record.detail === null ? null : (
        <>
          <dt>detail</dt>
          <dd>{record.detail}</dd>
        </>
      )}
    </dl>
  );
}

function AgentRunsTable({
  record,
  cost,
}: {
  record: UnitRecord;
  cost: (r: UnitRecord, run?: number) => ReactNode;
}) {
  if (record.agentRuns.length === 0) {
    return (
      <p className="muted">
        {record.outcome === "abandoned"
          ? "No agent runs recorded: the process ended before the unit settled."
          : "No agent ran: the engine settled this unit without one (a clean merge)."}
      </p>
    );
  }
  return (
    <table className="rows">
      <thead>
        <tr>
          <th>#</th>
          <th>time</th>
          <th>cost</th>
          <th>tokens in / out</th>
          <th>cache read</th>
          <th>turns</th>
          <th>tools</th>
          <th>prompt</th>
        </tr>
      </thead>
      <tbody>
        {record.agentRuns.map((run, i) => (
          <tr key={run.startedAt}>
            <td>{i + 1}</td>
            <td>{mins(run.durationMs)}</td>
            <td>{cost(record, i)}</td>
            <td>
              {compact(run.inputTokens)} / {compact(run.outputTokens)}
              {run.usageComplete ? null : <span className="chip warn">partial</span>}
            </td>
            <td>{compact(run.cacheReadTokens)}</td>
            <td>{run.turns ?? "—"}</td>
            <td className="mono" style={{ fontSize: 11 }}>
              {Object.entries(run.toolCalls)
                .map(([name, n]) => `${name} ${n}`)
                .join(", ")}
            </td>
            <td className="mono" style={{ fontSize: 11 }}>
              {run.promptSha.slice(7, 15)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function runCost(record: UnitRecord, index: number | undefined) {
  if (index === undefined) return costOf(record);
  const run = record.agentRuns[index];
  return {
    usd: run?.costUsd ?? null,
    basis: run?.costBasis ?? null,
    partial: run !== undefined && !run.usageComplete,
  };
}

// ── variant A: a history tab ───────────────────────────────────────────────

function costA(record: UnitRecord, index?: number): ReactNode {
  const cost = runCost(record, index);
  if (cost.usd === null) {
    return (
      <span
        className="ph-none"
        title={
          record.agentRuns.length === 0
            ? "no agent ran"
            : `${record.provider} reports tokens but no cost`
        }
      >
        —
      </span>
    );
  }
  return cost.basis === "subscription-estimate" ? (
    <span className="ph-est" title="Claude's list-price estimate; a subscription paid for this">
      {usd(cost.usd)} est.
    </span>
  ) : (
    <span>{usd(cost.usd)}</span>
  );
}

function Tile({ title, window }: { title: string; window: Window }) {
  const problems =
    window.byOutcome.failed + window.byOutcome["timed-out"] + window.byOutcome.abandoned;
  return (
    <div className="ph-tile">
      <h3>{title}</h3>
      <div className="ph-big">
        {usd(window.costUsd.api)}
        <span className="ph-est" style={{ fontSize: 14, fontWeight: 400 }}>
          {" "}
          + {usd(window.costUsd.estimate)} est.
        </span>
      </div>
      <div>
        {window.units} units · {problems === 0 ? "none failed" : `${problems} did not complete`}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {window.unitsWithoutCost} with no cost reported · {window.usageIncomplete} partial
      </div>
      <div style={{ marginTop: 6 }}>
        <OutcomeBar window={window} />
      </div>
    </div>
  );
}

export function VariantA({ drawer = false }: { drawer?: boolean }) {
  const [filters, setFilters] = useState<Filters>({});
  const [open, setOpen] = useState<string | null>(null);
  const [drawn, setDrawn] = useState<UnitRecord | null>(null);
  const [limit, setLimit] = useState(50);
  const matched = filterRecords(filters);
  const summary = summarize(matched);
  const set = <K extends keyof Filters>(key: K, value: string): void => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value === "") delete next[key];
      else next[key] = value as Filters[K];
      return next;
    });
    setLimit(50);
  };
  return (
    <section>
      <h2>History</h2>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        Summary as of {ageOf(summary.asOf)}. Totals cover every unit that matches the filters.
      </p>
      <div className="ph-tiles">
        <Tile title="Last 24 hours" window={summary.h24} />
        <Tile title="Last 7 days" window={summary.d7} />
      </div>
      <div className="ph-filters">
        <select value={filters.cell ?? ""} onChange={(e) => set("cell", e.target.value)}>
          <option value="">every pipeline</option>
          {cellsOfHistory().map((cell) => (
            <option key={cell} value={cell}>
              {cell.split("#")[1]}
            </option>
          ))}
        </select>
        <select value={filters.kind ?? ""} onChange={(e) => set("kind", e.target.value)}>
          <option value="">every kind</option>
          {KINDS.map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
        <select value={filters.outcome ?? ""} onChange={(e) => set("outcome", e.target.value)}>
          <option value="">every outcome</option>
          {OUTCOMES.map((outcome) => (
            <option key={outcome}>{outcome}</option>
          ))}
        </select>
        <select value={filters.model ?? ""} onChange={(e) => set("model", e.target.value)}>
          <option value="">every model</option>
          {MODELS.map((model) => (
            <option key={model}>{model}</option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>
          {matched.length} units
        </span>
      </div>
      <table className="rows">
        <thead>
          <tr>
            <th>started</th>
            <th>pipeline</th>
            <th>unit</th>
            <th>outcome</th>
            <th>model</th>
            <th>time</th>
            <th>cost</th>
            <th>tokens in / out</th>
          </tr>
        </thead>
        <tbody>
          {matched.slice(0, limit).map((record) => {
            const key = `${record.unit.id}@${record.startedAt}`;
            const tokens = tokensOf(record);
            return [
              <tr
                key={key}
                className="ph-row"
                onClick={() => (drawer ? setDrawn(record) : setOpen(open === key ? null : key))}
              >
                <td className="muted">{ageOf(record.startedAt)}</td>
                <td>{record.pipeline}</td>
                <td>
                  <span className="mono">
                    {record.unit.kind} {record.unit.id}
                  </span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {record.title}
                  </div>
                </td>
                <td>
                  <OutcomeChip record={record} />
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {record.model}
                </td>
                <td>{mins(record.durationMs)}</td>
                <td>{costA(record)}</td>
                <td>
                  {compact(tokens.input)} / {compact(tokens.output)}
                </td>
              </tr>,
              open === key ? (
                <tr key={`${key}-detail`} className="ph-detail">
                  <td colSpan={8}>
                    <UnitFacts record={record} />
                    <div style={{ height: 10 }} />
                    <AgentRunsTable record={record} cost={costA} />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 12 }}>
        {matched.length > limit ? (
          <button type="button" className="chip" onClick={() => setLimit(limit + 50)}>
            show 50 more
          </button>
        ) : null}{" "}
        This deployment holds units back to{" "}
        {new Date(retainedSince(filters.cell)).toLocaleDateString()}. Older ones have rotated out.
      </p>
      {drawn === null ? null : (
        <UnitDrawer record={drawn} onClose={() => setDrawn(null)} cost={costA} />
      )}
    </section>
  );
}

// ── variant B: inside pipelines, plus a rail line ──────────────────────────

function costB(record: UnitRecord, index?: number): ReactNode {
  const cost = runCost(record, index);
  const tokens =
    index === undefined
      ? tokensOf(record)
      : {
          input: record.agentRuns[index]?.inputTokens ?? null,
          output: record.agentRuns[index]?.outputTokens ?? null,
        };
  const total = (tokens.input ?? 0) + (tokens.output ?? 0);
  return (
    <span>
      <strong>
        {tokens.input === null && tokens.output === null ? "—" : `${compact(total)} tok`}
      </strong>
      <span className="muted" style={{ fontSize: 12 }}>
        {" "}
        {cost.usd === null
          ? record.agentRuns.length === 0
            ? ""
            : "· tokens only"
          : cost.basis === "subscription-estimate"
            ? `· ~${usd(cost.usd)} list`
            : `· ${usd(cost.usd)}`}
      </span>
    </span>
  );
}

function PipelineBlock({ cell, bare = false }: { cell: string; bare?: boolean }) {
  const [openKind, setOpenKind] = useState<string | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const records = filterRecords({ cell });
  const summary = summarize(records);
  const name = cell.split("#")[1] ?? cell;
  const kinds = [...new Set(records.map((record) => record.unit.kind))];
  return (
    <div className="ph-pipeline" style={bare ? { margin: "4px 0 8px" } : undefined}>
      <header style={bare ? { display: "none" } : undefined}>
        <h3 style={{ margin: 0 }}>{name}</h3>
        <span className="muted">working 1/2 · child running 3h</span>
        <span style={{ marginLeft: "auto" }}>
          7d: {summary.d7.units} units ·{" "}
          {compact(summary.d7.tokens.input + summary.d7.tokens.output)} tok
          {summary.d7.costUsd.api > 0 ? ` · ${usd(summary.d7.costUsd.api)}` : ""}
          {summary.d7.costUsd.estimate > 0 ? (
            <span className="ph-est"> · ~{usd(summary.d7.costUsd.estimate)} list</span>
          ) : null}
        </span>
      </header>
      <div style={{ margin: "8px 0" }}>
        <OutcomeBar window={summary.d7} />
      </div>
      <table className="rows">
        <thead>
          <tr>
            <th>kind</th>
            <th>units 7d</th>
            <th>did not complete</th>
            <th>tokens 7d</th>
            <th>cost 7d</th>
          </tr>
        </thead>
        <tbody>
          {kinds.map((kind) => {
            const own = summarize(records.filter((record) => record.unit.kind === kind)).d7;
            const bad = own.byOutcome.failed + own.byOutcome["timed-out"] + own.byOutcome.abandoned;
            const shown = records
              .filter((record) => record.unit.kind === kind)
              .filter((record) => !problemsOnly || record.outcome !== "completed")
              .slice(0, 15);
            return [
              <tr
                key={kind}
                className="ph-row"
                onClick={() => setOpenKind(openKind === kind ? null : kind)}
              >
                <td>
                  {openKind === kind ? "▾" : "▸"} {kind}
                </td>
                <td>{own.units}</td>
                <td>
                  {bad === 0 ? (
                    <span className="muted">0</span>
                  ) : (
                    <span className="chip fail">{bad}</span>
                  )}
                  <span className="muted" style={{ fontSize: 12 }}>
                    {" "}
                    of {own.units}
                  </span>
                </td>
                <td>{compact(own.tokens.input + own.tokens.output)}</td>
                <td>
                  {own.costUsd.api + own.costUsd.estimate === 0 ? (
                    <span className="muted">tokens only</span>
                  ) : own.costUsd.api > 0 ? (
                    usd(own.costUsd.api)
                  ) : (
                    <span className="ph-est">~{usd(own.costUsd.estimate)} list</span>
                  )}
                </td>
              </tr>,
              openKind === kind ? (
                <tr key={`${kind}-units`} className="ph-detail">
                  <td colSpan={5}>
                    <label style={{ fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={problemsOnly}
                        onChange={(e) => setProblemsOnly(e.target.checked)}
                      />{" "}
                      only units that did not complete
                    </label>
                    <table className="rows">
                      <tbody>
                        {shown.map((record) => {
                          const href = githubHref(record);
                          return (
                            <tr key={`${record.unit.id}@${record.startedAt}`}>
                              <td className="muted">{ageOf(record.startedAt)}</td>
                              <td>
                                {href === null ? (
                                  <span className="mono">{record.unit.id}</span>
                                ) : (
                                  <a className="mono" href={href} target="_blank" rel="noreferrer">
                                    {record.unit.id}
                                    {record.prNumber !== null && !record.unit.id.startsWith("pr:")
                                      ? ` → PR ${record.prNumber}`
                                      : ""}
                                  </a>
                                )}{" "}
                                <span className="muted">{record.title}</span>
                              </td>
                              <td>
                                <OutcomeChip record={record} />
                                {record.detail === null ? null : (
                                  <div className="muted" style={{ fontSize: 12 }}>
                                    {record.detail}
                                  </div>
                                )}
                              </td>
                              <td>{mins(record.durationMs)}</td>
                              <td>{costB(record)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

export function VariantB() {
  return (
    <section>
      <h2>Pipelines</h2>
      <p className="muted" style={{ fontSize: 12 }}>
        Each pipeline&apos;s last 7 days under its live state. Open a kind to see its units.
      </p>
      {cellsOfHistory().map((cell) => (
        <PipelineBlock key={cell} cell={cell} />
      ))}
    </section>
  );
}

/** Variant B's line under the install on the rail. */
export function RailHistoryLine({ expandable = false }: { expandable?: boolean }) {
  const [open, setOpen] = useState(false);
  const h24 = summarize(RECORDS).h24;
  const bad = h24.byOutcome.failed + h24.byOutcome["timed-out"] + h24.byOutcome.abandoned;
  const line = (
    <>
      24h {h24.units} units
      {bad > 0 ? <span className="chip fail">{bad} failed</span> : null}
      <span className="muted"> {usd(h24.costUsd.api)}</span>
    </>
  );
  if (!expandable) return <div className="rail-summary ph-rail">{line}</div>;
  return (
    <div className="rail-summary ph-rail" style={{ display: "block" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          background: "none",
          border: 0,
          padding: 0,
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
        }}
        title="Last 24 hours, per pipeline"
      >
        {open ? "▾" : "▸"} {line}
      </button>
      {open
        ? cellsOfHistory().map((cell) => {
            const w = summarize(filterRecords({ cell })).h24;
            const b = w.byOutcome.failed + w.byOutcome["timed-out"] + w.byOutcome.abandoned;
            return (
              <div key={cell} style={{ paddingLeft: 14 }}>
                {cell.split("#")[1]} · {w.units} units
                {b > 0 ? <span className="chip fail">{b}</span> : null}
                <span className="muted">
                  {" "}
                  {w.costUsd.api + w.costUsd.estimate === 0
                    ? "tokens only"
                    : w.costUsd.api > 0
                      ? usd(w.costUsd.api)
                      : `~${usd(w.costUsd.estimate)}`}
                </span>
              </div>
            );
          })
        : null}
    </div>
  );
}

// ── variant C: overview card, feed and drawer ──────────────────────────────

function costC(record: UnitRecord, index?: number): ReactNode {
  const cost = runCost(record, index);
  if (cost.usd === null) {
    if (record.agentRuns.length === 0) return <span className="muted">no agent</span>;
    return (
      <span
        className="chip"
        style={{ marginLeft: 0 }}
        title={`${record.provider} does not report cost`}
      >
        no cost from {record.provider}
      </span>
    );
  }
  return cost.basis === "subscription-estimate" ? (
    <span title="list-price estimate; covered by the subscription">≈{usd(cost.usd)}</span>
  ) : (
    <span>{usd(cost.usd)}</span>
  );
}

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function SevenDayChart() {
  const days: { label: string; counts: Record<Outcome, number> }[] = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - i);
    const end = start.getTime() + 86_400_000;
    const counts: Record<Outcome, number> = {
      completed: 0,
      failed: 0,
      "timed-out": 0,
      abandoned: 0,
    };
    for (const record of RECORDS) {
      const t = Date.parse(record.startedAt);
      if (t >= start.getTime() && t < end) counts[record.outcome] += 1;
    }
    days.push({ label: start.toLocaleDateString(undefined, { weekday: "short" }), counts });
  }
  const max = Math.max(...days.map((d) => Object.values(d.counts).reduce((a, b) => a + b, 0)), 1);
  const h = (n: number): string => `${(n / max) * 80}px`;
  return (
    <>
      <div className="ph-chart">
        {days.map((day) => (
          <div key={day.label} className="ph-col" title={JSON.stringify(day.counts)}>
            <span className="ph-ok" style={{ height: h(day.counts.completed) }} />
            <span className="ph-failc" style={{ height: h(day.counts.failed) }} />
            <span className="ph-to" style={{ height: h(day.counts["timed-out"]) }} />
            <span className="ph-ab" style={{ height: h(day.counts.abandoned) }} />
          </div>
        ))}
      </div>
      <div className="ph-days">
        {days.map((day) => (
          <span key={day.label}>{day.label}</span>
        ))}
      </div>
    </>
  );
}

function FeedItem({ record, onOpen }: { record: UnitRecord; onOpen: () => void }) {
  return (
    <div className="ph-item" onClick={onOpen}>
      <span className="muted">
        {new Date(record.startedAt).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <span>
        {record.title}{" "}
        <span className="muted mono" style={{ fontSize: 11 }}>
          {record.pipeline} · {record.unit.kind} {record.unit.id}
        </span>
      </span>
      <span>
        <OutcomeChip record={record} />
      </span>
      <span>{costC(record)}</span>
    </div>
  );
}

export function UnitDrawer({
  record,
  onClose,
  cost,
}: {
  record: UnitRecord;
  onClose: () => void;
  cost: (r: UnitRecord, run?: number) => ReactNode;
}) {
  return (
    <aside className="ph-drawer">
      <button type="button" className="chip" style={{ float: "right" }} onClick={onClose}>
        close
      </button>
      <h2 style={{ marginTop: 0 }}>{record.title}</h2>
      <p>
        <OutcomeChip record={record} /> <span className="muted">{ageOf(record.startedAt)}</span>
        <span style={{ marginLeft: 10 }}>{cost(record)}</span>
      </p>
      <UnitFacts record={record} />
      <h3>Agent runs</h3>
      <AgentRunsTable record={record} cost={cost} />
    </aside>
  );
}

export function VariantC({ onAll }: { onAll?: () => void }) {
  const [open, setOpen] = useState<UnitRecord | null>(null);
  const [all, setAll] = useState(false);
  const d7 = summarize(RECORDS).d7;
  const week = RECORDS.filter(
    (record) => Date.now() - Date.parse(record.startedAt) <= 7 * 86_400_000,
  );
  const attention = week.filter((record) => record.outcome !== "completed");
  const feed = all ? RECORDS : week;
  const byDay = new Map<string, UnitRecord[]>();
  for (const record of feed) {
    const key = dayKey(record.startedAt);
    byDay.set(key, [...(byDay.get(key) ?? []), record]);
  }
  return (
    <section>
      <div className="ph-tile" style={{ marginBottom: 16 }}>
        <h3>Last 7 days</h3>
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
          <div>
            <div className="ph-big">{usd(d7.costUsd.api)}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              billed to the API key
            </div>
          </div>
          <div>
            <div className="ph-big">≈{usd(d7.costUsd.estimate)}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              list-price estimate, under a subscription
            </div>
          </div>
          <div>
            <div className="ph-big">{d7.units}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              units, {d7.unitsWithoutCost} without a cost
            </div>
          </div>
          <div>
            <div className="ph-big" style={{ color: "var(--fail)" }}>
              {attention.length}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              did not complete
            </div>
          </div>
        </div>
        <SevenDayChart />
      </div>

      <h2>Needs a look</h2>
      <div className="ph-feed">
        {attention.length === 0 ? (
          <p className="muted">Every unit this week completed.</p>
        ) : (
          (onAll === undefined ? attention : attention.slice(0, 6)).map((record) => (
            <FeedItem
              key={`${record.unit.id}@${record.startedAt}`}
              record={record}
              onOpen={() => setOpen(record)}
            />
          ))
        )}
      </div>

      {onAll === undefined ? null : (
        <p>
          <button type="button" className="chip" style={{ marginLeft: 0 }} onClick={onAll}>
            {attention.length > 6
              ? `${attention.length - 6} more, and every unit, in the history tab →`
              : "every unit, in the history tab →"}
          </button>
        </p>
      )}
      <h2 style={{ marginTop: 22, display: onAll === undefined ? undefined : "none" }}>
        Units{" "}
        <button type="button" className="chip" onClick={() => setAll(!all)}>
          {all ? "this week only" : "everything held"}
        </button>
      </h2>
      <div className="ph-feed" style={{ display: onAll === undefined ? undefined : "none" }}>
        {[...byDay.entries()].map(([day, records]) => (
          <div key={day}>
            <h4>
              {day} · {records.length} units
            </h4>
            {records.map((record) => (
              <FeedItem
                key={`${record.unit.id}@${record.startedAt}`}
                record={record}
                onOpen={() => setOpen(record)}
              />
            ))}
          </div>
        ))}
      </div>

      {open === null ? null : (
        <UnitDrawer record={open} onClose={() => setOpen(null)} cost={costC} />
      )}
    </section>
  );
}

// ── variant D: the combination ─────────────────────────────────────────────

/** The real pipelines table, each row expandable into variant B's breakdown. */
export function PipelinesExpandable() {
  const [open, setOpen] = useState<string | null>(cellsOfHistory()[0] ?? null);
  return (
    <section>
      <h2>Pipelines</h2>
      <table className="rows">
        <thead>
          <tr>
            <th>Pipeline</th>
            <th>State</th>
            <th>Child</th>
            <th>7d units</th>
            <th>did not complete</th>
            <th>7d cost</th>
          </tr>
        </thead>
        <tbody>
          {cellsOfHistory().map((cell) => {
            const d7 = summarize(filterRecords({ cell })).d7;
            const bad = d7.byOutcome.failed + d7.byOutcome["timed-out"] + d7.byOutcome.abandoned;
            const name = cell.split("#")[1] ?? cell;
            return [
              <tr
                key={cell}
                className="ph-row"
                onClick={() => setOpen(open === cell ? null : cell)}
              >
                <td>
                  {open === cell ? "▾" : "▸"} {name}
                </td>
                <td>{name === "work" ? "working 1/2" : "idle"}</td>
                <td>running</td>
                <td>{d7.units}</td>
                <td>
                  {bad === 0 ? (
                    <span className="muted">0</span>
                  ) : (
                    <span className="chip fail">{bad}</span>
                  )}
                </td>
                <td>
                  {d7.costUsd.api > 0 ? usd(d7.costUsd.api) : null}
                  {d7.costUsd.estimate > 0 ? (
                    <span className="ph-est"> + {usd(d7.costUsd.estimate)} est.</span>
                  ) : null}
                  {d7.costUsd.api + d7.costUsd.estimate === 0 ? (
                    <span className="muted">tokens only</span>
                  ) : null}
                </td>
              </tr>,
              open === cell ? (
                <tr key={`${cell}-open`} className="ph-detail">
                  <td colSpan={6}>
                    <PipelineBlock cell={cell} bare />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </section>
  );
}

type DeploymentTotals = {
  name: string;
  route: string;
  window: Window | null;
  note?: string;
};

/** The stats button at the rail's foot and its popover: totals across deployments. */
export function RailStats() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const later = (fn: () => void, ms: number): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  // Opens after half a second of hover; closes 300 ms after the pointer has
  // left both the button and the card, so it can travel from one to the other.
  const enter = (): void => later(() => setOpen(true), open ? 0 : 500);
  const leave = (): void => later(() => setOpen(false), 300);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const [range, setRange] = useState<"h24" | "d7">("d7");
  const summary = summarize(RECORDS);
  const rows: DeploymentTotals[] = [
    { name: "youtube-studio", route: "this machine", window: summary[range] },
    {
      name: "partner-site",
      route: "partner-site.tail4f2c.ts.net",
      window: null,
      note: "runs 0.12, too old to report history",
    },
  ];
  const known = rows.flatMap((row) => (row.window === null ? [] : [row.window]));
  const total = (pick: (w: Window) => number): number => known.reduce((sum, w) => sum + pick(w), 0);
  const bad = (w: Window): number =>
    w.byOutcome.failed + w.byOutcome["timed-out"] + w.byOutcome.abandoned;
  return (
    <>
      <button
        type="button"
        className="rail-settings"
        aria-label="Stats"
        title="Units and cost across every deployment"
        onClick={() => {
          setOpen(false);
          location.hash = STATS_HASH;
        }}
        onMouseEnter={enter}
        onMouseLeave={leave}
        style={{
          border: 0,
          padding: 0,
          background: open ? "var(--chip)" : "transparent",
          cursor: "pointer",
        }}
      >
        <ChartNoAxesColumn size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          onMouseEnter={enter}
          onMouseLeave={leave}
          style={{
            position: "fixed",
            left: 12,
            bottom: 52,
            width: 420,
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            boxShadow: "0 8px 28px rgba(0,0,0,.25)",
            padding: "12px 14px",
            zIndex: 950,
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <strong>Every deployment</strong>
            <span style={{ marginLeft: "auto" }}>
              <button
                type="button"
                className={range === "h24" ? "chip warn" : "chip"}
                onClick={() => setRange("h24")}
              >
                24h
              </button>
              <button
                type="button"
                className={range === "d7" ? "chip warn" : "chip"}
                onClick={() => setRange("d7")}
              >
                7d
              </button>
            </span>
          </div>
          <div style={{ display: "flex", gap: 22, margin: "10px 0" }}>
            <div>
              <div className="ph-big">{usd(total((w) => w.costUsd.api))}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                API spend
              </div>
            </div>
            <div>
              <div className="ph-big ph-est">≈{usd(total((w) => w.costUsd.estimate))}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                subscription estimate
              </div>
            </div>
            <div>
              <div className="ph-big">{total((w) => w.units)}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                units
              </div>
            </div>
            <div>
              <div className="ph-big" style={{ color: "var(--fail)" }}>
                {total(bad)}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                did not complete
              </div>
            </div>
          </div>
          <table className="rows">
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td>
                    {row.name}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {row.route}
                    </div>
                  </td>
                  {row.window === null ? (
                    <td colSpan={3} className="muted">
                      {row.note}
                    </td>
                  ) : (
                    <>
                      <td>{row.window.units} units</td>
                      <td>
                        {bad(row.window) === 0 ? (
                          "0"
                        ) : (
                          <span className="chip fail">{bad(row.window)}</span>
                        )}
                      </td>
                      <td>
                        {usd(row.window.costUsd.api)}
                        <span className="ph-est"> + {usd(row.window.costUsd.estimate)} est.</span>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
            Summed by the companion from each deployment&apos;s report. A deployment with no history
            is left out of the totals, not counted as zero. Click the icon for the full overview.
          </p>
        </div>
      ) : null}
    </>
  );
}

// ── variant D: the fleet stats page the button opens ───────────────────────

export const STATS_HASH = "#/prototype-stats";

/** True while the stats page is up: the hash is the prototype's own. */
export function useStatsOpen(): boolean {
  const [open, setOpen] = useState(() => location.hash === STATS_HASH);
  useEffect(() => {
    const on = (): void => setOpen(location.hash === STATS_HASH);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return open;
}

export function FleetStatsPage() {
  const [range, setRange] = useState<"h24" | "d7">("d7");
  const [drawn, setDrawn] = useState<UnitRecord | null>(null);
  const span = range === "h24" ? 86_400_000 : 7 * 86_400_000;
  const inRange = RECORDS.filter((record) => Date.now() - Date.parse(record.startedAt) <= span);
  const w = summarize(RECORDS)[range];
  const bad = w.byOutcome.failed + w.byOutcome["timed-out"] + w.byOutcome.abandoned;
  const priciest = [...inRange]
    .filter((record) => costOf(record).usd !== null)
    .sort((a, b) => (costOf(b).usd ?? 0) - (costOf(a).usd ?? 0))
    .slice(0, 5);
  const models = MODELS.map((model) => ({
    model,
    window: summarize(inRange.filter((record) => record.model === model))[range],
  })).filter((row) => row.window.units > 0);
  return (
    <main className="main">
      <div className="page-body">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h1 style={{ margin: 0 }}>Every deployment</h1>
          <span style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className={range === "h24" ? "chip warn" : "chip"}
              onClick={() => setRange("h24")}
            >
              last 24 hours
            </button>
            <button
              type="button"
              className={range === "d7" ? "chip warn" : "chip"}
              onClick={() => setRange("d7")}
            >
              last 7 days
            </button>
          </span>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          Summed by the companion from each deployment&apos;s report. partner-site runs 0.12, which
          reports no history, so it is left out rather than counted as zero.
        </p>

        <div className="ph-tiles">
          <div className="ph-tile">
            <h3>API spend</h3>
            <div className="ph-big">{usd(w.costUsd.api)}</div>
          </div>
          <div className="ph-tile">
            <h3>Subscription estimate</h3>
            <div className="ph-big ph-est">≈{usd(w.costUsd.estimate)}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              list price, not billed
            </div>
          </div>
          <div className="ph-tile">
            <h3>Units</h3>
            <div className="ph-big">{w.units}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {w.unitsWithoutCost} with no cost reported · {w.usageIncomplete} partial
            </div>
          </div>
          <div className="ph-tile">
            <h3>Did not complete</h3>
            <div className="ph-big" style={{ color: "var(--fail)" }}>
              {bad}
            </div>
            <div style={{ marginTop: 6 }}>
              <OutcomeBar window={w} />
            </div>
          </div>
        </div>

        {range === "d7" ? (
          <>
            <h2>Units per day</h2>
            <SevenDayChart />
          </>
        ) : null}

        <h2 style={{ marginTop: 22 }}>By deployment</h2>
        <table className="rows">
          <thead>
            <tr>
              <th>deployment</th>
              <th>units</th>
              <th>did not complete</th>
              <th>API</th>
              <th>estimate</th>
              <th>tokens in / out</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                youtube-studio{" "}
                <div className="muted" style={{ fontSize: 11 }}>
                  this machine
                </div>
              </td>
              <td>{w.units}</td>
              <td>{bad === 0 ? "0" : <span className="chip fail">{bad}</span>}</td>
              <td>{usd(w.costUsd.api)}</td>
              <td className="ph-est">≈{usd(w.costUsd.estimate)}</td>
              <td>
                {compact(w.tokens.input)} / {compact(w.tokens.output)}
              </td>
            </tr>
            <tr>
              <td>
                partner-site{" "}
                <div className="muted" style={{ fontSize: 11 }}>
                  partner-site.tail4f2c.ts.net
                </div>
              </td>
              <td colSpan={5} className="muted">
                runs 0.12, too old to report history
              </td>
            </tr>
          </tbody>
        </table>

        <h2 style={{ marginTop: 22 }}>By model</h2>
        <table className="rows">
          <thead>
            <tr>
              <th>model</th>
              <th>units</th>
              <th>did not complete</th>
              <th>cost</th>
              <th>tokens in / out</th>
            </tr>
          </thead>
          <tbody>
            {models.map(({ model, window: m }) => {
              const mb = m.byOutcome.failed + m.byOutcome["timed-out"] + m.byOutcome.abandoned;
              return (
                <tr key={model}>
                  <td className="mono">{model}</td>
                  <td>{m.units}</td>
                  <td>{mb === 0 ? "0" : <span className="chip fail">{mb}</span>}</td>
                  <td>
                    {m.costUsd.api > 0 ? usd(m.costUsd.api) : null}
                    {m.costUsd.estimate > 0 ? (
                      <span className="ph-est">≈{usd(m.costUsd.estimate)}</span>
                    ) : null}
                    {m.costUsd.api + m.costUsd.estimate === 0 ? (
                      <span className="muted">tokens only</span>
                    ) : null}
                  </td>
                  <td>
                    {compact(m.tokens.input)} / {compact(m.tokens.output)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h2 style={{ marginTop: 22 }}>Most expensive units</h2>
        <div className="ph-feed">
          {priciest.map((record) => (
            <FeedItem
              key={`${record.unit.id}@${record.startedAt}`}
              record={record}
              onOpen={() => setDrawn(record)}
            />
          ))}
        </div>
        {drawn === null ? null : (
          <UnitDrawer record={drawn} onClose={() => setDrawn(null)} cost={costC} />
        )}
      </div>
    </main>
  );
}
