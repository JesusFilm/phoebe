// The console's shell: the installs on this machine, the rail that lists them,
// and the pane beside it.
//
// Everything it shows arrives over the companion's bridge. The page reads the
// install list once, subscribes, and then only applies what main sends — there
// is no polling loop and no refetch on a timer. What does tick is a clock, once a
// second, because half the facts on screen are durations and a duration that
// stops moving reads as a page that has stopped listening.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AlertBody,
  CompanionUpdate,
  DesktopBridge,
  LocalInstall,
  LocalReportEvent,
  VerbRunRequest,
  CompanionEnvironment,
  InstallPatch,
} from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import {
  consoleThemeChoiceOf,
  SYSTEM_CONSOLE_THEME,
  type ConsoleThemeChoice,
} from "./console-themes.ts";
import { ConsoleView, useSystemDark } from "./console-view.tsx";
import { ChevronRight } from "lucide-react";
import { routeCrumbs, type Crumbs } from "./crumbs.ts";
import { SettingsPage } from "./settings-page.tsx";
import { hostOfProcessPlatform } from "./host-icon.tsx";
import { InstallPage } from "./install-page.tsx";
import type { InstallAction, RailChild } from "./local-install.ts";
import {
  busyInstalls,
  NO_ACTIVITY,
  runAnswered,
  runAsked,
  runEnded,
  runSeen,
  type RunActivity,
} from "./run-activity.ts";
import { createNotifier, type AlertSubject, type Notifiable } from "./notifications.ts";
import { Rail } from "./rail.tsx";
import { ADD_HREF, HOME_ROUTE, parseRoute, type Route } from "./route.ts";

export function App({
  surface,
  bridge = null,
}: {
  surface: Surface;
  /** The companion's bridge, or null in a browser, which has no installs to show. */
  bridge?: DesktopBridge | null;
}) {
  const route = useRoute();
  const [installs, setInstalls] = useState<LocalInstall[]>([]);
  const [reports, setReports] = useState<Record<string, LocalReportEvent>>({});
  const [openInstall, setOpenInstall] = useState<string | null>(null);
  // Which of an install's two views is up: the console the rail opens
  // (console-view.tsx), or the tabbed page behind its gear (install-page.tsx).
  // A workspace child opens the console on its own lines.
  const [openView, setOpenView] = useState<"console" | "settings">("console");
  const [openTenant, setOpenTenant] = useState<string | null>(null);
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

  // An open install wins the pane. A link that moves the hash closes it —
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

  // The preference through a ref, and not as a dependency: flipping a checkbox
  // must not tear down the subscription that reads `notify`. What the ref buys
  // is that the preference is read at the moment an alert lands, which is also
  // the only moment it means anything.
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

  // The installs. One read, then main's `installs:changed` does the updating:
  // the page holds no copy it has to reconcile, and every fact on screen was derived by the
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

  // The local read loop's stream (#556). One subscription for every install rather than one per open
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

  return (
    <div className="frame">
      <Rail
        surface={surface}
        installs={installs}
        selected={openInstall}
        onSelect={(dir) => {
          setOpenView("console");
          setOpenTenant(null);
          setOpenInstall(dir);
        }}
        // The brand is home. The route effect closes the install when the
        // hash moves; when it is already home's nothing moves, so close it
        // here too — the same guard `onAdd` carries below.
        onHome={() => setOpenInstall(null)}
        reports={reports}
        {...(platform === null ? {} : { platform })}
        update={update}
        {...(bridge === null
          ? {}
          : {
              // To the home page, where the ways to add are laid out — a
              // folder, a WSL folder — rather than into one picker.
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
      />
      <section className="pane">
        <RouteLine
          crumbs={routeCrumbs({
            surface,
            route,
            open,
            view: openView,
            tenant: openTenant,
          })}
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
        ) : (
          <CompanionHome
            installs={installs}
            onAdd={bridge === null ? undefined : () => addInstall()}
            onAddWsl={
              bridge === null || wslDistros.length === 0 ? undefined : () => addInstall("wsl")
            }
          />
        )}
      </section>
    </div>
  );
}

/**
 * The companion's home: the installs on this machine, and the ways to add one.
 * Adding is a control here as well as on the rail, because an empty companion
 * has a rail nobody has looked at yet.
 */
function CompanionHome({
  installs,
  onAdd,
  onAddWsl,
}: {
  installs: LocalInstall[];
  onAdd: (() => void) | undefined;
  /** The picker opened among the WSL distros. Only on a machine that has some. */
  onAddWsl: (() => void) | undefined;
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
    </main>
  );
}

/** A read whose failure changes nothing on screen. */
function ignore(): void {}

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
    typeof window === "undefined" ? HOME_ROUTE : parseRoute(window.location.hash),
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

function noop(): void {}

/**
 * The top line of the right pane: where the console is (crumbs.ts), the way T3
 * Code puts the project and thread at the top of its pane. The rail is the map;
 * this is the mark on it.
 */
function RouteLine({ crumbs }: { crumbs: Crumbs }) {
  return (
    <header className="pane-route">
      <nav className="crumbs" aria-label="Where you are">
        {crumbs.map((crumb, index) => (
          <span key={index} className={index === crumbs.length - 1 ? "crumb current" : "crumb"}>
            {index === 0 ? null : <ChevronRight size={13} aria-hidden="true" />}
            <span className="crumb-text">{crumb}</span>
          </span>
        ))}
      </nav>
    </header>
  );
}
