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
// The Relay group's signed-out entry is the companion's sign-in control (#554).
// It asks for one thing — the relay's address — because that is the only part of
// the flow that is the operator's to supply: the PKCE verifier, the system
// browser, the hop back over `phoebe://auth` and the exchange all happen in main,
// and the renderer never sees the token that comes out.
//
// Entries are not links yet. Selecting a deployment opens the tabs that #544
// builds; a link to a route nothing answers would be a dead end on screen, and
// the rail's job here is to state facts, which it does either way.

import { useState } from "react";
import type { RelayIdentity } from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import { connectionReading, type RowFacts } from "./facts.ts";
import type { RelaySignIn } from "./relay-client.ts";

export function Rail({
  facts,
  now,
  surface,
  signedIn,
  signIn,
  onSignedIn,
}: {
  facts: RowFacts[];
  now: Date;
  surface: Surface;
  signedIn: boolean;
  /** How this arm signs in, or null while the answer is still being read. */
  signIn: RelaySignIn | null;
  onSignedIn: (identity: RelayIdentity) => void;
}) {
  const relay = (
    <section className="rail-group" aria-label="Relay">
      <h2 className="rail-heading">
        {surface === "companion"
          ? "Relay"
          : `Fleet — ${facts.length} ${facts.length === 1 ? "deployment" : "deployments"}`}
      </h2>
      {!signedIn ? (
        <SignInControl signIn={signIn} onSignedIn={onSignedIn} />
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
        <h2 className="rail-heading">This machine</h2>
        <p className="rail-empty">No local install yet.</p>
      </section>
      {relay}
    </nav>
  );
}

/**
 * The signed-out Relay entry. Which control it is comes from the arm, not from
 * the surface: a browser follows a link the relay serves, and the companion
 * hands an address to main. The rail does not know which it is until the client
 * has answered, and says the honest thing in the meantime.
 */
function SignInControl({
  signIn,
  onSignedIn,
}: {
  signIn: RelaySignIn | null;
  onSignedIn: (identity: RelayIdentity) => void;
}) {
  if (signIn === null) return <p className="rail-empty">Not signed in to a relay.</p>;
  if (signIn.kind === "navigate") {
    return (
      <p className="rail-empty">
        Not signed in to a relay. <a href={signIn.href}>Sign in with Google</a>
      </p>
    );
  }
  return <SignInForm prompt={signIn} onSignedIn={onSignedIn} />;
}

/**
 * The companion's control. The button stays busy for as long as the operator is
 * in their browser, because that is exactly how long main's promise is open —
 * there is no polling here and no second state to keep in step with main's.
 */
function SignInForm({
  prompt,
  onSignedIn,
}: {
  prompt: Extract<RelaySignIn, { kind: "prompt" }>;
  onSignedIn: (identity: RelayIdentity) => void;
}) {
  const [url, setUrl] = useState(prompt.relay ?? "");
  const [waiting, setWaiting] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  return (
    <div className="rail-signin">
      <p className="rail-empty">Not signed in to a relay.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setWaiting(true);
          setTrouble(null);
          prompt.start(url).then(
            (identity) => {
              setWaiting(false);
              onSignedIn(identity);
            },
            (error: unknown) => {
              setWaiting(false);
              setTrouble(error instanceof Error ? error.message : String(error));
            },
          );
        }}
      >
        <label htmlFor="relay-url">Relay address</label>
        <input
          id="relay-url"
          name="url"
          type="url"
          placeholder="https://relay.example.com"
          value={url}
          disabled={waiting}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit" disabled={waiting || url.trim() === ""}>
          {waiting ? "Finish in your browser…" : "Sign in"}
        </button>
      </form>
      {prompt.reason !== undefined ? <p className="rail-note">{prompt.reason}</p> : null}
      {trouble !== null ? <p className="rail-note trouble">{trouble}</p> : null}
    </div>
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
