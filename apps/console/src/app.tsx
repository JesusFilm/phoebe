// The console's shell: the session gate, the fleet it holds, the rail and grid it
// hands them to, and the hash the pages are chosen by.
//
// Everything it needs from the relay arrives through the one client seam, so this
// component is the same component in the companion's renderer with a different
// implementation passed in (#523, #553).
//
// The stream does the updating. The page reads the fleet once, subscribes, and
// then only applies events (#542) — there is no polling loop and no refetch on a
// timer. What does tick is a clock, once a second, because half the facts on
// screen are durations and a duration that stops moving reads as a page that has
// stopped listening.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RELAY_ROUTES } from "phoebe-agent/contracts";
import type { RelayIdentity } from "phoebe-agent/contracts";
import { rowFacts, sortFleet } from "./facts.ts";
import { applyEvent, EMPTY_FLEET, loadFleet, type FleetState } from "./fleet-state.ts";
import { FleetPage } from "./fleet-page.tsx";
import { PeoplePage } from "./people-page.tsx";
import { Rail } from "./rail.tsx";
import { isNotSignedIn, type RelayClient } from "./relay-client.ts";

type Session =
  | { kind: "asking" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; identity: RelayIdentity }
  | { kind: "broken"; message: string };

export function App({ client }: { client: RelayClient }) {
  const [session, setSession] = useState<Session>({ kind: "asking" });

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

  if (session.kind === "asking") return <Notice title="Phoebe console">Signing in…</Notice>;
  if (session.kind === "signed-out") {
    return (
      <Notice title="Phoebe console">
        <p>This relay is behind Google sign-in.</p>
        <p>
          <a href={RELAY_ROUTES.signIn}>Sign in with Google</a>
        </p>
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
      identity={session.identity}
      onSignedOut={() => setSession({ kind: "signed-out" })}
    />
  );
}

function Console({
  client,
  identity,
  onSignedOut,
}: {
  client: RelayClient;
  identity: RelayIdentity;
  onSignedOut: () => void;
}) {
  const route = useHashRoute();
  const [fleet, setFleet] = useState<FleetState>(EMPTY_FLEET);
  const [loaded, setLoaded] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
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
  }, [client, onSignedOut]);

  const facts = useMemo(
    () => sortFleet(fleet.rows.map((row) => rowFacts(row, fleet.reports[row.fingerprint] ?? null))),
    [fleet],
  );

  return (
    <>
      <header className="topbar">
        <span className="brand">Phoebe console</span>
        <nav className="tabs" aria-label="Pages">
          <a href={`#${FLEET_ROUTE}`} className={route === PEOPLE_ROUTE ? "" : "current"}>
            Fleet
          </a>
          <a href={`#${PEOPLE_ROUTE}`} className={route === PEOPLE_ROUTE ? "current" : ""}>
            People
          </a>
        </nav>
        <span className="spacer" />
        <span className="muted">{identity.email}</span>
        <button
          type="button"
          onClick={() => {
            void client.signOut().then(onSignedOut, onSignedOut);
          }}
        >
          Sign out
        </button>
      </header>
      <div className="frame">
        <Rail facts={facts} now={now} />
        {route === PEOPLE_ROUTE ? (
          <PeoplePage client={client} now={now} onSignedOut={onSignedOut} />
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

/** The fleet, and the page every unknown hash falls back to. */
const FLEET_ROUTE = "/fleet";
/** The allowlist and the pairing panel (#548). */
const PEOPLE_ROUTE = "/people";

/**
 * The path in the URL's hash, and a re-render when it changes.
 *
 * The hash and not the path, because the relay serves the console's build and
 * nothing else: a real path would need a catch-all route on the relay, and a
 * catch-all is what costs it the ability to say a route does not exist
 * (relay/console-assets.ts). Nothing here reaches the server.
 */
function useHashRoute(): string {
  const [route, setRoute] = useState(routeInHash);
  useEffect(() => {
    const onChange = () => setRoute(routeInHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function routeInHash(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "" ? FLEET_ROUTE : hash;
}

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
