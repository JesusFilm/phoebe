// The six tabs one deployment has, rendered (#509, #526, #556, #931).
//
// Every component here takes a narrowed report and a connection card and draws
// them. None of them knows whether the report came off a relay's stream or out
// of a container on this machine over the desktop bridge, which is the point:
// the local read loop emits the relay's own `report` event, so there is one set
// of tabs and no arm to branch on.
//
// The connection card is the single exception, and it has to be. "Connected for
// three hours" under a fingerprint and "the container on this machine is up" are
// different facts an operator acts on differently, so the page that knows which
// arm it is builds the card and passes it down.
//
// What a tab does with nothing is as designed as what it does with a report. A
// deployment with no readable report has five tabs that say what they need and
// one — config — that still works, because config is a file and a file is
// readable with nothing running (#526).
//
// The write affordances come in the same way the connection card does: as
// something the page that knows its arm hands down (`writes`). What a local
// install offers is a form that writes this machine; what a remote one offers is
// the same edit sealed and sent. The **receipt** those two produce is one shape
// and renders through one component here (#527 §11, §16), so a refusal reads the
// same either way — which is the point of the fingerprint being on both arms.

import { useState, type ReactNode } from "react";
import type { EditReceipt } from "phoebe-agent/contracts";
import { age } from "./facts.ts";
import { NeedsALook, PipelineBreakdown, PipelineWeek, WeekCard } from "./history-glance.tsx";
import { spendViewOf } from "./spend.ts";
import { HistoryTab } from "./history-tab.tsx";
import type { HistoryReader } from "./history.ts";
import { observerTargetsOf, type ObserveRunner } from "./observer.ts";
import {
  bootstrapperOf,
  cellsOf,
  childrenOf,
  fleetHistoryOf,
  historyOf,
  tenantsOf,
  type ReportReading,
} from "./report.ts";
import type { ConfigReading, ConnectionCard, DeploymentTab } from "./tabs.ts";

export function DeploymentTabPanel({
  tab,
  reading,
  connection,
  config,
  now,
  empty,
  writes = {},
  overview,
  history,
  onTab,
  frozen = false,
}: {
  tab: DeploymentTab;
  reading: ReportReading;
  connection: ConnectionCard;
  /** The config this arm can read, or null when it has not been read yet. */
  config: ConfigReading | null;
  now: Date;
  /** What to say on a tab with no report — the arm's own words. */
  empty: ReactNode;
  /**
   * What this arm lets an operator change, drawn under the tab it belongs to.
   * `doctor` is the run-doctor control, where the arm has one.
   */
  writes?: { config?: ReactNode; secrets?: ReactNode; doctor?: ReactNode };
  /** Drawn under the overview's cards: the Devices panel (map #690). */
  overview?: ReactNode;
  /**
   * How this arm reads unit history (#931), and a stable name for what it
   * reads. Without it the History tab says this page cannot read history.
   * `observe` is how it starts an observer run (#938); the tab's button shows
   * only with it, and only for a tenant the report says declares the observer.
   */
  history?: { reader: HistoryReader; scope: string; observe?: ObserveRunner };
  /** Switches the page to another tab: the overview's feed links to the History tab. */
  onTab?: (tab: DeploymentTab) => void;
  /** The report is the last one received, not a current one: grey it (map #690). */
  frozen?: boolean;
}) {
  if (tab === "config") return <ConfigTab config={config} writes={writes.config} />;
  if (tab === "history" && history !== undefined) {
    const records = (
      <HistoryTab
        reader={history.reader}
        scope={history.scope}
        cells={reading.kind === "read" ? cellsOf(reading.report) : []}
        now={now}
        {...(history.observe === undefined || reading.kind !== "read"
          ? {}
          : {
              observer: {
                targets: observerTargetsOf(reading.report),
                run: history.observe,
              },
            })}
      />
    );
    return frozen && reading.kind === "read" ? <div className="greyed">{records}</div> : records;
  }
  if (reading.kind !== "read") {
    return (
      <section>
        <h2>{TAB_HEADINGS[tab]}</h2>
        {reading.kind === "unreadable" ? (
          <p className="refusal">
            This report is stamped schema {reading.schema}, which this console does not know how to
            read. Nothing below it would be true.
          </p>
        ) : (
          empty
        )}
      </section>
    );
  }
  const body = ((): ReactNode => {
    switch (tab) {
      case "overview":
        return (
          <>
            <OverviewHistory
              reading={reading}
              now={now}
              {...(history === undefined ? {} : { history })}
              {...(onTab === undefined ? {} : { onHistory: () => onTab("history") })}
            />
            <OverviewTab reading={reading} connection={connection} now={now} />
            {overview}
          </>
        );
      case "pipelines":
        return <PipelinesTab reading={reading} now={now} />;
      case "history":
        return history === undefined ? (
          <section>
            <h2>History</h2>
            <p className="muted">This page has no way to read this deployment's history.</p>
          </section>
        ) : (
          <HistoryTab
            reader={history.reader}
            scope={history.scope}
            cells={cellsOf(reading.report)}
            now={now}
            {...(history.observe === undefined
              ? {}
              : {
                  observer: {
                    targets: observerTargetsOf(reading.report),
                    run: history.observe,
                  },
                })}
          />
        );
      case "doctor":
        return <DoctorTab reading={reading} now={now} writes={writes.doctor} />;
      case "secrets":
        return <SecretsTab writes={writes.secrets} />;
    }
  })();
  return frozen ? <div className="greyed">{body}</div> : body;
}

const TAB_HEADINGS: Record<DeploymentTab, string> = {
  overview: "Overview",
  pipelines: "Pipelines",
  history: "History",
  doctor: "Doctor",
  secrets: "Secrets",
  config: "Config",
};

/**
 * The top of the overview (#932): the 7-day card off the report's summary, with
 * the spend limits beside its figures (#991), and under it the units that need a look, which is the one part that reads records.
 * A report with no summary gets the card's own word for that and no feed, since
 * a deployment that cannot sum its units cannot list them either.
 */
function OverviewHistory({
  reading,
  now,
  history,
  onHistory,
}: {
  reading: Extract<ReportReading, { kind: "read" }>;
  now: Date;
  history?: { reader: HistoryReader; scope: string };
  onHistory?: () => void;
}) {
  const summary = fleetHistoryOf(reading.report);
  return (
    <>
      <WeekCard summary={summary} now={now} spend={spendViewOf(reading.report)} />
      {summary === null || history === undefined ? null : (
        <NeedsALook
          reader={history.reader}
          scope={history.scope}
          asOf={summary.asOf}
          now={now}
          showTenant={tenantsOf(reading.report).length > 1}
          {...(onHistory === undefined ? {} : { onHistory })}
        />
      )}
    </>
  );
}

/**
 * The overview: where this deployment is reached, what engine it is running, and
 * where it stands with a relay. Under the history card, the connection card
 * comes first because it is the question an operator who just opened the page
 * is asking.
 */
function OverviewTab({
  reading,
  connection,
  now,
}: {
  reading: Extract<ReportReading, { kind: "read" }>;
  connection: ConnectionCard;
  now: Date;
}) {
  const report = reading.report;
  const bootstrapper = bootstrapperOf(report);
  const cells = cellsOf(report);
  const tenants = tenantsOf(report);
  const slots = bootstrapper?.slots ?? null;

  return (
    <>
      <section>
        <h2>Connection</h2>
        <p>
          <strong>{connection.arm}</strong> <span className="mono">{connection.detail}</span>
          {connection.link === undefined ? null : (
            <a
              className="chip route-chip"
              href={connection.link.href}
              title={connection.link.title}
            >
              {connection.link.text}
            </a>
          )}
        </p>
        <p className="muted">{connection.note}</p>
      </section>
      <section>
        <h2>Overview</h2>
        <dl className="pairs">
          <Pair label="Name" value={report.identity?.name ?? "unnamed"} />
          <Pair label="Arm" value={report.identity?.arm ?? "unknown"} />
          <Pair
            label="Engine"
            value={`${bootstrapper?.engineRef ?? "unknown ref"}${
              bootstrapper?.engineSha === null || bootstrapper?.engineSha === undefined
                ? ""
                : ` · ${bootstrapper.engineSha}`
            }`}
          />
          {bootstrapper?.quarantinedSha == null ? null : (
            <Pair
              label="Quarantined"
              value={`running away from ${bootstrapper.quarantinedSha} after a crash loop`}
            />
          )}
          <Pair
            label="Reconcile"
            value={
              bootstrapper?.reconcile?.phase === "reconciling"
                ? `relaunching the fleet, ${bootstrapper.reconcile.reason} moved`
                : "idle"
            }
          />
          {slots === null ? null : (
            <Pair
              label="Slots"
              value={`${slots.inUse}/${slots.capacity} in use, ${slots.waiting} waiting`}
            />
          )}
          <Pair
            label="Fleet"
            value={`${tenants.length} tenant(s), ${cells.length} pipeline(s)${
              bootstrapper?.stopped == null
                ? ""
                : ` · stopped by ${bootstrapper.stopped.by} ${age(bootstrapper.stopped.at, now)} ago`
            }`}
          />
          {bootstrapper?.telemetry == null ? null : (
            <>
              <dt>Telemetry</dt>
              <dd>
                {`OpenTelemetry: ${bootstrapper.telemetry.sent} sent, ${bootstrapper.telemetry.dropped} dropped${
                  bootstrapper.telemetry.lastSentAt === null
                    ? ""
                    : `, last sent ${age(bootstrapper.telemetry.lastSentAt, now)} ago`
                }`}
                {bootstrapper.telemetry.lastError === null ? null : (
                  <span className="chip warn" title={bootstrapper.telemetry.lastError}>
                    sends failing
                  </span>
                )}
              </dd>
            </>
          )}
          <Pair label="Report" value={`read ${age(reading.receivedAt, now)} ago`} />
        </dl>
      </section>
    </>
  );
}

/**
 * One row per (tenant × pipeline) cell — the same matrix the fleet page draws as
 * a bar, with the words spelled out. Every value is a fact the deployment
 * derived and wrote down (#501); nothing here is recomputed.
 *
 * Each row's last three columns are its unit history over 7 days, and the row
 * opens into the full breakdown the report carries for it (#932). The first
 * row arrives open.
 */
function PipelinesTab({
  reading,
  now,
}: {
  reading: Extract<ReportReading, { kind: "read" }>;
  now: Date;
}) {
  const cells = cellsOf(reading.report);
  const children = childrenOf(reading.report);
  // Null until the operator opens or closes a row: until then the first row is
  // open, whenever the cells arrive.
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const open = chosen ?? new Set(cells[0] === undefined ? [] : [cells[0].id]);
  const toggle = (id: string): void => {
    const after = new Set(open);
    if (after.has(id)) after.delete(id);
    else after.add(id);
    setChosen(after);
  };

  if (cells.length === 0) {
    return (
      <section>
        <h2>Pipelines</h2>
        <p className="muted">This deployment has enumerated no pipelines.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Pipelines</h2>
      <table className="rows">
        <thead>
          <tr>
            <th>Tenant</th>
            <th>Pipeline</th>
            <th>State</th>
            <th>Child</th>
            <th>Units, 7 days</th>
            <th>Did not complete</th>
            <th>Cost, 7 days</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => {
            const child = children.get(cell.id);
            const summary = historyOf(cell);
            const expanded = open.has(cell.id);
            const breakdown = `breakdown-${cell.id}`;
            return [
              <tr key={cell.id}>
                <td className="mono">{cell.tenant?.path ?? cell.tenant?.id ?? "—"}</td>
                <td>
                  <button
                    type="button"
                    className="quiet expander"
                    aria-expanded={expanded}
                    aria-controls={breakdown}
                    title={expanded ? "Hide its history" : "Show its history"}
                    onClick={() => toggle(cell.id)}
                  >
                    {expanded ? "▾" : "▸"} {cell.pipeline}
                  </button>
                  {cell.disabled ? <span className="chip">disabled</span> : null}
                </td>
                <td>
                  {cell.state}
                  {cell.wedged?.wedged === true ? (
                    <span className="chip fail">wedged: {cell.wedged.reason}</span>
                  ) : null}
                </td>
                <td>
                  {child === undefined ? (
                    <span className="muted">no child</span>
                  ) : (
                    <>
                      {child.state}
                      {child.restarts > 0 ? (
                        <span className="muted"> · {child.restarts} restart(s)</span>
                      ) : null}
                      {child.crashLooping ? <span className="chip warn">crash-looping</span> : null}
                    </>
                  )}
                </td>
                <PipelineWeek summary={summary} />
              </tr>,
              expanded ? (
                <tr key={`${cell.id}-history`} id={breakdown} className="breakdown-row">
                  <td colSpan={7}>
                    <PipelineBreakdown summary={summary} now={now} />
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

/**
 * Doctor: what the last run found, with its age, and the control that asks for
 * another where the arm has one. A report with no section says so rather than
 * showing an empty pass — an empty checklist reads as ten checks that passed.
 */
function DoctorTab({
  reading,
  now,
  writes,
}: {
  reading: Extract<ReportReading, { kind: "read" }>;
  now: Date;
  writes?: ReactNode;
}) {
  const section = reading.report.doctor;
  const report = section?.report ?? null;
  return (
    <section>
      <h2>Doctor</h2>
      {section === undefined || section === null || report === null ? (
        <p className="muted">This report carries no doctor run yet, so there is nothing to show.</p>
      ) : (
        <>
          <p className="muted">
            Last run {section.at === null ? "never" : `${age(section.at, now)} ago`}
            {section.trigger === null ? "" : ` (${section.trigger})`}
            {section.running === undefined ? "" : " · a run is in flight"}
          </p>
          <table className="rows">
            <thead>
              <tr>
                <th>Check</th>
                <th>State</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check) => (
                <tr key={check.id}>
                  <td className="mono">{check.id}</td>
                  <td>
                    <span className={`chip check ${check.state}`}>{check.state}</span>
                  </td>
                  <td>{check.detail}</td>
                </tr>
              ))}
              {report.tenants.flatMap((tenant) =>
                tenant.checks.map((check) => (
                  <tr key={`${tenant.path}#${check.id}`}>
                    <td className="mono">
                      {tenant.slug ?? tenant.path} · {check.id}
                    </td>
                    <td>
                      <span className={`chip check ${check.state}`}>{check.state}</span>
                    </td>
                    <td>{check.detail}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </>
      )}
      {writes}
    </section>
  );
}

/** Secrets are write-only by decision (#504): there is nothing to read back. */
function SecretsTab({ writes }: { writes?: ReactNode }) {
  return (
    <section>
      <h2>Secrets</h2>
      <p className="muted">
        A secret is write-only. Nothing reads one back here, and nothing in this report carries a
        value.
      </p>
      {writes}
    </section>
  );
}

/**
 * The config, as the file holds it. Readable with nothing running, which is why
 * it is the one tab a stopped install keeps (#526).
 */
function ConfigTab({ config, writes }: { config: ConfigReading | null; writes?: ReactNode }) {
  if (config === null) {
    return (
      <section>
        <h2>Config</h2>
        <p className="muted">Reading the config…</p>
      </section>
    );
  }
  if (config.kind === "absent") {
    return (
      <section>
        <h2>Config</h2>
        <p className="muted">
          No <code>phoebe.config.ts</code> at <span className="mono">{config.path}</span>.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h2>Config</h2>
      {/* A page that can write brings its own view of the file, form first. */}
      {writes ?? <pre className="config mono">{config.text}</pre>}
    </section>
  );
}

/**
 * One edit receipt, rendered — the same component on both arms (#527 §16).
 *
 * A refusal always carries the exact manual edit (#503), and it is rendered
 * verbatim rather than summarised. "Console proposes, operator applies" only
 * works if what the operator is meant to apply is on the screen.
 */
export function ReceiptPanel({ receipt }: { receipt: EditReceipt }) {
  if (receipt.state === "written") {
    return (
      <p className="outcome">
        Wrote <span className="mono">{receipt.path}</span> ={" "}
        <span className="mono">{JSON.stringify(receipt.value)}</span> in{" "}
        <span className="mono">{receipt.file}</span>. The deployment reconciles onto it the way it
        would a hand edit.
      </p>
    );
  }
  return (
    <>
      <p className="refusal">
        Refused ({receipt.reason}): {receipt.why}
      </p>
      <pre className="config mono">{receipt.instruction}</pre>
    </>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
