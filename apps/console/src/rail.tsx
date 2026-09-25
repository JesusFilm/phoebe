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
// The Relay group has one state that is not about deployments at all: a relay
// serving a console protocol below this bundle's (#525 §4). The group says so
// and links the upgrade doc, and This machine goes on working beside it — which
// is the point of two arms rather than one.
//
// A local entry is selectable; a relay entry is not yet. Selecting an install
// opens its install tab, which exists; selecting a deployment would open the
// five tabs that #544 builds, and a link to a page nothing answers is a dead end
// on screen.
//
// A paired install appears once, here, with a `paired` chip — and the row it is
// on the relay is dropped from the group below rather than drawn twice (#526,
// #558). Local is the richer arm: the verbs and the direct writes are there.
//
// The Relay group's signed-out entry is the companion's sign-in control (#554).
// It asks for one thing — the relay's address — because that is the only part of
// the flow that is the operator's to supply: the PKCE verifier, the system
// browser, the hop back over `phoebe://auth` and the exchange all happen in main,
// and the renderer never sees the token that comes out.
//
// Under both groups sits the one line that is about the window itself: a newer
// companion, when there is one (#525 §3). It is at the foot of the rail rather
// than in either group because an update belongs to neither arm, and it says
// nothing at all until there is something to click — a check that found nothing
// is not news.
//
// A local entry opens its install page (#555), and each relay entry links to that
// deployment's tabs (#544). The relay group's heading
// links back to the fleet, so the grid is one click from anywhere rather than a
// page an operator has to find their way back to.

import { useState } from "react";
import type { CompanionUpdate, LocalInstall, RelayIdentity } from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import { connectionReading, type RowFacts } from "./facts.ts";
import { Pause, Play, RotateCcw, Square } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { installActions, installReading, type InstallAction } from "./local-install.ts";
import type { RelaySignIn } from "./relay-client.ts";
import { deploymentHref, FLEET_HREF } from "./route.ts";
import { RELAY_UPGRADE_DOC } from "./relay-version.ts";

export function Rail({
  facts,
  now,
  surface,
  signedIn,
  refusal,
  installs = [],
  paired,
  selected = null,
  selectedDeployment = null,
  update = null,
  busy,
  onSelect,
  onAction,
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
  /**
   * The installs that are also a deployment on this relay, by directory. Passed
   * in rather than worked out here: the same join decides which rows the Relay
   * group below is not drawing (local-install.ts).
   */
  paired?: ReadonlySet<string>;
  /** The install whose page is open, by directory. */
  selected?: string | null;
  /** The fingerprint of the deployment being shown, or null on the fleet page. */
  selectedDeployment?: string | null;
  /** The companion's own update. Null in a browser, which updates with a reload. */
  update?: CompanionUpdate | null;
  /** The installs with a verb run in flight, by directory (run-activity.ts). */
  busy?: ReadonlySet<string>;
  onSelect?: (dir: string) => void;
  /** The entry shortcuts. Absent in a browser, which has no local arm. */
  onAction?: (dir: string, action: InstallAction) => void;
  onAdd?: () => void;
  onDownload?: () => void;
  onRestart?: () => void;
  /** How this arm signs in, or null while the answer is still being read. */
  signIn: RelaySignIn | null;
  onSignedIn: (identity: RelayIdentity) => void;
}) {
  const relay = (
    <section className="rail-group" aria-label="Relay">
      <a className="rail-heading" href={FLEET_HREF}>
        {surface === "companion"
          ? "Relay"
          : `Fleet — ${facts.length} ${facts.length === 1 ? "deployment" : "deployments"}`}
      </a>
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
              paired={paired?.has(install.dir) ?? false}
              busy={busy?.has(install.dir) ?? false}
              {...(onSelect !== undefined ? { onSelect } : {})}
              {...(onAction !== undefined ? { onAction } : {})}
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
  paired,
  busy,
  onSelect,
  onAction,
}: {
  install: LocalInstall;
  current: boolean;
  /** Also a deployment on this relay — so the Relay group is not drawing it. */
  paired: boolean;
  /** A verb run is in flight on this install: the shortcuts give way to a spinner. */
  busy: boolean;
  onSelect?: (dir: string) => void;
  /** The shortcuts: start on a stopped install; pause, stop and restart on a running one. */
  onAction?: (dir: string, action: InstallAction) => void;
}) {
  const reading = installReading(install);
  const actions = onAction === undefined ? [] : installActions(install);
  return (
    <div className={`rail-entry local state-${reading.tone}${current ? " current" : ""}`}>
      <button
        type="button"
        className="rail-select"
        aria-current={current ? "page" : undefined}
        onClick={() => onSelect?.(install.dir)}
      >
        <div className="name">
          <span className={`mark ${reading.tone}`} aria-hidden="true" />
          {install.name}
          {paired ? <span className="chip paired">paired</span> : null}
        </div>
        <div className="sub">{reading.text}</div>
      </button>
      {busy ? (
        // Something is running on this install and its end is what changes the
        // shortcuts, so until then there is one thing to show: that it is going.
        // Turning, unless the OS asked for less motion, in which case it fades.
        <span className="rail-actions">
          <Spinner
            className="rail-spinner motion-safe:animate-spin motion-reduce:animate-pulse"
            size={14}
            strokeWidth={2.25}
            aria-label={`Working on ${install.name}`}
          />
        </span>
      ) : actions.length === 0 ? null : (
        // The shortcuts: one click from the rail, without opening the page
        // first. The page opens anyway, so the run's output has somewhere to
        // land (local-install.ts, `installActions`). Coss UI's button, ghost
        // and icon-sized, as T3 Code draws its own.
        <span className="rail-actions">
          {actions.map((action) => {
            const [Icon, label] = ACTION_ICONS[action];
            return (
              <Button
                key={action}
                variant="ghost"
                size="icon-xs"
                className="rail-action"
                title={`${label} ${install.name}`}
                aria-label={`${label} ${install.name}`}
                onClick={() => onAction?.(install.dir, action)}
              >
                <Icon strokeWidth={2.25} aria-hidden="true" />
              </Button>
            );
          })}
        </span>
      )}
    </div>
  );
}

/** Each shortcut's icon and the verb it is read as. Lucide, as T3 Code draws. */
const ACTION_ICONS: Record<InstallAction, [typeof Play, string]> = {
  start: [Play, "Start"],
  pause: [Pause, "Pause"],
  stop: [Square, "Stop"],
  restart: [RotateCcw, "Restart"],
};

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
