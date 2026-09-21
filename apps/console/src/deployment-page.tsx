// One deployment, in tabs — variant C's answer to "what is this thing doing"
// (#509). Overview, pipelines, doctor, config.
//
// Three rules shape what goes where.
//
// **The connection panel is the relay's, and it is never doctor's** (#507 §8).
// Connected since, last heard, how the last socket closed: the relay derives
// those and the deployment cannot, so they sit in their own panel and never in a
// check. Everything else on these tabs is the deployment's own report, which the
// relay carried without reading.
//
// **A never-connected deployment is told, not drawn empty.** A link paired
// against a container that has not booted has no report, and three tabs of empty
// panels would read as a deployment that is running and quiet. It gets one line
// that says which kind of nothing this is.
//
// **Two lines per pipeline** (#507 §2). The process line is the bootstrapper's —
// is there a child and what has it been doing — and the state line is the
// snapshot's. They answer different questions and a page that merged them would
// be unable to show a running child whose loop has stopped, which is the case
// the whole `wedged?` verdict exists for.
//
// **Secrets is the one tab that sends a value.** The others render what the
// deployment said, and the config tab asks for an edit; the secrets tab seals an
// envelope in this browser and sends it (secrets-tab.tsx, #550). The config tab
// is its own file too (config-tab.tsx) — it is a table with a filter over it
// rather than a view of the lines this module derives.

import type { DeploymentReport, DoctorCheck, TenantFacts } from "phoebe-agent/contracts";
import type { EditSeam } from "./config-edit-row.tsx";
import { ConfigTab } from "./config-tab.tsx";
import {
  crashLoopLine,
  enumeratedRows,
  engineLine,
  processLine,
  reconcileLine,
  slotsLine,
  stateLine,
  tenantRows,
  unitLines,
  wedgedLine,
  type PipelineRow,
} from "./deployment-facts.ts";
import {
  age,
  allChecks,
  connectionReading,
  doctorLine,
  type DoctorFacts,
  type RowFacts,
} from "./facts.ts";
import type { RelayClient } from "./relay-client.ts";
import { editsOf } from "./report.ts";
import { deploymentHref, DEPLOYMENT_TABS, type DeploymentTab } from "./route.ts";
import { RunDoctor } from "./run-doctor.tsx";
import { SecretsTab } from "./secrets-tab.tsx";

export function DeploymentPage({
  facts,
  tab,
  client,
  now,
  onEdit,
}: {
  facts: RowFacts;
  tab: DeploymentTab;
  client: RelayClient;
  now: Date;
  /** Send one config edit to this deployment, when this console can (#547). */
  onEdit?: EditSeam["send"];
}) {
  const connection = connectionReading(facts.row, now);
  return (
    <main className="main">
      <h1>
        <span className={`mark ${connection.tone}`} aria-hidden="true" />
        {facts.row.name}
      </h1>
      <p className="facts mono">{facts.row.fingerprint}</p>
      <nav className="tabs" aria-label="Deployment">
        {DEPLOYMENT_TABS.map((name) => (
          <a
            key={name}
            className={name === tab ? "tab current" : "tab"}
            aria-current={name === tab ? "page" : undefined}
            href={deploymentHref(facts.row.fingerprint, name)}
          >
            {name}
          </a>
        ))}
      </nav>
      <Tab
        facts={facts}
        tab={tab}
        client={client}
        now={now}
        {...(onEdit !== undefined ? { onEdit } : {})}
      />
    </main>
  );
}

/** The deployment the rail lists but the fleet does not hold a row for. */
export function NoSuchDeployment({ fingerprint }: { fingerprint: string }) {
  return (
    <main className="main">
      <h1>No such deployment</h1>
      <p className="muted">
        This relay knows no deployment with the fingerprint <code>{fingerprint}</code>. It may have
        been forgotten (#505 §4) since this link was made.
      </p>
    </main>
  );
}

function Tab({
  facts,
  tab,
  client,
  now,
  onEdit,
}: {
  facts: RowFacts;
  tab: DeploymentTab;
  client: RelayClient;
  now: Date;
  onEdit?: EditSeam["send"];
}) {
  if (tab === "overview") return <OverviewTab facts={facts} now={now} />;
  // The other three tabs are views of the report and there may not be one. They
  // say which kind of nothing it is and point back at the overview, where the
  // relay's own facts about this link are still true. The doctor tab keeps its
  // button even then: a deployment that has never reported is exactly one worth
  // asking, as long as the relay is holding its socket (#546).
  if (facts.reading.kind !== "read") {
    return (
      <>
        {tab === "doctor" ? (
          <RunDoctor client={client} target={{ kind: "deployment", row: facts.row }} now={now} />
        ) : null}
        <p className="muted">{noReportLine(facts, now)}</p>
        <p className="muted">
          <a href={deploymentHref(facts.row.fingerprint)}>Overview</a> still has the relay&apos;s
          own facts about this link.
        </p>
      </>
    );
  }
  if (tab === "pipelines") return <PipelinesTab report={facts.reading.report} now={now} />;
  if (tab === "doctor") return <DoctorTab facts={facts} client={client} now={now} />;
  if (tab === "secrets") return <SecretsTab facts={facts} client={client} now={now} />;
  return (
    <ConfigTab
      report={facts.reading.report}
      now={now}
      {...(onEdit !== undefined ? { onEdit } : {})}
    />
  );
}

/* ── overview ──────────────────────────────────────────────────────────── */

function OverviewTab({ facts, now }: { facts: RowFacts; now: Date }) {
  const reading = facts.reading;
  if (reading.kind !== "read") {
    // The relay's own panel is still true and still worth showing; the rest of
    // the overview is a view of a report that is not here.
    return (
      <>
        <div className="panels">
          <ConnectionPanel facts={facts} now={now} />
        </div>
        <p className="muted">{noReportLine(facts, now)}</p>
      </>
    );
  }
  const report = reading.report;
  return (
    <>
      <div className="panels">
        <ConnectionPanel facts={facts} now={now} />
        <EnginePanel facts={facts} report={report} receivedAt={reading.receivedAt} now={now} />
        <DoctorPanel facts={facts} now={now} />
      </div>
      <PipelinesAtAGlance report={report} now={now} />
      <HeldTenants report={report} />
      <PendingEdits report={report} now={now} />
    </>
  );
}

/**
 * The relay's own facts, in their own panel. Nothing in here comes out of the
 * report, and nothing in here is a doctor check (#507 §8) — the relay answers
 * none of those, and merging the two would make "the relay lost this
 * deployment" look like a failing check about the deployment.
 */
function ConnectionPanel({ facts, now }: { facts: RowFacts; now: Date }) {
  const connection = connectionReading(facts.row, now);
  const { row } = facts;
  return (
    <section className="panel" aria-label="Connection">
      <h2>Connection</h2>
      <p className="lead">
        {connection.text}
        {connection.maybeReplaced ? <span className="chip replaced">replaced?</span> : null}
      </p>
      {connection.detail === null ? null : <p className="facts">{connection.detail}</p>}
      <dl className="kv">
        <Row term="last heard">
          {row.lastSeen === null ? "never" : `${age(row.lastSeen, now)} ago`}
        </Row>
        <Row term="paired">
          {age(row.firstSeen, now)} ago by {row.pairedBy}
        </Row>
        <Row term="last close">
          {row.lastClose === null
            ? "none in this relay's lifetime"
            : `${row.lastClose.code}${row.lastClose.reason === "" ? "" : ` ${row.lastClose.reason}`} · ${age(row.lastClose.at, now)} ago`}
        </Row>
      </dl>
      <p className="facts">The relay&apos;s own facts. Doctor answers none of them (#507 §8).</p>
    </section>
  );
}

function EnginePanel({
  facts,
  report,
  receivedAt,
  now,
}: {
  facts: RowFacts;
  report: DeploymentReport;
  /** When the relay took delivery — the report's age, as the relay clocks it. */
  receivedAt: string;
  now: Date;
}) {
  const crashLoop = crashLoopLine(report);
  return (
    <section className="panel" aria-label="Engine">
      <h2>Engine</h2>
      <p className="lead mono">{engineLine(facts)}</p>
      <dl className="kv">
        <Row term="quarantine">
          {facts.quarantinedSha === null
            ? "none — running the commit the config names"
            : `running away from ${facts.quarantinedSha}`}
        </Row>
        {crashLoop === null ? null : <Row term="crash-loop">{crashLoop}</Row>}
        <Row term="reconcile">{reconcileLine(report, now)}</Row>
        <Row term="slots">{slotsLine(report)}</Row>
        <Row term="report">{age(receivedAt, now)} ago</Row>
      </dl>
    </section>
  );
}

function DoctorPanel({ facts, now }: { facts: RowFacts; now: Date }) {
  const { doctor } = facts;
  return (
    <section className="panel" aria-label="Doctor">
      <h2>Doctor</h2>
      <p className="lead">{doctorLine(doctor, now)}</p>
      <dl className="kv">
        <Row term="checks">
          {doctor.report === null
            ? "none yet"
            : `${allChecks(doctor).length} run, ${doctor.fail} fail, ${doctor.warn} warn, ${doctor.unknown} unknown`}
        </Row>
        {doctor.lastAttempt === null ? null : (
          <Row term="last attempt">
            {doctor.lastAttempt.outcome} · {age(doctor.lastAttempt.at, now)} ago
          </Row>
        )}
      </dl>
      <p className="facts">
        <a href={deploymentHref(facts.row.fingerprint, "doctor")}>Every check →</a>
      </p>
    </section>
  );
}

function PipelinesAtAGlance({ report, now }: { report: DeploymentReport; now: Date }) {
  const rows = enumeratedRows(report);
  return (
    <>
      <h2>Pipelines at a glance</h2>
      {rows.length === 0 ? (
        <p className="muted">No enumerated pipeline. Every tenant this deployment has is below.</p>
      ) : (
        <div className="glance">
          {rows.map((row) => (
            <PipelineCard key={row.id} row={row} now={now} />
          ))}
        </div>
      )}
    </>
  );
}

function PipelineCard({ row, now }: { row: PipelineRow; now: Date }) {
  const wedged = wedgedLine(row.cell);
  return (
    <div className={`glance-card${wedged !== null ? " wedged" : ""}`}>
      <div className="name">
        {row.cell.tenant?.path ?? row.cell.tenant?.id ?? row.id}/{row.cell.pipeline}
        {row.cell.disabled ? <span className="chip">disabled</span> : null}
      </div>
      <div className="facts">{processLine(row.child, now)}</div>
      <div>{stateLine(row.cell)}</div>
      {wedged === null ? null : <div className="bad">{wedged}</div>}
    </div>
  );
}

function HeldTenants({ report }: { report: DeploymentReport }) {
  const held = tenantRows(report).filter((row) => row.tenant.held === true);
  if (held.length === 0) return null;
  return (
    <>
      <h2>Held tenants</h2>
      <p className="facts">
        Discovery would skip these now; whatever they already started is still running.
      </p>
      {held.map((row) => (
        <p key={row.tenant.id} className="held">
          <b>{row.tenant.path}</b> — {row.tenant.reason ?? "held, with no reason recorded"}
        </p>
      ))}
    </>
  );
}

/**
 * Config edits applied on the deployment that are not in a commit (#503). The
 * value is in the file and the file is in a repository, so an operator who does
 * nothing loses the edit the next time that checkout is replaced — which is the
 * whole reason this panel exists.
 */
function PendingEdits({ report, now }: { report: DeploymentReport; now: Date }) {
  const edits = editsOf(report);
  if (edits.length === 0) return null;
  return (
    <>
      <h2>Edits not yet in a commit</h2>
      {edits.map((edit) => (
        <p key={edit.id} className="facts">
          <code>{edit.path}</code> = <code>{JSON.stringify(edit.value)}</code> in {edit.file} ·{" "}
          {age(edit.at, now)} ago
          {edit.by === undefined ? " at a shell" : ` by ${edit.by}`}
        </p>
      ))}
    </>
  );
}

/* ── pipelines ─────────────────────────────────────────────────────────── */

function PipelinesTab({ report, now }: { report: DeploymentReport; now: Date }) {
  const rows = tenantRows(report);
  if (rows.length === 0) {
    return <p className="muted">No tenant. Nothing is declared on this deployment.</p>;
  }
  return (
    <table className="rows">
      <thead>
        <tr>
          <th>tenant</th>
          <th>pipeline</th>
          <th>process</th>
          <th>state</th>
          <th>units in flight</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) =>
          row.pipelines.length === 0 ? (
            <tr key={row.tenant.id}>
              <th scope="row">
                <TenantName tenant={row.tenant} />
              </th>
              <td colSpan={4} className={row.tenant.held ? "bad" : "muted"}>
                {row.tenant.held
                  ? `held: ${row.tenant.reason ?? "held, with no reason recorded"}`
                  : "no pipeline"}
              </td>
            </tr>
          ) : (
            row.pipelines.map((pipeline, index) => (
              <PipelineRowCells
                key={pipeline.id}
                row={pipeline}
                tenant={index === 0 ? row.tenant : null}
                now={now}
              />
            ))
          ),
        )}
      </tbody>
    </table>
  );
}

function PipelineRowCells({
  row,
  tenant,
  now,
}: {
  row: PipelineRow;
  tenant: TenantFacts | null;
  now: Date;
}) {
  const wedged = wedgedLine(row.cell);
  const units = unitLines(row.cell, now);
  return (
    <tr className={wedged !== null ? "attention" : undefined}>
      <th scope="row">{tenant === null ? "" : <TenantName tenant={tenant} />}</th>
      <td>
        <b>{row.cell.pipeline}</b>
        {row.cell.disabled ? <span className="chip">disabled</span> : null}
        {row.cell.source === "enumerated" ? null : <span className="chip">{row.cell.source}</span>}
      </td>
      <td className="muted">{processLine(row.child, now)}</td>
      <td>
        {stateLine(row.cell)}
        {wedged === null ? null : <div className="bad">{wedged}</div>}
      </td>
      <td>
        {units.length === 0
          ? "—"
          : units.map((unit) => (
              <div key={unit.ref} className={unit.overBudget ? "bad" : undefined}>
                <span className="mono">{unit.ref}</span>{" "}
                <span className="muted">
                  {unit.running}
                  {unit.budget === null ? " (no budget)" : ` / ${unit.budget}`}
                </span>
              </div>
            ))}
      </td>
    </tr>
  );
}

function TenantName({ tenant }: { tenant: TenantFacts }) {
  return (
    <>
      {tenant.path}
      {tenant.held ? <span className="chip fail">held</span> : null}
    </>
  );
}

/* ── doctor ────────────────────────────────────────────────────────────── */

function DoctorTab({ facts, client, now }: { facts: RowFacts; client: RelayClient; now: Date }) {
  const doctor: DoctorFacts = facts.doctor;
  return (
    <>
      {/*
        The ask, above what the last one found. The receipt says which run the
        press belongs to; the checks below move when the report carrying that
        run arrives (#546).
      */}
      <RunDoctor client={client} target={{ kind: "deployment", row: facts.row }} now={now} />
      <p className="lead">{doctorLine(doctor, now)}</p>
      <p className="facts">
        {doctor.by === null ? null : <>Asked for by {doctor.by}. </>}
        {doctor.running === null
          ? "The bootstrapper runs doctor at boot, after a reconcile, on request, and every six hours (#507 §6)."
          : `A run is in flight; the checks below are the last one that finished${doctor.at === null ? "" : `, ${age(doctor.at, now)} ago`}.`}
        {doctor.lastAttempt === null
          ? null
          : ` Last attempt ${doctor.lastAttempt.outcome} ${age(doctor.lastAttempt.at, now)} ago.`}
      </p>
      {doctor.report === null ? (
        <p className="muted">
          This deployment has never produced a doctor report. That is a fact about the deployment,
          not a verdict about it.
        </p>
      ) : (
        <>
          <h2>Deployment</h2>
          <CheckTable checks={doctor.report.checks} />
          {doctor.report.tenants.map((tenant) => (
            <div key={tenant.path}>
              <h2>
                {tenant.path}
                {tenant.slug === null ? null : <span className="muted"> — {tenant.slug}</span>}
              </h2>
              <CheckTable checks={tenant.checks} />
            </div>
          ))}
        </>
      )}
    </>
  );
}

function CheckTable({ checks }: { checks: DoctorCheck[] }) {
  if (checks.length === 0) return <p className="muted">No check ran here.</p>;
  return (
    <table className="rows">
      <tbody>
        {checks.map((check) => (
          <tr key={check.id}>
            <td>
              <span className={`chip check ${check.state}`}>{check.state}</span>
            </td>
            <th scope="row">{check.id}</th>
            <td className="muted">{check.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── shared ────────────────────────────────────────────────────────────── */

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * Which kind of nothing this deployment is. Four of them, and they are not each
 * other: never booted, booted but nothing on this relay, a report too new to
 * read, and a report that is simply not here.
 */
function noReportLine(facts: RowFacts, now: Date): string {
  if (facts.reading.kind === "unreadable") {
    return `This deployment's report is stamped schema ${facts.reading.schema}, which is newer than this console reads. Upgrade the relay's package to read it.`;
  }
  if (facts.row.state === "unseen") {
    return `This deployment has never connected: the pairing token was spent ${age(facts.row.firstSeen, now)} ago and no report has arrived since. There is nothing to show until it boots.`;
  }
  return "This relay holds no report for this deployment. It has connected, so one should arrive with the next push.";
}
