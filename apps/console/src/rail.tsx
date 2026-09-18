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
// Both groups lead somewhere. Selecting an install opens its install tab;
// selecting a deployment opens the five tabs #544 built, which is why a relay
// entry is a link into the hash while an install entry is a button — one is a
// route the browser owns, the other is a choice only this window holds.
//
// The Relay group's signed-out entry is the companion's sign-in control (#554).
// It asks for one thing — the relay's address — because that is the only part of
// the flow that is the operator's to supply: the PKCE verifier, the system
// browser, the hop back over `phoebe://auth` and the exchange all happen in main,
// and the renderer never sees the token that comes out.
//
// The Relay group has one state that is not about deployments at all: a relay
// serving a console protocol below this bundle's (#525 §4). The group says so
// and links the upgrade doc, and This machine goes on working beside it — which
// is the point of two arms rather than one.
//
// Under both groups sits the one line that is about the window itself: a newer
// companion, when there is one (#525 §3). It is at the foot of the rail rather
// than in either group because an update belongs to neither arm, and it says
// nothing at all until there is something to click — a check that found nothing
// is not news.

import { useState } from "react";
import type { CompanionUpdate, LocalInstall, RelayIdentity } from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import { connectionReading, type RowFacts } from "./facts.ts";
import { installReading } from "./local-install.ts";
import type { RelaySignIn } from "./relay-client.ts";
import { RELAY_UPGRADE_DOC } from "./relay-version.ts";
import { deploymentHref, FLEET_HREF } from "./route.ts";

export function Rail({
  facts,
  now,
  surface,
  signedIn,
  refusal,
  installs = [],
  selected = null,
  selectedDeployment = null,
  update = null,
  onSelect,
  onAdd,
  onDownload,
  onRestart,
  signIn,
  onSignedIn,
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
  /** The fingerprint of the deployment being shown, or null on the fleet page. */
  selectedDeployment?: string | null;
  /** The companion's own update. Null in a browser, which updates with a reload. */
  update?: CompanionUpdate | null;
  onSelect?: (dir: string) => void;
  onAdd?: () => void;
  onDownload?: () => void;
  onRestart?: () => void;
  /** How this arm signs in, or null while the answer is still being read. */
  signIn: RelaySignIn | null;
  onSignedIn: (identity: RelayIdentity) => void;
}) {
  const relay = (
    <section className="rail-group" aria-label="Relay">
      <h2 className="rail-heading">
        {surface === "companion" ? (
          "Relay"
        ) : (
          <a href={FLEET_HREF}>
            Fleet — {facts.length} {facts.length === 1 ? "deployment" : "deployments"}
          </a>
        )}
      </h2>
      {refusal !== undefined ? (
        <p className="rail-empty refusal">
          {refusal} <a href={RELAY_UPGRADE_DOC}>How to upgrade the relay</a>
        </p>
      ) : !signedIn ? (
        <SignInControl signIn={signIn} onSignedIn={onSignedIn} />
      ) : facts.length === 0 ? (
        <p className="rail-empty">No deployment is paired with this relay yet.</p>
      ) : (
        facts.map((row) => (
          <RailEntry
            key={row.row.fingerprint}
            facts={row}
            current={row.row.fingerprint === selectedDeployment}
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
      <UpdateNotice
        update={update}
        {...(onDownload !== undefined ? { onDownload } : {})}
        {...(onRestart !== undefined ? { onRestart } : {})}
      />
    </nav>
  );
}

/**
 * The companion's own update, in one line at the foot of the rail.
 *
 * Three states have something to say and the rest do not. Checking, nothing
 * newer, and a feed nobody could read are all "carry on"; an unsupported
 * companion — macOS until signing lands, or one run from a checkout — is told
 * about a new build by the release page rather than by this line (#525 §3).
 */
function UpdateNotice({
  update,
  onDownload,
  onRestart,
}: {
  update: CompanionUpdate | null;
  onDownload?: () => void;
  onRestart?: () => void;
}) {
  if (update === null) return null;

  switch (update.kind) {
    case "available":
      return (
        <footer className="rail-update">
          Phoebe {update.version} is available.{" "}
          {onDownload === undefined ? null : (
            <button type="button" className="rail-add" onClick={onDownload}>
              Download
            </button>
          )}
        </footer>
      );
    case "downloading":
      return (
        <footer className="rail-update">
          Downloading Phoebe {update.version}… {update.percent}%
        </footer>
      );
    case "ready":
      return (
        <footer className="rail-update">
          Phoebe {update.version} installs when you quit.{" "}
          {onRestart === undefined ? null : (
            <button type="button" className="rail-add" onClick={onRestart}>
              Restart now
            </button>
          )}
        </footer>
      );
    default:
      return null;
  }
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
