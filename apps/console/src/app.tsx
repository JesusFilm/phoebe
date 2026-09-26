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
// Before any of that, the version handshake. `GET /api/version` is the first
// thing the console asks any relay, and a relay serving a console protocol below
// this bundle's gets asked nothing else (#525 §4, relay-version.ts): the Relay
// arm says upgrade the relay first and the local arm carries on untouched, which
// is the companion's whole shape — two arms, and one of them being unusable is
// not the window being unusable.
//
// The stream does the updating. The page reads the fleet once, subscribes, and
// then only applies events (#542) — there is no polling loop and no refetch on a
// timer. What does tick is a clock, once a second, because half the facts on
// screen are durations and a duration that stops moving reads as a page that has
// stopped listening.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RELAY_EVENTS, RELAY_ROUTES } from "phoebe-agent/contracts";
import type {
  AlertBody,
  CompanionUpdate,
  DesktopBridge,
  LocalInstall,
  LocalReportEvent,
  RelayIdentity,
  VerbRunRequest,
  CompanionEnvironment,
  InstallPatch,
} from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import {
  readRelayVersion,
  RELAY_UPGRADE_DOC,
  tooOldText,
  type RelayVersionReading,
} from "./relay-version.ts";
import { readEditAnswer, type EditAnswer } from "./config-edit.ts";
import { DeploymentPage, NoSuchDeployment } from "./deployment-page.tsx";
import { rowFacts, sortFleet, type RowFacts } from "./facts.ts";
import { applyEvent, EMPTY_FLEET, loadFleet, type FleetState } from "./fleet-state.ts";
import { FleetPage } from "./fleet-page.tsx";
import {
  consoleThemeChoiceOf,
  SYSTEM_CONSOLE_THEME,
  type ConsoleThemeChoice,
} from "./console-themes.ts";
import { ConsoleView, useSystemDark } from "./console-view.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { hostOfProcessPlatform } from "./host-icon.tsx";
import { InstallPage } from "./install-page.tsx";
import { pairedInstalls, type InstallAction, type RailChild } from "./local-install.ts";
import {
  busyInstalls,
  NO_ACTIVITY,
  runAnswered,
  runAsked,
  runEnded,
  runSeen,
  type RunActivity,
} from "./run-activity.ts";
import { PeoplePage } from "./people-page.tsx";
import { createNotifier, type AlertSubject, type Notifiable } from "./notifications.ts";
import { Rail } from "./rail.tsx";
import { isNotSignedIn, type RelayClient, type RelaySignIn } from "./relay-client.ts";
import { configOf } from "./report.ts";
import { ADD_HREF, FLEET_HREF, FLEET_ROUTE, PEOPLE_HREF, parseRoute, type Route } from "./route.ts";

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
  const [relay, setRelay] = useState<RelayVersionReading | null>(null);

  useEffect(() => {
    let live = true;
    void readRelayVersion(client).then((reading) => {
      if (live) setRelay(reading);
    });
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    // The gate: nothing is asked of a relay that has not answered its version,
    // and nothing more is asked of one that answered too low.
    if (relay === null || relay.kind === "too-old") return;
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
  }, [client, relay]);

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

  const refusal = relay?.kind === "too-old" ? tooOldText(relay.relay) : undefined;

  // A browser was served this bundle by the relay it is refusing, so this is a
  // case that should not arise — and if it ever does, the page says which end to
  // move rather than rendering a fleet read off an API it does not speak.
  if (refusal !== undefined && surface === "browser") {
    return (
      <Notice title="Phoebe console">
        <p>{refusal}</p>
        <p>
          <a href={RELAY_UPGRADE_DOC}>How to upgrade the relay</a>
        </p>
      </Notice>
    );
  }

  if (session.kind === "asking" && refusal === undefined) {
    return <Notice title="Phoebe console">Signing in…</Notice>;
  }
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
      {...(refusal !== undefined ? { refusal } : {})}
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
  refusal,
  onSignedOut,
}: {
  client: RelayClient;
  surface: Surface;
  bridge: DesktopBridge | null;
  identity: RelayIdentity | null;
  /** The relay-too-old sentence, when that is where this relay stands. */
  refusal?: string;
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
  // Which of an install's two views is up: the console the rail opens
  // (console-view.tsx), or the tabbed page behind its gear (install-page.tsx).
  // A workspace child opens the console on its own lines.
  const [openView, setOpenView] = useState<"console" | "settings">("console");
  const [openTenant, setOpenTenant] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  // Default on (#524 §8), and read back off `companion.json` the moment main
  // answers. A browser never asks — there is nothing there to notify with.
  const [notifications, setNotifications] = useState(true);
  // The console's colour theme (console-themes.ts): the operator's preference,
  // read with the rest and written back through the bridge when the picker moves.
  const [consoleTheme, setConsoleTheme] = useState<ConsoleThemeChoice>(SYSTEM_CONSOLE_THEME);
  const systemDark = useSystemDark();
  const chooseNotifications = (wanted: boolean): void => {
    setNotifications(wanted);
    // Asked on first enable and never again — the OS remembers its own
    // answer, and a companion that asked on every launch would be the thing
    // the preference exists to stop (#524 §8).
    if (wanted && typeof Notification !== "undefined") void Notification.requestPermission();
    if (bridge === null) return;
    void bridge.preferences
      .set({ notifications: wanted, consoleTheme })
      .then((saved) => setNotifications(saved.notifications), ignore);
  };
  const chooseConsoleTheme = (choice: ConsoleThemeChoice): void => {
    setConsoleTheme(choice);
    if (bridge === null) return;
    void bridge.preferences
      .set({ notifications, consoleTheme: choice })
      .then((saved) => setConsoleTheme(consoleThemeChoiceOf(saved.consoleTheme)), ignore);
  };
  const now = useNow(1000);

  // The two arms share one page area, and an open install wins it. A rail link
  // into the relay arm moves the hash, so following one closes the install —
  // otherwise the address would change and the page would not.
  useEffect(() => {
    setOpenInstall(null);
  }, [route]);

  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    bridge.preferences.get().then((preferences) => {
      if (!live) return;
      setNotifications(preferences.notifications);
      setConsoleTheme(consoleThemeChoiceOf(preferences.consoleTheme));
    }, ignore);
    return () => {
      live = false;
    };
  }, [bridge]);

  // Bring the window forward and land on the page the alert is about (#524 §6).
  // A local install has a page here; a deployment's five tabs are #544's, so
  // until they exist a click on a relay alert does the half it can — the window
  // comes up on the fleet, which is where the row is.
  const openAlert = useCallback((notifiable: Notifiable) => {
    globalThis.focus();
    const subject = notifiable.subject;
    if (subject?.arm === "local") setOpenInstall(subject.install);
  }, []);

  const notifier = useMemo(
    () =>
      typeof Notification === "undefined"
        ? null
        : createNotifier({ Notification, open: openAlert }),
    [openAlert],
  );

  // The preference through a ref, and not as a dependency. Both subscriptions
  // below read `notify`, and one of them is the relay's event stream — if
  // flipping a checkbox changed this function, it would tear that stream down
  // and re-read the whole fleet behind it. What the ref buys is that the
  // preference is read at the moment an alert lands, which is also the only
  // moment it means anything.
  const wanted = useRef(notifications);
  wanted.current = notifications;

  /**
   * Show one alert, unless the operator has turned notifications off or is
   * already looking at the window (#524 §6, §8).
   */
  const notify = useCallback(
    (alert: AlertBody, arm: AlertSubject["arm"]) => {
      notifier?.show({
        alert,
        arm,
        enabled: wanted.current,
        focused: typeof document === "undefined" ? false : document.hasFocus(),
      });
    },
    [notifier],
  );

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

  // The local arm's alerts. Main runs the edge rule over each read and sends
  // only what crossed, so there is nothing to compare here — an event that
  // arrived is an edge, and an edge is worth a banner (#524 §3).
  useEffect(() => {
    if (bridge === null) return;
    return bridge.installs.alerts((event) => notify(event.alert, "local"));
  }, [bridge, notify]);

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

  // `inside: "wsl"` opens the picker among the distros. The Windows picker cannot
  // be typed into and keeps WSL under a "Linux" node at the foot of its tree, so
  // a folder inside a distro is reached by starting the picker there.
  const addInstall = useCallback(
    (inside?: "wsl") => {
      if (bridge === null) return;
      void bridge.installs.pick(inside).then(async (dir) => {
        if (dir === null) return;
        setInstalls(await bridge.installs.add(dir));
        // Straight to its page. A folder that already carries a config is adopted
        // as it stands and needs nothing; one that does not lands on the install
        // tab, which is where init is (#526).
        setOpenInstall(dir);
      });
    },
    [bridge],
  );

  // Whether this machine has WSL distros to pick inside. Asked once: a distro
  // installed while the window is open is a relaunch away.
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  // And which host this is, for the rail's icon on every local install.
  const [platform, setPlatform] = useState<string | null>(null);
  // The whole answer too, for the settings page's account of this companion.
  const [environment, setEnvironment] = useState<CompanionEnvironment | null>(null);
  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    bridge.environment().then(
      (probed) => {
        if (!live) return;
        setWslDistros(probed.wslDistros);
        setPlatform(probed.platform);
        setEnvironment(probed);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge]);

  // Which installs have a run in flight, for the rail's spinner
  // (run-activity.ts). Runs the rail starts are known from their id; runs the
  // page starts are learned from their first line, by asking main which
  // install's current run that is.
  const [activity, setActivity] = useState<RunActivity>(NO_ACTIVITY);
  const activityRef = useRef(activity);
  activityRef.current = activity;
  useEffect(() => {
    if (bridge === null) return;
    const offLines = bridge.runs.lines((line) => {
      if (activityRef.current.runs.has(line.runId)) return;
      for (const install of installs) {
        void bridge.runs.current(install.dir).then((current) => {
          if (current !== null && current.runId === line.runId && current.exit === undefined) {
            setActivity((held) => runSeen(held, line.runId, install.dir));
          }
        }, noop);
      }
    });
    const offExits = bridge.runs.exits((exit) => {
      setActivity((held) => runEnded(held, exit.runId));
    });
    return () => {
      offLines();
      offExits();
    };
  }, [bridge, installs]);

  /** Start one run from the rail and keep the spinner honest about it. */
  const startTracked = useCallback(
    async (request: VerbRunRequest): Promise<string | null> => {
      if (bridge === null) return null;
      setActivity((held) => runAsked(held, request.install));
      let runId: string | null = null;
      try {
        runId = await bridge.runs.start(request);
      } catch {
        runId = null;
      }
      setActivity((held) => runAnswered(held, request.install, runId));
      return runId;
    },
    [bridge],
  );

  /** One shortcut, as the runs it is (local-install.ts, `InstallAction`). */
  const runAction = useCallback(
    async (dir: string, action: InstallAction): Promise<void> => {
      if (bridge === null) return;
      switch (action) {
        case "start":
          await startTracked({ install: dir, verb: "start" });
          return;
        case "pause":
          await startTracked({ install: dir, verb: "stop" });
          return;
        case "stop":
          await startTracked({ install: dir, verb: "stop", now: true });
          return;
        case "restart": {
          const stopped = await startTracked({ install: dir, verb: "stop" });
          if (stopped === null) return;
          await exitOf(bridge, dir, stopped);
          await startTracked({ install: dir, verb: "start" });
          return;
        }
      }
    },
    [bridge, startTracked],
  );

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

  // A change to an install's own settings. A moved folder is a new key for
  // everything the window holds by directory, so the open page follows it.
  const updateInstall = useCallback(
    async (dir: string, patch: InstallPatch): Promise<void> => {
      if (bridge === null) return;
      const { installs: next, dir: now } = await bridge.installs.update(dir, patch);
      setInstalls(next);
      // Main answers the directory as it stored it, so the open page follows a
      // move to the key the list now carries — not to the path as picked, and
      // not to a guess against a list that may have changed meanwhile.
      if (now !== dir) setOpenInstall((current) => (current === dir ? now : current));
    },
    [bridge],
  );

  const open = installs.find((install) => install.dir === openInstall) ?? null;
  const update = useCompanionUpdate(bridge);

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
      // The relay's own sink for the same edge rule (#524 §1). A browser has
      // no notifier and drops it; the companion raises it.
      if (event.type === RELAY_EVENTS.alert) {
        notify(event.alert, "relay");
        return;
      }
      setFleet((state) => applyEvent(state, event));
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client, identity, notify, onSignedOut]);

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
          <a
            href={FLEET_HREF}
            className={route.page === "fleet" || route.page === "deployment" ? "current" : ""}
          >
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
          {...(refusal !== undefined ? { refusal } : {})}
          installs={installs}
          paired={pairedDirs}
          selected={openInstall}
          selectedDeployment={
            openInstall === null && route.page === "deployment" ? route.fingerprint : null
          }
          onSelect={(dir) => {
            setOpenView("console");
            setOpenTenant(null);
            setOpenInstall(dir);
          }}
          reports={reports}
          {...(platform === null ? {} : { platform })}
          update={update}
          {...(bridge === null
            ? {}
            : {
                // To the home page, where the ways to add are laid out — a
                // folder, a WSL folder, a relay — rather than into one picker.
                // The route change closes whichever install was open.
                onAdd: () => {
                  // Closed here as well as by the route effect: when the hash
                  // is already `#/add`, setting it again changes nothing.
                  setOpenInstall(null);
                  window.location.hash = ADD_HREF;
                },
                // Neither call answers with anything the rail draws: what the
                // click did arrives as the next pushed state, and a refusal is
                // main saying the button was not the next step — which is a
                // state the notice had already stopped offering.
                busy: busyInstalls(activity),
                // The gear is the tabbed page; a workspace child is the
                // console, on the child's own lines.
                onSettings: (dir: string) => {
                  setOpenView("settings");
                  setOpenTenant(null);
                  setOpenInstall(dir);
                },
                onChild: (dir: string, child: RailChild) => {
                  setOpenView("console");
                  setOpenTenant(child.slug);
                  setOpenInstall(dir);
                },
                // The rail's shortcuts. The page opens first so the run's lines
                // have somewhere to land; a refusal (`busy`, most likely) is
                // the page's to show from the run it reads on mount.
                onAction: (dir: string, action: InstallAction) => {
                  setOpenInstall(dir);
                  void runAction(dir, action);
                },
                onDownload: () => void bridge.updates.download().catch(noop),
                onRestart: () => void bridge.updates.restart().catch(noop),
              })}
          signIn={signIn}
          onSignedIn={onSignedIn}
        />
        {open !== null && bridge !== null && openView === "console" ? (
          <ConsoleView
            key={`${open.dir}#${openTenant ?? ""}`}
            bridge={bridge}
            install={open}
            host={
              open.wsl === undefined
                ? platform === null
                  ? null
                  : hostOfProcessPlatform(platform)
                : "wsl"
            }
            tenant={openTenant}
            theme={consoleTheme}
            onSettings={() => setOpenView("settings")}
          />
        ) : open !== null && bridge !== null ? (
          <InstallPage
            key={open.dir}
            install={open}
            bridge={bridge}
            onConsole={() => {
              setOpenTenant(null);
              setOpenView("console");
            }}
            report={reports[open.dir] ?? null}
            now={now}
            signedIn={identity !== null}
            paired={paired.has(open.dir)}
            onUpdate={updateInstall}
            onForget={forgetInstall}
          />
        ) : route.page === "settings" ? (
          <SettingsPage
            surface={surface}
            environment={environment}
            systemDark={systemDark}
            notifications={notifications}
            consoleTheme={consoleTheme}
            {...(bridge === null
              ? {}
              : { onNotifications: chooseNotifications, onConsoleTheme: chooseConsoleTheme })}
          />
        ) : identity === null || route.page === "add" ? (
          <CompanionHome
            installs={installs}
            onAdd={bridge === null ? undefined : () => addInstall()}
            onAddWsl={
              bridge === null || wslDistros.length === 0 ? undefined : () => addInstall("wsl")
            }
            relay={identity === null ? null : { url: relayUrl, email: identity.email }}
            {...(refusal !== undefined ? { refusal } : {})}
          />
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
  onAddWsl,
  relay,
  refusal,
}: {
  installs: LocalInstall[];
  onAdd: (() => void) | undefined;
  /** The picker opened among the WSL distros. Only on a machine that has some. */
  onAddWsl: (() => void) | undefined;
  /** The relay this companion is signed in to, or null when it is signed out. */
  relay: { url: string | null; email: string } | null;
  refusal?: string;
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
            {onAddWsl === undefined
              ? null
              : " A folder inside a WSL distro counts, and its Docker is asked inside the distro."}
          </p>
        ) : (
          <p className="muted">
            {installs.length} local install{installs.length === 1 ? "" : "s"}. Pick one on the rail
            to take it from nothing to running.
          </p>
        )}
        {onAdd === undefined ? null : (
          <p className="actions">
            <button type="button" onClick={onAdd}>
              Add a folder
            </button>
            {onAddWsl === undefined ? null : (
              <button type="button" onClick={onAddWsl}>
                Add a WSL folder
              </button>
            )}
          </p>
        )}
      </section>
      <section>
        <h2>Relay</h2>
        {refusal === undefined && relay !== null ? (
          <p className="muted">
            Signed in as {relay.email}
            {relay.url === null ? "" : ` to ${relay.url}`}. Its deployments are on the rail; to
            reach a different relay, sign out first.
          </p>
        ) : refusal === undefined ? (
          <p className="muted">
            Not signed in. A relay is how the companion reaches the deployments that run somewhere
            else. Enter its address in the rail and sign-in opens in your own browser.
          </p>
        ) : (
          <p className="refusal">
            {refusal} <a href={RELAY_UPGRADE_DOC}>How to upgrade the relay</a>
          </p>
        )}
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
/** Resolves when the run with this id exits — a restart's wait between its halves. */
function exitOf(bridge: DesktopBridge, dir: string, runId: string): Promise<void> {
  return new Promise((resolve) => {
    const off = bridge.runs.exits((exit) => {
      if (exit.runId !== runId) return;
      off();
      resolve();
    });
    // The exit may have come and gone before this subscription existed; main
    // still holds the install's last run, so ask it once.
    void bridge.runs.current(dir).then((current) => {
      if (current !== null && current.runId === runId && current.exit !== undefined) {
        off();
        resolve();
      }
    }, noop);
  });
}

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

/**
 * The companion's own update, as main knows it (#525 §3). One read and then
 * main's pushes, the same shape as every other fact the bridge carries: the
 * check runs in main, so the window is a reader of it and never a driver.
 * Null in a browser, which has no bridge and updates with a reload.
 */
function useCompanionUpdate(bridge: DesktopBridge | null): CompanionUpdate | null {
  const [update, setUpdate] = useState<CompanionUpdate | null>(null);

  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    bridge.updates.state().then(
      (state) => {
        if (live) setUpdate(state);
      },
      () => undefined,
    );
    const unsubscribe = bridge.updates.changes((changed) => setUpdate(changed));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  return update;
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

function noop(): void {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
