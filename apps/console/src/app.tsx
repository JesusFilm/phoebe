// The console's shell: the session gate, the fleet it holds, and the rail and
// grid it hands them to.
//
// Everything it needs from the relay arrives through the one client seam, so this
// component is the same component in the companion's renderer with a different
// implementation passed in (#523, #553). What the surface does change is what
// signed-out looks like. In a browser the relay is the whole page, so signed-out
// is a page with a link to sign in. In the companion the window is the shell, and
// the relay is one of two arms: the Relay group collapses to say so and This
// machine is untouched (#526).
//
// The stream does the updating. The page reads the fleet once, subscribes, and
// then only applies events (#542) — there is no polling loop and no refetch on a
// timer. What does tick is a clock, once a second, because half the facts on
// screen are durations and a duration that stops moving reads as a page that has
// stopped listening.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { RelayIdentity } from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import { rowFacts, sortFleet } from "./facts.ts";
import { applyEvent, EMPTY_FLEET, loadFleet, type FleetState } from "./fleet-state.ts";
import { FleetPage } from "./fleet-page.tsx";
import { Rail } from "./rail.tsx";
import { isNotSignedIn, type RelayClient, type RelaySignIn } from "./relay-client.ts";

type Session =
  | { kind: "asking" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; identity: RelayIdentity }
  | { kind: "broken"; message: string };

export function App({ client, surface }: { client: RelayClient; surface: Surface }) {
  const [session, setSession] = useState<Session>({ kind: "asking" });
  const [signIn, setSignIn] = useState<RelaySignIn | null>(null);

  useEffect(() => {
    let live = true;
    client.me().then(
      (identity) => {
        if (!live) return;
        setSession(identity === null ? { kind: "signed-out" } : { kind: "signed-in", identity });
      },
      (error: unknown) => {
        if (live) setSession({ kind: "broken", message: messageOf(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  // The session can end without the page asking for anything: in the companion
  // main drops the device token when the relay answers 401 on the event stream,
  // and the rail has to stop claiming a session that is gone (#554). In a
  // browser this never fires, and that is the browser arm's own answer.
  useEffect(() => client.watchSession(setIdentity), [client]);

  // How this arm signs in, read only while there is nobody signed in. The
  // companion's answer carries the relay it remembers and whether a token
  // would survive a relaunch, so it is read again each time rather than once.
  useEffect(() => {
    if (session.kind !== "signed-out") return;
    let live = true;
    client.signIn().then((how) => {
      if (live) setSignIn(how);
    }, ignore);
    return () => {
      live = false;
    };
  }, [client, session.kind]);

  function setIdentity(identity: RelayIdentity | null): void {
    setSession(identity === null ? { kind: "signed-out" } : { kind: "signed-in", identity });
  }

  if (session.kind === "asking") return <Notice title="Phoebe console">Signing in…</Notice>;
  if (session.kind === "signed-out" && surface === "browser") {
    return (
      <Notice title="Phoebe console">
        <p>This relay is behind Google sign-in.</p>
        {signIn !== null && signIn.kind === "navigate" ? (
          <p>
            <a href={signIn.href}>Sign in with Google</a>
          </p>
        ) : null}
      </Notice>
    );
  }
  if (session.kind === "broken") {
    return (
      <Notice title="Phoebe console">
        <p>The relay did not answer who you are.</p>
        <p className="muted">{session.message}</p>
      </Notice>
    );
  }

  return (
    <Console
      client={client}
      surface={surface}
      identity={session.kind === "signed-in" ? session.identity : null}
      signIn={signIn}
      onSignedIn={setIdentity}
      onSignedOut={() => setSession({ kind: "signed-out" })}
    />
  );
}

function Console({
  client,
  surface,
  identity,
  signIn,
  onSignedIn,
  onSignedOut,
}: {
  client: RelayClient;
  surface: Surface;
  identity: RelayIdentity | null;
  signIn: RelaySignIn | null;
  onSignedIn: (identity: RelayIdentity) => void;
  onSignedOut: () => void;
}) {
  const [fleet, setFleet] = useState<FleetState>(EMPTY_FLEET);
  const [loaded, setLoaded] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    // Signed out, there is no fleet to read and no stream to hold open. The
    // companion still draws the shell around that (#526).
    if (identity === null) return;

    let live = true;
    loadFleet(client).then(
      (state) => {
        if (!live) return;
        setFleet(state);
        setLoaded(true);
      },
      (error: unknown) => {
        if (!live) return;
        if (isNotSignedIn(error)) onSignedOut();
        else setTrouble(messageOf(error));
      },
    );
    // Subscribing after the read would drop an event that landed in between.
    // Subscribing before it means an event may be applied to the empty fleet and
    // then overwritten by the read — which is why a connection event inserts its
    // row rather than assuming one is there (fleet-state.ts).
    const unsubscribe = client.events((event) => {
      setFleet((state) => applyEvent(state, event));
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client, identity, onSignedOut]);

  const facts = useMemo(
    () => sortFleet(fleet.rows.map((row) => rowFacts(row, fleet.reports[row.fingerprint] ?? null))),
    [fleet],
  );

  return (
    <>
      <header className="topbar">
        <span className="brand">{surface === "companion" ? "Phoebe" : "Phoebe console"}</span>
        <span className="spacer" />
        {identity === null ? (
          <span className="muted">Not signed in</span>
        ) : (
          <>
            <span className="muted">{identity.email}</span>
            <button
              type="button"
              onClick={() => {
                void client.signOut().then(onSignedOut, onSignedOut);
              }}
            >
              Sign out
            </button>
          </>
        )}
      </header>
      <div className="frame">
        <Rail
          facts={facts}
          now={now}
          surface={surface}
          signedIn={identity !== null}
          signIn={signIn}
          onSignedIn={onSignedIn}
        />
        {identity === null ? (
          <CompanionHome />
        ) : trouble !== null ? (
          <main className="main">
            <h1>Fleet</h1>
            <p className="muted">The relay did not answer: {trouble}</p>
          </main>
        ) : loaded ? (
          <FleetPage facts={facts} now={now} />
        ) : (
          <main className="main">
            <h1>Fleet</h1>
            <p className="muted">Reading the fleet…</p>
          </main>
        )}
      </div>
    </>
  );
}

/**
 * The companion with nothing in it yet: both arms, both empty, each saying which
 * kind of empty it is. Adding a local install is #555's control. Signing in is
 * the rail's, beside the group it fills, so this page points at it rather than
 * putting a second copy of the same form on screen.
 */
function CompanionHome() {
  return (
    <main className="main">
      <h1>Phoebe</h1>
      <section>
        <h2>This machine</h2>
        <p className="muted">
          No local install yet. A local install is a repository folder on this machine that the
          companion drives through Docker Compose.
        </p>
      </section>
      <section>
        <h2>Relay</h2>
        <p className="muted">
          Not signed in. A relay is how the companion reaches the deployments that run somewhere
          else. Enter its address in the rail and sign-in opens in your own browser.
        </p>
      </section>
    </main>
  );
}

/** A read whose failure changes nothing on screen. */
function ignore(): void {}

/** A clock that ticks, so the durations on screen keep being true. */
function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="notice">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
