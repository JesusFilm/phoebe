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
// The installs under "This machine" are local installs (#555): a folder on this
// machine, its state read from Compose, and `+ add` beside the heading because
// adopting a folder is the one thing this group can do that the other cannot.
// Three words and no fourth — running, stopped, not initialised. The relay's
// dark and unseen are a remote reader's guesses about silence, and Compose
// answers directly.
//
// The Relay group has one state that is not about deployments at all: a relay
// serving a console protocol below this bundle's (#525 §4). The group says so
// and links the upgrade doc, and This machine goes on working beside it — which
// is the point of two arms rather than one.
//
// A local entry is selectable; a relay entry is not yet. Selecting an install
// opens its install tab, which exists; selecting a deployment would open the
// five tabs that #544 builds, and a link to a page nothing answers is a dead end
// on screen.

import type { LocalInstall } from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import { connectionReading, type RowFacts } from "./facts.ts";
import { installReading } from "./local-install.ts";
import { RELAY_UPGRADE_DOC } from "./relay-version.ts";

export function Rail({
  facts,
  now,
  surface,
  signedIn,
  refusal,
  installs = [],
  selected = null,
  onSelect,
  onAdd,
}: {
  facts: RowFacts[];
  now: Date;
  surface: Surface;
  signedIn: boolean;
  /** The relay-too-old sentence, when that is where this relay stands (#525 §4). */
  refusal?: string;
  /** The local arm. Empty in a browser, which has no local arm at all. */
  installs?: LocalInstall[];
  /** The install whose page is open, by directory. */
  selected?: string | null;
  onSelect?: (dir: string) => void;
  onAdd?: () => void;
}) {
  const relay = (
    <section className="rail-group" aria-label="Relay">
      <h2 className="rail-heading">
        {surface === "companion"
          ? "Relay"
          : `Fleet — ${facts.length} ${facts.length === 1 ? "deployment" : "deployments"}`}
      </h2>
      {refusal !== undefined ? (
        <p className="rail-empty refusal">
          {refusal} <a href={RELAY_UPGRADE_DOC}>How to upgrade the relay</a>
        </p>
      ) : !signedIn ? (
        <p className="rail-empty">Not signed in to a relay.</p>
      ) : facts.length === 0 ? (
        <p className="rail-empty">No deployment is paired with this relay yet.</p>
      ) : (
        facts.map((row) => <RailEntry key={row.row.fingerprint} facts={row} now={now} />)
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
        <h2 className="rail-heading">
          This machine
          {onAdd === undefined ? null : (
            <button type="button" className="rail-add" onClick={onAdd}>
              + add
            </button>
          )}
        </h2>
        {installs.length === 0 ? (
          <p className="rail-empty">No local install yet.</p>
        ) : (
          installs.map((install) => (
            <InstallEntry
              key={install.dir}
              install={install}
              current={install.dir === selected}
              {...(onSelect !== undefined ? { onSelect } : {})}
            />
          ))
        )}
      </section>
      {relay}
    </nav>
  );
}

/**
 * One local install. A button rather than a div, because it is the one rail
 * entry that goes somewhere — and a thing you click should be a thing a keyboard
 * can reach.
 */
function InstallEntry({
  install,
  current,
  onSelect,
}: {
  install: LocalInstall;
  current: boolean;
  onSelect?: (dir: string) => void;
}) {
  const reading = installReading(install);
  return (
    <button
      type="button"
      className={`rail-entry local state-${reading.tone}${current ? " current" : ""}`}
      aria-current={current ? "page" : undefined}
      onClick={() => onSelect?.(install.dir)}
    >
      <div className="name">
        <span className={`mark ${reading.tone}`} aria-hidden="true" />
        {install.name}
      </div>
      <div className="sub">{reading.text}</div>
    </button>
  );
}

function RailEntry({ facts, now }: { facts: RowFacts; now: Date }) {
  const connection = connectionReading(facts.row, now);
  return (
    <div className={`rail-entry state-${connection.tone}${facts.attention ? " attention" : ""}`}>
      <div className="name">
        <span className={`mark ${connection.tone}`} aria-hidden="true" />
        {facts.row.name}
        {connection.maybeReplaced ? <span className="chip replaced">replaced?</span> : null}
      </div>
      <div className="sub">{[connection.text, ...subClauses(facts)].join(" · ")}</div>
    </div>
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
  if (facts.held > 0) clauses.push(`${facts.held} held`);
  if (facts.reconciling !== null) clauses.push(`reconciling (${facts.reconciling})`);
  if (facts.quarantinedSha !== null) clauses.push("quarantined commit");
  if (facts.reading.kind === "none" && facts.row.state !== "unseen") clauses.push("no report");
  if (facts.reading.kind === "unreadable") clauses.push(`report schema ${facts.reading.schema}`);
  return clauses;
}
