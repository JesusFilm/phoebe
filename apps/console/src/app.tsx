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
  BootstrapNeed,
  BootstrapPlan,
  BootstrapRun,
  BootstrapTool,
  CompanionUpdate,
  DesktopBridge,
  HarnessReport,
  LocalInstall,
  LocalReportEvent,
  RemoteRecord,
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
import {
  availableUpdates,
  claudeAuthProblem,
  rootProblem,
  toolsProblem,
  updatesReading,
  volumesProblem,
  updatesSignature,
  type AvailableUpdate,
} from "./harness.ts";
import { InstallPage } from "./install-page.tsx";
import { TenantPage } from "./tenant-page.tsx";
import {
  dockerReading,
  type InstallAction,
  type RailChild,
  type RailProblem,
} from "./local-install.ts";
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
import { AddRemote } from "./add-remote.tsx";
import { Rail } from "./rail.tsx";
import { RemotePage } from "./remote-page.tsx";
import { defaultDeviceLabel, hostSections, localJoins, remoteJoins } from "./remote-routes.ts";
import {
  ADD_HREF,
  HOME_HREF,
  HOME_ROUTE,
  parseRoute,
  remoteHref,
  SETUP_HREF,
  type Route,
} from "./route.ts";
import { SetupPage } from "./setup-page.tsx";
import { readContext, textToCopy } from "./context-menu.ts";
import { CLI_CHANNEL } from "./logs-channels.ts";
import { UpdateAlerts } from "./update-alert.tsx";
import { exitOf } from "./verb-run.ts";

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
  const [openView, setOpenView] = useState<"console" | "settings" | "tenant">("console");
  // The tenant whose config is open, by folder (tenant-page.tsx).
  const [openChild, setOpenChild] = useState<string | null>(null);
  const [openTenant, setOpenTenant] = useState<string | null>(null);
  // The console tab somebody asked for by name: `cli`, to watch a verb run.
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  // Default on (#524 §8), and read back off `companion.json` the moment main
  // answers. A browser never asks — there is nothing there to notify with.
  const [notifications, setNotifications] = useState(true);
  // The console's colour theme (console-themes.ts): the operator's preference,
  // read with the rest and written back through the bridge when the picker moves.
  const [consoleTheme, setConsoleTheme] = useState<ConsoleThemeChoice>(SYSTEM_CONSOLE_THEME);
  // Off until the operator asks for it: the check asks npm and Cursor.
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(false);
  // The last harness report per install, from a page's check or the automatic one.
  const [harnessReports, setHarnessReports] = useState<Record<string, HarnessReport>>({});
  const systemDark = useSystemDark();
  const chooseNotifications = (wanted: boolean): void => {
    setNotifications(wanted);
    // Asked on first enable and never again — the OS remembers its own
    // answer, and a companion that asked on every launch would be the thing
    // the preference exists to stop (#524 §8).
    if (wanted && typeof Notification !== "undefined") void Notification.requestPermission();
    if (bridge === null) return;
    void bridge.preferences
      .set({ notifications: wanted, consoleTheme, autoCheckUpdates })
      .then((saved) => setNotifications(saved.notifications), ignore);
  };
  const chooseAutoCheckUpdates = (wanted: boolean): void => {
    setAutoCheckUpdates(wanted);
    if (bridge === null) return;
    void bridge.preferences
      .set({ notifications, consoleTheme, autoCheckUpdates: wanted })
      .then((saved) => setAutoCheckUpdates(saved.autoCheckUpdates === true), ignore);
  };
  const chooseConsoleTheme = (choice: ConsoleThemeChoice): void => {
    setConsoleTheme(choice);
    if (bridge === null) return;
    void bridge.preferences
      .set({ notifications, consoleTheme: choice, autoCheckUpdates })
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
      setAutoCheckUpdates(preferences.autoCheckUpdates === true);
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
    if (subject?.arm === "remote") window.location.hash = remoteHref(subject.deploymentId);
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

  // What each install could move to, by its last harness report. The alert, the
  // rail's count and the notification are all this one reading.
  const updatesByInstall = useMemo(() => {
    const found: Record<string, AvailableUpdate[]> = {};
    for (const install of installs) {
      const updates = availableUpdates(
        install,
        reports[install.dir] ?? null,
        harnessReports[install.dir] ?? null,
      );
      if (updates.length > 0) found[install.dir] = updates;
    }
    return found;
  }, [installs, reports, harnessReports]);

  useEffect(() => {
    if (bridge === null) return;
    return bridge.harness.reports(({ install, report }) => {
      setHarnessReports((held) => ({ ...held, [install]: report }));
    });
  }, [bridge]);

  // What is wrong with each install itself, off the same reports: a container
  // that runs as root, one that cannot write its volumes, a tool its commands
  // need and the container lacks. The rail's badge and the console's header both read it.
  const installProblems = useMemo(() => {
    const found: Record<string, RailProblem[]> = {};
    for (const install of installs) {
      const problems = [
        ...rootProblem(install, reports[install.dir] ?? null, harnessReports[install.dir] ?? null),
        ...volumesProblem(harnessReports[install.dir] ?? null),
        ...toolsProblem(install, reports[install.dir] ?? null, harnessReports[install.dir] ?? null),
        ...claudeAuthProblem(harnessReports[install.dir] ?? null),
      ];
      if (problems.length > 0) found[install.dir] = problems;
    }
    return found;
  }, [installs, reports, harnessReports]);

  // Each install is read once per state it is in, with nothing asked of the
  // network: a file and a container, or an image when it is stopped. Without
  // this the rail would know about a root container only after somebody had
  // opened the install's page.
  const readLocally = useRef<Record<string, string>>({});
  useEffect(() => {
    if (bridge === null) return;
    for (const install of installs) {
      if (install.state === "not-initialised") continue;
      const standing = `${install.state}:${install.containerVersion ?? ""}`;
      if (readLocally.current[install.dir] === standing) continue;
      readLocally.current[install.dir] = standing;
      void bridge.harness.check(install.dir, { lookUp: false }).catch(ignore);
    }
  }, [bridge, installs]);

  // One notification per set of updates: what was said is not said again until
  // what is on offer changes.
  const toldUpdates = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const install of installs) {
      const updates = updatesByInstall[install.dir];
      if (updates === undefined) continue;
      const signature = updatesSignature(updates);
      if (toldUpdates.current[install.dir] === signature) continue;
      toldUpdates.current[install.dir] = signature;
      notifier?.raise(
        {
          tag: `${install.dir}:updates`,
          title: install.name,
          body: `Updates are available: ${updatesReading(updates)}.`,
          subject: { arm: "local", install: install.dir },
          pipeline: null,
        },
        {
          enabled: wanted.current,
          focused: typeof document === "undefined" ? false : document.hasFocus(),
        },
      );
    }
  }, [installs, updatesByInstall, notifier]);

  // The right-click menu (context-menu.ts). Electron draws none by itself; the
  // page says what was clicked and main draws the OS's, then the page copies.
  useEffect(() => {
    if (bridge === null || typeof document === "undefined") return;
    const onContextMenu = (event: MouseEvent): void => {
      const read = readContext(
        event.target instanceof Element ? event.target : null,
        document.getSelection()?.toString() ?? "",
      );
      if (read === null) return;
      event.preventDefault();
      void bridge.menu.show(read.request).then(
        (choice) => {
          const text = textToCopy(choice, read);
          if (text !== null) void navigator.clipboard.writeText(text).catch(ignore);
          if (choice === "select-all" && read.box instanceof Element) {
            const range = document.createRange();
            range.selectNodeContents(read.box);
            const selection = document.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        },
        (error: unknown) => {
          // A folder or terminal that would not open: main says why, and the
          // page has no banner for it, so the reason goes where a devtools
          // pane can read it.
          console.warn("The right-click's choice was refused:", error);
        },
      );
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [bridge]);

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

  // The remote arm (map #690): the paired records, one read and then main's
  // pushes. A supervisor emission replaces its record whole — the record is
  // the report and the reachability together, the way a local read is.
  const [remotes, setRemotes] = useState<RemoteRecord[]>([]);
  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    bridge.remotes.list().then(
      (listed) => {
        if (live) setRemotes(listed);
      },
      () => undefined,
    );
    const offChanges = bridge.remotes.changes((changed) => setRemotes(changed));
    const offReports = bridge.remotes.reports((event) =>
      setRemotes((held) =>
        held.some((record) => record.deploymentId === event.deploymentId)
          ? held.map((record) =>
              record.deploymentId === event.deploymentId ? event.record : record,
            )
          : [...held, event.record],
      ),
    );
    const offAlerts = bridge.remotes.alerts((event) => notify(event.alert, "remote"));
    return () => {
      live = false;
      offChanges();
      offReports();
      offAlerts();
    };
  }, [bridge, notify]);

  // This machine's Tailscale, asked once a minute: main caches the answer, and
  // the rail's line above the host sections is read off it.
  const [tailscale, setTailscale] = useState<{ running: boolean; detail: string } | null>(null);
  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    const ask = (): void => {
      bridge.remotes.tailscale().then(
        (answer) => {
          if (live) setTailscale(answer);
        },
        () => undefined,
      );
    };
    ask();
    const timer = setInterval(ask, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [bridge]);

  // The add-remote modal: open from the rail or the home page, or from a
  // blocked row with its address filled in (pair again).
  const [adding, setAdding] = useState<{ prefill: string } | null>(null);
  const pairAgain = useCallback((record: RemoteRecord) => setAdding({ prefill: record.url }), []);

  /** A pair landed: the record joins the list, or replaces the one it re-paired. */
  const paired = useCallback((record: RemoteRecord) => {
    setRemotes((held) =>
      held.some((candidate) => candidate.deploymentId === record.deploymentId)
        ? held.map((candidate) =>
            candidate.deploymentId === record.deploymentId ? record : candidate,
          )
        : [...held, record],
    );
  }, []);

  /** Sign out removes the row; forget drops a blocked one without a request. */
  const dropRemote = useCallback(
    (record: RemoteRecord, how: "signOut" | "forget") => {
      if (bridge === null) return;
      const call = how === "signOut" ? bridge.remotes.signOut : bridge.remotes.forget;
      void call(record.deploymentId).then(
        () => {
          setRemotes((held) =>
            held.filter((candidate) => candidate.deploymentId !== record.deploymentId),
          );
          if (window.location.hash.startsWith(`#/r/${encodeURIComponent(record.deploymentId)}`)) {
            window.location.hash = HOME_HREF;
          }
        },
        () => undefined,
      );
    },
    [bridge],
  );

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

  // Coming back to the window is a read too. A stopped install is not polled,
  // so a config edited in a terminal would otherwise sit unseen behind a form
  // still holding the old text, and the next edit from here would be refused as
  // stale.
  useEffect(() => {
    if (bridge === null || openInstall === null || typeof window === "undefined") return;
    const reread = (): void => {
      bridge.installs.refresh(openInstall).then(
        (event) => setReports((held) => ({ ...held, [event.install]: event })),
        () => undefined,
      );
    };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [bridge, openInstall]);

  // `inside: "wsl"` opens the picker among the distros. The Windows picker cannot
  // be typed into and keeps WSL under a "Linux" node at the foot of its tree, so
  // a folder inside a distro is reached by starting the picker there.
  const addInstall = useCallback(
    (inside?: "wsl") => {
      if (bridge === null) return;
      void bridge.installs.pick(inside).then(async (dir) => {
        if (dir === null) return;
        const added = await bridge.installs.add(dir);
        setInstalls(added);
        // Straight to its page. A folder that already carries a deployment is
        // adopted as it stands and opens on its console; one that does not opens
        // on the install tab, where init is, or the offer to run a tenant's
        // folder on its own (#526).
        const state = added.find((install) => install.dir === dir)?.state;
        setOpenView(state === "not-initialised" ? "settings" : "console");
        setOpenTenant(null);
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
    const take = (probed: CompanionEnvironment): void => {
      if (!live) return;
      setWslDistros(probed.wslDistros);
      setPlatform(probed.platform);
      setEnvironment(probed);
    };
    bridge.environment().then(take, () => undefined);
    // Main pushes the facts again as Docker comes up after a setup step.
    const stop = bridge.environmentChanges(take);
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);

  // Setting up this machine (setup-page.tsx): the plan main offers, read again
  // whenever the facts move, and the step running now with its lines.
  const { plan: setupPlan, run: setupRun, runStep } = useBootstrap(bridge, environment);

  // The first thing a machine without Docker sees is the setup page, once per
  // launch. A later launch asks again, because a stopped Docker Desktop is the
  // commonest reason to be here and it is a thing that happens between two
  // launches. "Continue without Docker" is the way past it.
  const sentToSetup = useRef(false);
  useEffect(() => {
    if (environment === null || sentToSetup.current) return;
    sentToSetup.current = true;
    if (dockerReading(environment).kind === "ready") return;
    if (parseRoute(window.location.hash).page === "home") window.location.hash = SETUP_HREF;
  }, [environment]);

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
  // The join (map #690, #699): a deployment that is a folder here and also
  // paired shows twice, once per route, each with a chip to the other.
  const joinsByInstall = useMemo(
    () => localJoins(installs, reports, remotes),
    [installs, reports, remotes],
  );
  const joinsByRemote = useMemo(
    () => remoteJoins(installs, reports, remotes),
    [installs, reports, remotes],
  );
  const openRemote =
    route.page === "remote"
      ? (remotes.find((record) => record.deploymentId === route.deploymentId) ?? null)
      : null;
  const deviceLabel = defaultDeviceLabel(null);

  return (
    <div className="frame">
      <Rail
        surface={surface}
        installs={installs}
        selected={openInstall}
        selectedChild={openView === "tenant" ? openChild : null}
        onSelect={(dir) => {
          setOpenView("console");
          setOpenTenant(null);
          setOpenChannel(null);
          setOpenInstall(dir);
        }}
        // The brand is home. The route effect closes the install when the
        // hash moves; when it is already home's nothing moves, so close it
        // here too — the same guard `onAdd` carries below.
        onHome={() => setOpenInstall(null)}
        reports={reports}
        updates={Object.fromEntries(
          Object.entries(updatesByInstall).map(([dir, updates]) => [dir, updates.length]),
        )}
        problems={installProblems}
        {...(platform === null ? {} : { platform })}
        update={update}
        remotes={remotes}
        selectedRemote={route.page === "remote" ? route.deploymentId : null}
        now={now}
        tailscale={tailscale}
        localJoins={joinsByInstall}
        remoteJoins={joinsByRemote}
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
                setOpenChannel(null);
                setOpenInstall(dir);
              },
              // A child's gear is that tenant's own config.
              onChildSettings: (dir: string, child: RailChild) => {
                setOpenView("tenant");
                setOpenChild(child.dir);
                setOpenTenant(null);
                setOpenInstall(dir);
              },
              // The rail's shortcuts. The console opens on its cli tab first,
              // so the run's lines have somewhere to land.
              onAction: (dir: string, action: InstallAction) => {
                setOpenView("console");
                setOpenTenant(null);
                setOpenChannel(CLI_CHANNEL);
                setOpenInstall(dir);
                void runAction(dir, action);
              },
              onDownload: () => void bridge.updates.download().catch(noop),
              onRestart: () => void bridge.updates.restart().catch(noop),
              // The machines on the tailnet (map #690): a row opens its remote
              // route, the one add below the sections opens the modal.
              onRemote: (deploymentId: string) => {
                setOpenInstall(null);
                window.location.hash = remoteHref(deploymentId);
              },
              onAddRemote: () => setAdding({ prefill: "" }),
              onPairAgain: pairAgain,
              onOpenRemoteRoute: (record: RemoteRecord) => {
                setOpenInstall(null);
                window.location.hash = remoteHref(record.deploymentId);
              },
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
            remote: openRemote,
            child:
              open?.workspace?.children
                .filter((child) => child.dir === openChild)
                .map((child) => child.slug ?? child.name)[0] ?? null,
          })}
        />
        {bridge === null ? null : (
          <UpdateAlerts
            bridge={bridge}
            installs={installs}
            events={reports}
            reports={harnessReports}
            onReview={(dir) => {
              setOpenView("settings");
              setOpenTenant(null);
              setOpenInstall(dir);
            }}
          />
        )}
        {open !== null && bridge !== null && openView === "console" ? (
          <ConsoleView
            key={`${open.dir}#${openTenant ?? ""}#${openChannel ?? ""}`}
            bridge={bridge}
            install={open}
            channel={openChannel}
            host={
              open.wsl === undefined
                ? platform === null
                  ? null
                  : hostOfProcessPlatform(platform)
                : "wsl"
            }
            report={reports[open.dir] ?? null}
            problems={installProblems[open.dir] ?? []}
            tenant={openTenant}
            theme={consoleTheme}
            onSettings={() => setOpenView("settings")}
          />
        ) : open !== null && bridge !== null && openView === "tenant" && openChild !== null ? (
          <TenantPage
            key={`${open.dir}#${openChild}`}
            install={open}
            tenant={openChild}
            bridge={bridge}
            report={reports[open.dir] ?? null}
            onWorkspace={() => setOpenView("settings")}
          />
        ) : open !== null && bridge !== null ? (
          <InstallPage
            key={open.dir}
            install={open}
            bridge={bridge}
            onTenant={(dir) => {
              setOpenChild(dir);
              setOpenView("tenant");
            }}
            onConsole={() => {
              setOpenTenant(null);
              setOpenChannel(null);
              setOpenView("console");
            }}
            onCli={() => {
              setOpenTenant(null);
              setOpenChannel(CLI_CHANNEL);
              setOpenView("console");
            }}
            report={reports[open.dir] ?? null}
            now={now}
            onUpdate={updateInstall}
            onForget={forgetInstall}
            joined={joinsByInstall[open.dir] ?? null}
            defaultLabel={deviceLabel}
            onOpenRemote={(record) => {
              setOpenInstall(null);
              window.location.hash = remoteHref(record.deploymentId);
            }}
            onPaired={paired}
          />
        ) : route.page === "remote" && bridge !== null ? (
          openRemote === null ? (
            <main className="main">
              <h1>Not paired</h1>
              <p className="muted">
                This companion holds no pairing for{" "}
                <span className="mono">{route.deploymentId}</span>. Add it from the rail with a
                pairing link, or an address and a code.
              </p>
            </main>
          ) : (
            <RemotePage
              key={openRemote.deploymentId}
              record={openRemote}
              bridge={bridge}
              tab={route.tab ?? "overview"}
              now={now}
              joined={joinsByRemote[openRemote.deploymentId] ?? null}
              onTab={(tab) => {
                window.location.hash = remoteHref(openRemote.deploymentId, tab);
              }}
              onPairAgain={pairAgain}
              onSignOut={(record) => dropRemote(record, "signOut")}
              onForget={(record) => dropRemote(record, "forget")}
              onOpenLocal={(install) => {
                setOpenView("console");
                setOpenTenant(null);
                setOpenChannel(null);
                setOpenInstall(install.dir);
              }}
            />
          )
        ) : route.page === "setup" ? (
          <SetupPage
            environment={environment}
            plan={setupPlan}
            run={setupRun}
            {...(bridge === null ? {} : { onRun: runStep })}
          />
        ) : route.page === "settings" ? (
          <SettingsPage
            surface={surface}
            environment={environment}
            systemDark={systemDark}
            notifications={notifications}
            consoleTheme={consoleTheme}
            autoCheckUpdates={autoCheckUpdates}
            update={update}
            {...(bridge === null
              ? {}
              : {
                  onNotifications: chooseNotifications,
                  onConsoleTheme: chooseConsoleTheme,
                  onAutoCheckUpdates: chooseAutoCheckUpdates,
                  onCheckUpdate: () => void bridge.updates.check().catch(noop),
                  onDownloadUpdate: () => void bridge.updates.download().catch(noop),
                  onRestartUpdate: () => void bridge.updates.restart().catch(noop),
                })}
          />
        ) : (
          <CompanionHome
            installs={installs}
            remotes={remotes}
            now={now}
            tailscale={tailscale}
            dockerReady={environment === null || dockerReading(environment).kind === "ready"}
            onAdd={bridge === null ? undefined : () => addInstall()}
            onAddWsl={
              bridge === null || wslDistros.length === 0 ? undefined : () => addInstall("wsl")
            }
            onAddRemote={bridge === null ? undefined : () => setAdding({ prefill: "" })}
            onPairAgain={pairAgain}
          />
        )}
      </section>
      {adding !== null && bridge !== null ? (
        <AddRemote
          bridge={bridge}
          defaultLabel={deviceLabel}
          prefill={adding.prefill}
          records={remotes}
          joinedInstallOf={(deploymentId) =>
            remoteJoins(installs, reports, [{ deploymentId } as RemoteRecord])[deploymentId] ?? null
          }
          tailscaleRunning={tailscale === null ? null : tailscale.running}
          onPaired={paired}
          onClose={() => setAdding(null)}
          onOpen={(deploymentId) => {
            setAdding(null);
            setOpenInstall(null);
            window.location.hash = remoteHref(deploymentId);
          }}
        />
      ) : null}
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
  remotes,
  now,
  tailscale,
  dockerReady,
  onAdd,
  onAddWsl,
  onAddRemote,
  onPairAgain,
}: {
  installs: LocalInstall[];
  /** The paired records, as one heading per host with its cards under it (map #690). */
  remotes: readonly RemoteRecord[];
  now: Date;
  tailscale: { running: boolean; detail: string } | null;
  /** False when Docker is missing or stopped, which is a line and a link to the setup page. */
  dockerReady: boolean;
  onAdd: (() => void) | undefined;
  /** The picker opened among the WSL distros. Only on a machine that has some. */
  onAddWsl: (() => void) | undefined;
  onAddRemote: (() => void) | undefined;
  onPairAgain: (record: RemoteRecord) => void;
}) {
  const sections = hostSections(remotes, now);
  return (
    <main className="main">
      <h1>Phoebe</h1>
      {tailscale !== null && !tailscale.running ? (
        <p className="warning" role="status">
          Tailscale is off on this machine, so no remote below can be reached. Start it; every
          remote retries at once.
        </p>
      ) : null}
      {sections.map((section) => (
        <section key={section.host} className="machine" aria-label={section.host}>
          <h2>
            <span className="mono">{section.host}</span>{" "}
            <span className="muted small">
              {section.rows.length === 1 ? "1 deployment" : `${section.rows.length} deployments`}
            </span>
          </h2>
          <ul className="cards">
            {section.rows.map((row) => (
              <li
                key={row.record.deploymentId}
                className={`cell${row.attention ? " attention" : ""}`}
              >
                <a href={remoteHref(row.record.deploymentId)}>
                  <strong>{row.record.name}</strong>
                </a>{" "}
                <span className={`muted ${row.tone}`}>{row.text}</span>
                {row.blocked === null ? null : (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="quiet"
                      onClick={() =>
                        row.blocked?.action === "update" ? undefined : onPairAgain(row.record)
                      }
                    >
                      {row.blocked.action}
                    </button>
                  </>
                )}
                {row.expiry === null ? null : <div className="warning small">{row.expiry}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {onAddRemote === undefined ? null : (
        <p className="actions">
          <button type="button" onClick={onAddRemote}>
            + add a remote
          </button>{" "}
          <span className="muted small">paste a pairing link, or an address and a code</span>
        </p>
      )}
      <section>
        <h2>This machine</h2>
        {dockerReady ? null : (
          <p className="refusal">
            Docker is not ready on this machine, so no local install can start.{" "}
            <a href={SETUP_HREF}>Set up this machine</a>.
          </p>
        )}
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
 * The setup page's half of the bridge: the plan, read whenever the machine's
 * facts move, and the step running now, followed line by line. Main holds the
 * run, so a window that opens mid-install reads what it has so far.
 */
function useBootstrap(
  bridge: DesktopBridge | null,
  environment: CompanionEnvironment | null,
): {
  plan: BootstrapPlan | null;
  run: BootstrapRun | null;
  runStep: (step: { tool: BootstrapTool; need: BootstrapNeed }) => void;
} {
  const [plan, setPlan] = useState<BootstrapPlan | null>(null);
  const [run, setRun] = useState<BootstrapRun | null>(null);

  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    bridge.bootstrap.plan().then((read) => {
      if (live) setPlan(read);
    }, ignore);
    return () => {
      live = false;
    };
  }, [bridge, environment]);

  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    bridge.bootstrap.current().then((held) => {
      if (live) setRun(held);
    }, ignore);
    const stopLines = bridge.bootstrap.lines((line) =>
      setRun((held) => (held === null ? held : { ...held, lines: [...held.lines, line] })),
    );
    const stopExits = bridge.bootstrap.exits((exit) =>
      setRun((held) => (held === null ? held : { ...held, exit })),
    );
    return () => {
      live = false;
      stopLines();
      stopExits();
    };
  }, [bridge]);

  const runStep = useCallback(
    (step: { tool: BootstrapTool; need: BootstrapNeed }) => {
      if (bridge === null) return;
      bridge.bootstrap.run(step).then(setRun, ignore);
    },
    [bridge],
  );

  return { plan, run, runStep };
}

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
