// The console's shell: the session gate, the fleet it holds, and the rail and
// grid it hands them to.
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
import { DeploymentPage, NoSuchDeployment } from "./deployment-page.tsx";
import { rowFacts, sortFleet, type RowFacts } from "./facts.ts";
import { applyEvent, EMPTY_FLEET, loadFleet, type FleetState } from "./fleet-state.ts";
import { FleetPage } from "./fleet-page.tsx";
import { Rail } from "./rail.tsx";
import { isNotSignedIn, type RelayClient } from "./relay-client.ts";
import { FLEET_ROUTE, parseRoute, type Route } from "./route.ts";

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
  const [fleet, setFleet] = useState<FleetState>(EMPTY_FLEET);
  const [loaded, setLoaded] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const now = useNow(1000);
  const route = useRoute();

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
        <Rail
          facts={facts}
          selected={route.page === "deployment" ? route.fingerprint : null}
          now={now}
        />
        {trouble !== null ? (
          <main className="main">
            <h1>Fleet</h1>
            <p className="muted">The relay did not answer: {trouble}</p>
          </main>
        ) : loaded ? (
          <Page route={route} facts={facts} client={client} now={now} />
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
 * Which page the hash names. A fingerprint the fleet does not hold gets the
 * "no such deployment" page rather than a redirect: a link that silently became
 * the fleet page would look like the deployment is fine.
 */
function Page({
  route,
  facts,
  client,
  now,
}: {
  route: Route;
  facts: RowFacts[];
  /** The pages that ask for something need the seam too, not only the shell. */
  client: RelayClient;
  now: Date;
}) {
  if (route.page === "fleet") return <FleetPage facts={facts} client={client} now={now} />;
  const found = facts.find((row) => row.row.fingerprint === route.fingerprint);
  if (found === undefined) return <NoSuchDeployment fingerprint={route.fingerprint} />;
  return <DeploymentPage facts={found} tab={route.tab} client={client} now={now} />;
}

/**
 * The route, kept in step with the address bar. Links are plain `href`s into the
 * hash, so the browser does the navigating and the history; this only listens.
 */
function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined" ? FLEET_ROUTE : parseRoute(window.location.hash),
  );
  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    // The hash may have moved between the first render and this effect.
    onHashChange();
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
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
