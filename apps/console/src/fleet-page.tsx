// The fleet page: one cell per deployment, one bar segment per pipeline.
//
// The bar is the compact form variant C won on (#509) — a deployment's pipelines
// as a row of segments, so a wedged one is visible without reading a number. The
// numbers are under it anyway, because a segment says which pipeline and the
// counts say how many.
//
// Nothing here is a score (#507 §9). Every line is a count of something, and the
// bar's colours are the pipeline states the deployment already derived and wrote
// down (#501) — the console recomputes none of them.

import { age, connectionReading, doctorLine, type PipelineFacts, type RowFacts } from "./facts.ts";
import type { RelayClient } from "./relay-client.ts";
import { deploymentHref } from "./route.ts";
import { RunDoctor } from "./run-doctor.tsx";

export function FleetPage({
  facts,
  client,
  now,
}: {
  facts: RowFacts[];
  client: RelayClient;
  now: Date;
}) {
  return (
    <main className="main">
      <h1>Fleet</h1>
      {/*
        One press, one `doctor-run` per deployment, one receipt each (#507 §10).
        Never disabled: the deployments the relay cannot reach are part of the
        answer, each refused undelivered by name.
      */}
      <RunDoctor client={client} target={{ kind: "fleet", deployments: facts.length }} now={now} />
      <p className="legend">
        One segment per pipeline: green working, blue waiting for slot, grey idle, outlined no
        status, red wedged, amber crash-looping. A faded segment is a disabled pipeline.
      </p>
      <div className="grid">
        {facts.map((row) => (
          <Cell key={row.row.fingerprint} facts={row} now={now} />
        ))}
      </div>
    </main>
  );
}

function Cell({ facts, now }: { facts: RowFacts; now: Date }) {
  const connection = connectionReading(facts.row, now);
  return (
    <section
      className={`cell state-${connection.tone}${facts.attention ? " attention" : ""}`}
      aria-label={facts.row.name}
    >
      <div className="cell-head">
        <a className="name" href={deploymentHref(facts.row.fingerprint)}>
          <span className={`mark ${connection.tone}`} aria-hidden="true" />
          {facts.row.name}
        </a>
        <span className="muted">{connection.text}</span>
        {connection.maybeReplaced ? <span className="chip replaced">replaced?</span> : null}
      </div>
      {connection.detail === null ? null : <div className="facts">{connection.detail}</div>}
      <Bar pipelines={facts.pipelines} />
      <PipelineCounts facts={facts} />
      <div className="facts">{engineLine(facts)}</div>
      <div className="facts">{doctorLine(facts.doctor, now)}</div>
      <div className="facts">{reportLine(facts, now)}</div>
    </section>
  );
}

function Bar({ pipelines }: { pipelines: PipelineFacts[] }) {
  if (pipelines.length === 0) return <div className="bar-empty" aria-hidden="true" />;
  return (
    <div className="bar">
      {pipelines.map((pipeline) => (
        <span
          key={pipeline.id}
          className={`segment ${segmentClass(pipeline)}${pipeline.disabled ? " disabled" : ""}`}
          title={`${pipeline.tenant}/${pipeline.pipeline}: ${segmentWord(pipeline)}`}
        />
      ))}
    </div>
  );
}

/**
 * Wedged first, then crash-looping, then the state the report carries. The order
 * is the order an operator would want to hear them in — a wedged pipeline whose
 * child is also restarting is still wedged.
 */
function segmentClass(pipeline: PipelineFacts): string {
  if (pipeline.wedged) return "wedged";
  if (pipeline.crashLooping) return "crash-looping";
  if (pipeline.state === "working") return "working";
  if (pipeline.state === "waiting for slot") return "waiting";
  if (pipeline.state === "no status") return "no-status";
  return "idle";
}

function segmentWord(pipeline: PipelineFacts): string {
  if (pipeline.wedged) return "wedged?";
  if (pipeline.crashLooping) return "crash-looping";
  return pipeline.state;
}

function PipelineCounts({ facts }: { facts: RowFacts }) {
  if (facts.pipelines.length === 0) {
    return <div className="facts">{noPipelinesLine(facts)}</div>;
  }
  const counted = Object.entries(facts.counts).map(([state, count]) => `${count} ${state}`);
  return (
    <div className="facts">
      {facts.pipelines.length} {facts.pipelines.length === 1 ? "pipeline" : "pipelines"} —{" "}
      {counted.join(", ")}
      {facts.wedged > 0 ? <span className="chip fail">{facts.wedged} wedged</span> : null}
      {facts.crashLooping > 0 ? (
        <span className="chip warn">{facts.crashLooping} crash-looping</span>
      ) : null}
      {facts.held > 0 ? <span className="chip warn">{facts.held} held</span> : null}
    </div>
  );
}

/** Why there is no bar. Four different reasons, and they are not each other. */
function noPipelinesLine(facts: RowFacts): string {
  if (facts.reading.kind === "unreadable") {
    return `report schema ${facts.reading.schema} — newer than this console reads`;
  }
  if (facts.reading.kind === "none") {
    return facts.row.state === "unseen"
      ? "paired, never booted — no report yet"
      : "no report on this relay";
  }
  return "no enumerated pipeline";
}

function engineLine(facts: RowFacts): string {
  if (facts.reading.kind !== "read") return `paired by ${facts.row.pairedBy}`;
  const engine = [facts.engineRef ?? "engine unset", facts.engineSha ?? "no sha"].join(" → ");
  const clauses = [engine];
  if (facts.quarantinedSha !== null) clauses.push(`quarantined ${facts.quarantinedSha}`);
  if (facts.reconciling !== null) clauses.push(`reconciling (${facts.reconciling})`);
  return clauses.join(" · ");
}

function reportLine(facts: RowFacts, now: Date): string {
  if (facts.reading.kind !== "read") return `first seen ${age(facts.row.firstSeen, now)} ago`;
  return `report ${age(facts.reading.receivedAt, now)} ago`;
}
