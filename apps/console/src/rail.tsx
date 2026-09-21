// The rail — every deployment, always on screen.
//
// This is why variant C won the web prototype (#509): "is everything alive" is
// the first question the map asks, and the rail answers it from whatever page
// the operator is on rather than only from the fleet page. So it takes the whole
// fleet and renders it in the sort order #507 §9 fixed, and the page beside it is
// none of its business.
//
// In the companion the same rail is shell A (#526): one rail, two groups, "This
// machine" above "Relay". The second arm is a group rather than a mode because a
// switch hides half the fleet, and the whole point of the rail is that nothing is
// hidden. A browser has no local arm, so there the rail is the relay's group on
// its own and reads exactly as it did before the companion existed.
//
// The installs under "This machine" arrive with #555, which is also what makes
// `+ add` a control worth drawing; until then the group states that it is empty,
// which is a fact rather than a placeholder.
//
// Each entry links to that deployment's tabs (#544). The relay group's heading
// links back to the fleet, so the grid is one click from anywhere rather than a
// page an operator has to find their way back to.

import type { Surface } from "./companion.ts";
import { connectionReading, type RowFacts } from "./facts.ts";
import { deploymentHref, FLEET_HREF } from "./route.ts";

export function Rail({
  facts,
  selected,
  now,
  surface,
  signedIn,
}: {
  facts: RowFacts[];
  /** The fingerprint of the deployment being shown, or null on the fleet page. */
  selected: string | null;
  now: Date;
  surface: Surface;
  signedIn: boolean;
}) {
  const relay = (
    <section className="rail-group" aria-label="Relay">
      <a className="rail-heading" href={FLEET_HREF}>
        {surface === "companion"
          ? "Relay"
          : `Fleet — ${facts.length} ${facts.length === 1 ? "deployment" : "deployments"}`}
      </a>
      {!signedIn ? (
        <p className="rail-empty">Not signed in to a relay.</p>
      ) : facts.length === 0 ? (
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
    </section>
  );

  if (surface === "browser") {
    return (
      <nav className="rail" aria-label="Fleet">
        {relay}
      </nav>
    );
  }

  return (
    <nav className="rail" aria-label="This machine and the relay">
      <section className="rail-group" aria-label="This machine">
        <h2 className="rail-heading">This machine</h2>
        <p className="rail-empty">No local install yet.</p>
      </section>
      {relay}
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
