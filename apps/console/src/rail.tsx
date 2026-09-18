// The rail — every deployment, always on screen.
//
// This is why variant C won the prototype (#509): "is everything alive" is the
// first question the map asks, and the rail answers it from whatever page the
// operator is on rather than only from the fleet page. So it takes the whole
// fleet and renders it in the sort order #507 §9 fixed, and the page beside it is
// none of its business.
//
// Each entry links to that deployment's tabs (#544). The heading links back to
// the fleet, so the grid is one click from anywhere rather than a page an
// operator has to find their way back to.

import { connectionReading, type RowFacts } from "./facts.ts";
import { deploymentHref, FLEET_HREF } from "./route.ts";

export function Rail({
  facts,
  selected,
  now,
}: {
  facts: RowFacts[];
  /** The fingerprint of the deployment being shown, or null on the fleet page. */
  selected: string | null;
  now: Date;
}) {
  return (
    <nav className="rail" aria-label="Fleet">
      <a className="rail-heading" href={FLEET_HREF}>
        Fleet — {facts.length} {facts.length === 1 ? "deployment" : "deployments"}
      </a>
      {facts.length === 0 ? (
        <p className="rail-empty">No deployment is paired with this relay yet.</p>
      ) : (
        facts.map((row) => (
          <RailEntry
            key={row.row.fingerprint}
            facts={row}
            current={row.row.fingerprint === selected}
            now={now}
          />
        ))
      )}
    </nav>
  );
}

function RailEntry({ facts, current, now }: { facts: RowFacts; current: boolean; now: Date }) {
  const connection = connectionReading(facts.row, now);
  return (
    <a
      className={`rail-entry state-${connection.tone}${facts.attention ? " attention" : ""}${current ? " current" : ""}`}
      href={deploymentHref(facts.row.fingerprint)}
      aria-current={current ? "page" : undefined}
    >
      <div className="name">
        <span className={`mark ${connection.tone}`} aria-hidden="true" />
        {facts.row.name}
        {connection.maybeReplaced ? <span className="chip replaced">replaced?</span> : null}
      </div>
      <div className="sub">{[connection.text, ...subClauses(facts)].join(" · ")}</div>
    </a>
  );
}

/**
 * The clauses under the name: only the ones that are true. A row with nothing
 * wrong says its connection and stops, which is what makes the rows that do say
 * something stand out without a severity word anywhere on screen.
 */
function subClauses(facts: RowFacts): string[] {
  const clauses: string[] = [];
  if (facts.wedged > 0) clauses.push(`${facts.wedged} wedged`);
  if (facts.crashLooping > 0) clauses.push(`${facts.crashLooping} crash-looping`);
  if (facts.doctor.fail > 0) clauses.push(`doctor ${facts.doctor.fail} fail`);
  if (facts.held > 0) clauses.push(`${facts.held} held`);
  if (facts.reconciling !== null) clauses.push(`reconciling (${facts.reconciling})`);
  if (facts.quarantinedSha !== null) clauses.push("quarantined commit");
  if (facts.reading.kind === "none" && facts.row.state !== "unseen") clauses.push("no report");
  if (facts.reading.kind === "unreadable") clauses.push(`report schema ${facts.reading.schema}`);
  return clauses;
}
