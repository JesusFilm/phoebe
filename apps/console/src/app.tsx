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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RELAY_ROUTES } from "phoebe-agent/contracts";
import type { DesktopBridge, LocalInstall, RelayIdentity } from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import { rowFacts, sortFleet } from "./facts.ts";
import { applyEvent, EMPTY_FLEET, loadFleet, type FleetState } from "./fleet-state.ts";
import { FleetPage } from "./fleet-page.tsx";
import { InstallPage } from "./install-page.tsx";
import { Rail } from "./rail.tsx";
import { isNotSignedIn, type RelayClient } from "./relay-client.ts";

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
  if (session.kind === "signed-out" && surface === "browser") {
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
      surface={surface}
      bridge={bridge}
      identity={session.kind === "signed-in" ? session.identity : null}
      onSignedOut={() => setSession({ kind: "signed-out" })}
    />
  );
}

function Console({
  client,
  surface,
  bridge,
  identity,
  onSignedOut,
}: {
  client: RelayClient;
  surface: Surface;
  bridge: DesktopBridge | null;
  identity: RelayIdentity | null;
  onSignedOut: () => void;
}) {
  const [fleet, setFleet] = useState<FleetState>(EMPTY_FLEET);
  const [loaded, setLoaded] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [installs, setInstalls] = useState<LocalInstall[]>([]);
  const [openInstall, setOpenInstall] = useState<string | null>(null);
  const now = useNow(1000);

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
          installs={installs}
          selected={openInstall}
          onSelect={setOpenInstall}
          {...(bridge === null ? {} : { onAdd: addInstall })}
        />
        {open !== null && bridge !== null ? (
          <InstallPage install={open} bridge={bridge} onForget={forgetInstall} />
        ) : identity === null ? (
          <CompanionHome installs={installs} onAdd={bridge === null ? undefined : addInstall} />
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
 * The companion's home: both arms, and what each one is holding. Signed out, it
 * is the whole window. Adding a local install is a control here as well as on
 * the rail, because an empty companion has a rail nobody has looked at yet;
 * signing in is #554's, so this page still names it rather than offering it.
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
          else.
        </p>
      </section>
    </main>
  );
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
