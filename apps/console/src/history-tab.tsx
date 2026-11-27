// The History tab (#931): one deployment's unit records, newest first, with
// filters for pipeline, kind, outcome and model, and a drawer for one unit.
// Variant D of the #919 prototype: the tab's table, and a side drawer rather
// than a row that opens in place.
//
// Records are fetched on demand, a page at a time, through the reader the
// deployment page hands down (history.ts). Every filter change asks again; the
// tab never narrows a page it already holds. "Show more" asks for the page
// after the last one, under the same filters.
//
// A deployment with a tenant that declares the observer has a "Run observer"
// button in the header (#938, run-observer.tsx). The run it starts lands here
// like any unit; the tab asks again when the report shows it settled, and the
// drawer links every `#N` in a unit's summary to the tenant's repo.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AgentRunRecord,
  FleetCell,
  HistoryPage,
  HistoryRecord,
  HistoryTotals,
  UnitRecordOutcome,
} from "phoebe-agent/contracts";
import { age, duration } from "./facts.ts";
import {
  API_COST_NOTE,
  compactCount,
  ESTIMATE_NOTE,
  filterChoices,
  NO_CHOICES,
  withChoicesOf,
  githubHref,
  HISTORY_OUTCOMES,
  historyQueryOf,
  recordKey,
  repoOf,
  retainedSince,
  runCost,
  unitCost,
  unfinishedOf,
  unitLabel,
  unitTokens,
  usd,
  type CostView,
  type FilterChoices,
  type HistoryFetch,
  type HistoryFilters,
  type HistoryReader,
} from "./history.ts";
import { summaryPieces, type ObserveRunner, type ObserverTarget } from "./observer.ts";
import { RunObserver } from "./run-observer.tsx";

type Loaded = {
  records: HistoryRecord[];
  summary: HistoryTotals;
  nextBefore: string | null;
  retained: HistoryPage["retained"];
};

type TabState =
  | { kind: "loading" }
  | { kind: "loaded"; loaded: Loaded }
  | { kind: "too-old" }
  | { kind: "failed"; message: string };

export function HistoryTab({
  reader,
  scope,
  cells,
  now,
  observer,
}: {
  /** How this deployment's pages are read: the arm's own. */
  reader: HistoryReader;
  /**
   * What the reader reads, as a stable string. The reader itself may be a new
   * function on every render; the tab asks again only when this or a filter moves.
   */
  scope: string;
  /** The report's cells, for the pipeline filter. */
  cells: readonly FleetCell[];
  now: Date;
  /**
   * The tenants that declare the observer, and how this arm starts a run
   * (#938). Without it, or with no targets, the header has no button.
   */
  observer?: { targets: readonly ObserverTarget[]; run: ObserveRunner };
}) {
  const [filters, setFilters] = useState<HistoryFilters>({});
  const [state, setState] = useState<TabState>({ kind: "loading" });
  const [more, setMore] = useState<{ busy: boolean; trouble: string | null }>({
    busy: false,
    trouble: null,
  });
  const [seen, setSeen] = useState<FilterChoices>(NO_CHOICES);
  const [open, setOpen] = useState<HistoryRecord | null>(null);
  const [attempt, setAttempt] = useState(0);
  const readerRef = useRef(reader);
  readerRef.current = reader;
  // Each ask carries a number, and only the latest one's answer is drawn: a
  // slow page for the old filters must not land over the new filters' page.
  const asked = useRef(0);

  /**
   * Ask for one page and draw what came back, unless a newer ask has been made
   * since. `after` is the page this one extends; without it the page replaces
   * what was drawn.
   */
  const ask = (after: Loaded | null): void => {
    const asking = after === null ? ++asked.current : asked.current;
    const current = (): boolean => asking === asked.current;
    if (after === null) setState({ kind: "loading" });
    setMore({ busy: after !== null, trouble: null });
    readerRef.current(historyQueryOf(filters, after?.nextBefore ?? undefined)).then(
      (fetched: HistoryFetch) => {
        if (!current()) return;
        setMore({ busy: false, trouble: null });
        if (fetched.kind === "too-old") {
          setState({ kind: "too-old" });
          return;
        }
        const page = fetched.page;
        setState({
          kind: "loaded",
          loaded: {
            records: after === null ? page.records : [...after.records, ...page.records],
            summary: page.summary,
            nextBefore: page.nextBefore,
            retained: page.retained,
          },
        });
        setSeen((before) => withChoicesOf(before, page.records));
      },
      (error: unknown) => {
        if (!current()) return;
        if (after === null) setState({ kind: "failed", message: messageOf(error) });
        else setMore({ busy: false, trouble: messageOf(error) });
      },
    );
  };

  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    ask(null);
    // `filters` is read through `filterKey`, which is what moves; `ask` reads
    // the reader through a ref, so a new reader on a render asks nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, filterKey, attempt]);

  const set = (key: keyof HistoryFilters, value: string): void => {
    setFilters((previous) => {
      const next: HistoryFilters = { ...previous };
      if (value === "") delete next[key];
      else (next as Record<string, string>)[key] = value;
      return next;
    });
  };

  if (state.kind === "too-old") {
    return (
      <section>
        <h2>History</h2>
        <p className="notice" role="status">
          This deployment is too old to keep unit history. Its phoebe-agent predates{" "}
          <code>phoebe history</code>, so there is nothing to list, not an empty week. Upgrade it,
          and the units it runs from then on show here.
        </p>
      </section>
    );
  }

  const choices = filterChoices(seen, filters);
  const head =
    observer === undefined || observer.targets.length === 0 ? (
      <h2>History</h2>
    ) : (
      <div className="history-head">
        <h2>History</h2>
        <RunObserver
          targets={observer.targets}
          run={observer.run}
          now={now}
          onSettled={() => setAttempt((n) => n + 1)}
        />
      </div>
    );
  const tenants = new Set(cells.map((cell) => cell.tenant.id));
  const pipelineName = (cell: FleetCell): string =>
    tenants.size > 1 ? `${cell.tenant.slug ?? cell.tenant.path} ${cell.pipeline}` : cell.pipeline;

  return (
    <section className="history">
      {head}
      <div className="history-filters" role="group" aria-label="Filter the units">
        <select
          aria-label="Pipeline"
          value={filters.cell ?? ""}
          onChange={(event) => set("cell", event.target.value)}
        >
          <option value="">every pipeline</option>
          {cells.map((cell) => (
            <option key={cell.id} value={cell.id}>
              {pipelineName(cell)}
            </option>
          ))}
        </select>
        <select
          aria-label="Work kind"
          value={filters.kind ?? ""}
          onChange={(event) => set("kind", event.target.value)}
        >
          <option value="">every kind</option>
          {choices.kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <select
          aria-label="Outcome"
          value={filters.outcome ?? ""}
          onChange={(event) => set("outcome", event.target.value)}
        >
          <option value="">every outcome</option>
          {HISTORY_OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {outcome}
            </option>
          ))}
        </select>
        <select
          aria-label="Model"
          value={filters.model ?? ""}
          onChange={(event) => set("model", event.target.value)}
        >
          <option value="">every model</option>
          {choices.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </div>

      {state.kind === "loading" ? (
        <p className="muted">Reading history…</p>
      ) : state.kind === "failed" ? (
        <p className="refusal">
          Could not read history: {state.message}{" "}
          <button type="button" className="quiet" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : (
        <Records
          loaded={state.loaded}
          filtered={Object.keys(filters).length > 0}
          showTenant={tenants.size > 1}
          now={now}
          more={more}
          onMore={() => ask(state.loaded)}
          onOpen={setOpen}
        />
      )}

      {open === null ? null : (
        <UnitDrawer
          record={open}
          now={now}
          showTenant={tenants.size > 1}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

function Records({
  loaded,
  filtered,
  showTenant,
  now,
  more,
  onMore,
  onOpen,
}: {
  loaded: Loaded;
  filtered: boolean;
  showTenant: boolean;
  now: Date;
  more: { busy: boolean; trouble: string | null };
  onMore: () => void;
  onOpen: (record: HistoryRecord) => void;
}) {
  const since = retainedSince(loaded);
  return (
    <>
      <p className="muted history-summary">
        <Totals totals={loaded.summary} />
      </p>
      {loaded.records.length === 0 ? (
        <p className="muted">
          {filtered ? "No units match these filters." : "No units recorded yet."}
        </p>
      ) : (
        <table className="rows history-rows">
          <thead>
            <tr>
              <th>Started</th>
              <th>Pipeline</th>
              <th>Unit</th>
              <th>Outcome</th>
              <th>Model</th>
              <th>Took</th>
              <th>Cost</th>
              <th>Tokens in / out</th>
            </tr>
          </thead>
          <tbody>
            {loaded.records.map((record) => {
              const tokens = unitTokens(record);
              return (
                <tr key={recordKey(record)} className="history-row" onClick={() => onOpen(record)}>
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
                        onOpen(record);
                      }}
                    >
                      <span className="mono">{record.unit.kind}</span> {unitLabel(record)}
                    </button>
                  </td>
                  <td>
                    <OutcomeChip record={record} />
                  </td>
                  <td className="mono">{record.model ?? "—"}</td>
                  <td>{record.durationMs === null ? "—" : duration(record.durationMs)}</td>
                  <td>
                    <Cost view={unitCost(record)} />
                  </td>
                  <td>
                    {compactCount(tokens.input)} / {compactCount(tokens.output)}
                    {tokens.partial ? <PartialChip /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted history-foot">
        {loaded.nextBefore === null ? null : (
          <>
            <button type="button" disabled={more.busy} onClick={onMore}>
              {more.busy ? "Reading…" : "Show more"}
            </button>{" "}
          </>
        )}
        {more.trouble === null ? null : (
          <span className="refusal">Could not read more: {more.trouble} </span>
        )}
        {since === null ? null : (
          <>
            This deployment holds units back to {new Date(since).toLocaleDateString()}. Older ones
            have rotated out.
          </>
        )}
      </p>
    </>
  );
}

/** The matched totals in one line: counts, then cost by basis, never added together. */
function Totals({ totals }: { totals: HistoryTotals }) {
  const unfinished = unfinishedOf(totals.byOutcome);
  const parts: ReactNode[] = [`${totals.units} unit${totals.units === 1 ? "" : "s"} match`];
  if (unfinished > 0) parts.push(`${unfinished} did not complete`);
  if (totals.costUsd.api > 0) {
    parts.push(
      <span key="api" title={API_COST_NOTE}>
        {usd(totals.costUsd.api)} API spend
      </span>,
    );
  }
  if (totals.costUsd.subscriptionEstimate > 0) {
    parts.push(
      <span key="est" title={ESTIMATE_NOTE}>
        {usd(totals.costUsd.subscriptionEstimate)} <span className="est">est.</span> on a
        subscription
      </span>,
    );
  }
  if (totals.unitsWithoutCost > 0) parts.push(`${totals.unitsWithoutCost} with no cost reported`);
  if (totals.unitsWithPartialUsage > 0) {
    parts.push(`${totals.unitsWithPartialUsage} with partial usage`);
  }
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index === 0 ? null : " · "}
          {part}
        </span>
      ))}
    </>
  );
}

const OUTCOME_TONE: Record<UnitRecordOutcome, string> = {
  completed: "chip ok",
  unproductive: "chip warn",
  failed: "chip fail",
  "timed-out": "chip warn",
  abandoned: "chip",
};

export function OutcomeChip({ record }: { record: HistoryRecord }) {
  return (
    <>
      <span className={`${OUTCOME_TONE[record.outcome]} outcome-chip`}>{record.outcome}</span>
      {record.quarantined ? <span className="chip warn">quarantined</span> : null}
    </>
  );
}

function PartialChip() {
  return (
    <span
      className="chip warn"
      title="The run ended before it reported its usage, so these numbers are a lower bound."
    >
      partial
    </span>
  );
}

/** A cost as #919 decided it reads, each kind with the line that says which it is. */
export function Cost({ view }: { view: CostView }) {
  if (view.kind === "none") {
    return (
      <span className="muted cost-none" title={view.why}>
        —
      </span>
    );
  }
  return (
    <>
      {view.api === null ? null : <span title={API_COST_NOTE}>{usd(view.api)}</span>}
      {view.api !== null && view.estimate !== null ? " + " : null}
      {view.estimate === null ? null : (
        <span title={ESTIMATE_NOTE}>
          {usd(view.estimate)} <span className="est">est.</span>
        </span>
      )}
    </>
  );
}

/** One unit, drawn over the right edge of the page. Escape or the button closes it. */
export function UnitDrawer({
  record,
  now,
  showTenant,
  onClose,
}: {
  record: HistoryRecord;
  now: Date;
  showTenant: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const href = githubHref(record);
  const tokens = unitTokens(record);
  const title = `${record.unit.kind} ${unitLabel(record)}`;
  return (
    <aside className="unit-drawer" role="dialog" aria-label={title}>
      <button type="button" ref={closeRef} className="quiet unit-drawer-close" onClick={onClose}>
        Close
      </button>
      <h2>{title}</h2>
      <p>
        <OutcomeChip record={record} />{" "}
        <span className="muted" title={record.startedAt}>
          started {age(record.startedAt, now)} ago
        </span>{" "}
        · <Cost view={unitCost(record)} />
      </p>
      {record.detail === null ? null : (
        <p className="unit-detail">
          <Summary text={record.detail} repo={repoOf(record)} />
        </p>
      )}
      <dl className="pairs">
        <dt>On GitHub</dt>
        <dd>
          {href === null ? (
            <span className="muted">no issue or PR</span>
          ) : (
            <a href={href} target="_blank" rel="noreferrer">
              {href.replace("https://github.com/", "")}
            </a>
          )}
        </dd>
        <dt>Pipeline</dt>
        <dd>{showTenant ? `${record.tenant} ${record.pipeline}` : record.pipeline}</dd>
        <dt>Provider</dt>
        <dd>
          {record.provider ?? "unknown"}
          {record.model === null ? null : (
            <>
              {" · "}
              <span className="mono">{record.model}</span>
            </>
          )}
        </dd>
        <dt>Effort</dt>
        <dd>{record.effort ?? "default"}</dd>
        <dt>Duration</dt>
        <dd>
          {record.durationMs === null ? "did not settle" : duration(record.durationMs)}
          {record.runBudgetMs === null ? null : (
            <span className="muted"> of a {duration(record.runBudgetMs)} budget</span>
          )}
        </dd>
        <dt>Tokens</dt>
        <dd>
          {compactCount(tokens.input)} in · {compactCount(tokens.output)} out ·{" "}
          {compactCount(tokens.cacheRead)} cache read · {compactCount(tokens.cacheWrite)} cache
          write
          {tokens.partial ? <PartialChip /> : null}
        </dd>
        {record.branch === null ? null : (
          <>
            <dt>Branch</dt>
            <dd className="mono">{record.branch}</dd>
          </>
        )}
        {record.engineCommit === null ? null : (
          <>
            <dt>Engine</dt>
            <dd className="mono">{record.engineCommit.slice(0, 12)}</dd>
          </>
        )}
      </dl>
      <h3>Agent runs</h3>
      <AgentRuns record={record} />
    </aside>
  );
}

/**
 * A unit's summary with each `#N` a link into the repo. `/issues/N` serves a
 * PR too, since GitHub redirects it. Without a repo the text stands as it is.
 */
function Summary({ text, repo }: { text: string; repo: string | null }) {
  if (repo === null) return <>{text}</>;
  return (
    <>
      {summaryPieces(text).map((piece, index) =>
        "text" in piece ? (
          <span key={index}>{piece.text}</span>
        ) : (
          <a
            key={index}
            href={`https://github.com/${repo}/issues/${piece.ref}`}
            target="_blank"
            rel="noreferrer"
          >
            #{piece.ref}
          </a>
        ),
      )}
    </>
  );
}

function AgentRuns({ record }: { record: HistoryRecord }) {
  if (record.agentRuns.length === 0) {
    return (
      <p className="muted">
        {record.outcome === "abandoned"
          ? "No agent runs were recorded: the process ended before the unit settled."
          : "No agent ran for this unit."}
      </p>
    );
  }
  return (
    <table className="rows">
      <thead>
        <tr>
          <th>#</th>
          <th>Took</th>
          <th>Exit</th>
          <th>Cost</th>
          <th>Tokens in / out</th>
          <th>Cache read</th>
          <th>Turns</th>
        </tr>
      </thead>
      <tbody>
        {record.agentRuns.map((run: AgentRunRecord, index) => (
          <tr key={`${run.startedAt}-${index}`}>
            <td>{index + 1}</td>
            <td>{duration(run.durationMs)}</td>
            <td>{run.exitCode ?? "—"}</td>
            <td>
              <Cost view={runCost(record, run)} />
            </td>
            <td>
              {compactCount(run.inputTokens)} / {compactCount(run.outputTokens)}
              {run.usageComplete ? null : <PartialChip />}
            </td>
            <td>{compactCount(run.cacheReadTokens)}</td>
            <td>{run.turns ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
