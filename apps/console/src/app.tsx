// The console's shell: the session gate, the fleet it holds, the rail and grid it
// hands them to, and the hash the pages are chosen by.
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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RELAY_ROUTES } from "phoebe-agent/contracts";
import type {
  DesktopBridge,
  LocalInstall,
  LocalReportEvent,
  RelayIdentity,
} from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import { readEditAnswer, type EditAnswer } from "./config-edit.ts";
import { DeploymentPage, NoSuchDeployment } from "./deployment-page.tsx";
import { rowFacts, sortFleet, type RowFacts } from "./facts.ts";
import { applyEvent, EMPTY_FLEET, loadFleet, type FleetState } from "./fleet-state.ts";
import { FleetPage } from "./fleet-page.tsx";
import { InstallPage } from "./install-page.tsx";
import { pairedInstalls } from "./local-install.ts";
import { PeoplePage } from "./people-page.tsx";
import { Rail } from "./rail.tsx";
import { isNotSignedIn, type RelayClient, type RelaySignIn } from "./relay-client.ts";
import { configOf } from "./report.ts";
import { FLEET_HREF, FLEET_ROUTE, PEOPLE_HREF, parseRoute, type Route } from "./route.ts";

type Session =
  | { kind: "asking" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; identity: RelayIdentity }
  | { kind: "broken"; message: string };

export function App({
  client,
  surface,
  bridge = null,
}: {
  client: RelayClient;
  surface: Surface;
  /** The companion's bridge, or null in a browser — which has no local arm. */
  bridge?: DesktopBridge | null;
}) {
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
      bridge={bridge}
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
  bridge,
  identity,
  signIn,
  onSignedIn,
  onSignedOut,
}: {
  client: RelayClient;
  surface: Surface;
  bridge: DesktopBridge | null;
  identity: RelayIdentity | null;
  signIn: RelaySignIn | null;
  onSignedIn: (identity: RelayIdentity) => void;
  onSignedOut: () => void;
}) {
  const route = useRoute();
  const [fleet, setFleet] = useState<FleetState>(EMPTY_FLEET);
  const [loaded, setLoaded] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [installs, setInstalls] = useState<LocalInstall[]>([]);
  const [reports, setReports] = useState<Record<string, LocalReportEvent>>({});
  const [openInstall, setOpenInstall] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const now = useNow(1000);

  // The two arms share one page area, and an open install wins it. A rail link
  // into the relay arm moves the hash, so following one closes the install —
  // otherwise the address would change and the page would not.
  useEffect(() => {
    setOpenInstall(null);
  }, [route]);

  // The local arm. One read, then main's `installs:changed` does the updating —
  // the same shape as the relay's stream, for the same reason: the page holds
  // no copy it has to reconcile, and every fact on screen was derived by the
  // process that can actually see the folder (#527 §12).
  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    bridge.installs.list().then(
      (listed) => {
        if (live) setInstalls(listed);
      },
      () => undefined,
    );
    const unsubscribe = bridge.installs.changes((changed) => setInstalls(changed));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  // The local read loop's stream, which is the local arm's answer to the relay's
  // SSE (#556). One subscription for every install rather than one per open
  // page: the loop reads them all, and a later badge rule runs over the same
  // events with no page open at all (#524).
  useEffect(() => {
    if (bridge === null) return;
    return bridge.installs.reports((event) => {
      setReports((held) => ({ ...held, [event.install]: event }));
    });
  }, [bridge]);

  // Opening an install asks for a read rather than waiting up to 15 s for the
  // next one. On a stopped install this is the refresh that answers with the
  // directory's facts and no report (#527 §6).
  useEffect(() => {
    if (bridge === null || openInstall === null) return;
    bridge.installs.refresh(openInstall).then(
      (event) => setReports((held) => ({ ...held, [event.install]: event })),
      () => undefined,
    );
    return undefined;
  }, [bridge, openInstall]);

  // Which relay this companion is signed in to — the other half of the join
  // that decides whether a local install is also a row on the fleet (#558).
  // Watched rather than read once: signing in to a different relay changes
  // which rows these installs are, without anything else on the page moving.
  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    bridge.relay.state().then(
      (state) => {
        if (live) setRelayUrl(state.url);
      },
      () => undefined,
    );
    const unsubscribe = bridge.relay.watch((state) => setRelayUrl(state.url));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  const addInstall = useCallback(() => {
    if (bridge === null) return;
    void bridge.installs.pick().then(async (dir) => {
      if (dir === null) return;
      setInstalls(await bridge.installs.add(dir));
      // Straight to its page. A folder that already carries a config is adopted
      // as it stands and needs nothing; one that does not lands on the install
      // tab, which is where init is (#526).
      setOpenInstall(dir);
    });
  }, [bridge]);

  const forgetInstall = useCallback(
    (dir: string) => {
      if (bridge === null) return;
      void bridge.installs.remove(dir).then((remaining) => {
        setInstalls(remaining);
        setOpenInstall((current) => (current === dir ? null : current));
      });
    },
    [bridge],
  );

  const open = installs.find((install) => install.dir === openInstall) ?? null;

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

  // A paired install is one thing on two arms, and the rail draws it once.
  const paired = useMemo(
    () => pairedInstalls(installs, facts, relayUrl),
    [installs, facts, relayUrl],
  );
  const pairedDirs = useMemo(() => new Set(paired.keys()), [paired]);
  const relayFacts = useMemo(() => {
    const claimed = new Set(paired.values());
    return facts.filter((row) => !claimed.has(row.row.fingerprint));
  }, [facts, paired]);

  return (
    <>
      <header className="topbar">
        <span className="brand">{surface === "companion" ? "Phoebe" : "Phoebe console"}</span>
        <nav className="pages" aria-label="Pages">
          <a href={FLEET_HREF} className={route.page === "people" ? "" : "current"}>
            Fleet
          </a>
          <a href={PEOPLE_HREF} className={route.page === "people" ? "current" : ""}>
            People
          </a>
        </nav>
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
          facts={relayFacts}
          now={now}
          surface={surface}
          signedIn={identity !== null}
          installs={installs}
          paired={pairedDirs}
          selected={openInstall}
          selectedDeployment={
            openInstall === null && route.page === "deployment" ? route.fingerprint : null
          }
          onSelect={setOpenInstall}
          {...(bridge === null ? {} : { onAdd: addInstall })}
          signIn={signIn}
          onSignedIn={onSignedIn}
        />
        {open !== null && bridge !== null ? (
          <InstallPage
            key={open.dir}
            install={open}
            bridge={bridge}
            report={reports[open.dir] ?? null}
            now={now}
            signedIn={identity !== null}
            paired={paired.has(open.dir)}
            onForget={forgetInstall}
          />
        ) : identity === null ? (
          <CompanionHome installs={installs} onAdd={bridge === null ? undefined : addInstall} />
        ) : route.page === "people" ? (
          <PeoplePage client={client} now={now} onSignedOut={onSignedOut} />
        ) : trouble !== null ? (
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
 * The companion's home: both arms, and what each one is holding. Signed out, it
 * is the whole window. Adding a local install is a control here as well as on
 * the rail, because an empty companion has a rail nobody has looked at yet.
 * Signing in is the rail's, beside the group it fills, so this page points at it
 * rather than putting a second copy of the same form on screen.
 */
function CompanionHome({
  installs,
  onAdd,
}: {
  installs: LocalInstall[];
  onAdd: (() => void) | undefined;
}) {
  return (
    <main className="main">
      <h1>Phoebe</h1>
      <section>
        <h2>This machine</h2>
        {installs.length === 0 ? (
          <p className="muted">
            No local install yet. A local install is a repository folder on this machine that the
            companion drives through Docker Compose.
          </p>
        ) : (
          <p className="muted">
            {installs.length} local install{installs.length === 1 ? "" : "s"}. Pick one on the rail
            to take it from nothing to running.
          </p>
        )}
        {onAdd === undefined ? null : (
          <p>
            <button type="button" onClick={onAdd}>
              Add a folder
            </button>
          </p>
        )}
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
  if (route.page !== "deployment") return <FleetPage facts={facts} client={client} now={now} />;
  const found = facts.find((row) => row.row.fingerprint === route.fingerprint);
  if (found === undefined) return <NoSuchDeployment fingerprint={route.fingerprint} />;
  // The fingerprint the page was drawn with, not a fresh read of it: that is
  // what makes the edit optimistic-concurrency-checked rather than applied to
  // text nobody looked at (#503).
  const loaded =
    found.reading.kind === "read" ? (configOf(found.reading.report)?.root.fingerprint ?? "") : "";
  return (
    <DeploymentPage
      facts={found}
      tab={route.tab}
      client={client}
      now={now}
      onEdit={(edit) => sendConfigEdit(client, found.row.fingerprint, loaded, edit)}
    />
  );
}

/**
 * One config edit, from a row's Save to the answer it renders (#503, #547).
 *
 * The id is minted here, and it is the edit's idempotency key: the same id twice
 * is the same edit, and the deployment answers the second with the first one's
 * receipt. That is what makes a retry — a double-press, a reconnect — free of a
 * second write.
 */
async function sendConfigEdit(
  client: RelayClient,
  fingerprint: string,
  configFingerprint: string,
  edit: { path: string; value: string | number | boolean | null },
): Promise<{ id: string; answer: EditAnswer }> {
  const id = crypto.randomUUID();
  const answer = await client.setConfigField({
    fingerprint,
    id,
    path: edit.path,
    value: edit.value,
    configFingerprint,
  });
  return { id, answer: readEditAnswer(answer) };
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
