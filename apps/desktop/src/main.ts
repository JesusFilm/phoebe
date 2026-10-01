// The companion's main process: one window, one privileged scheme, and the
// handlers behind the preload's bridge.
//
// This package is main and preload and nothing else (#521 §5, #522 §5). The
// window's contents are the `apps/console` bundle, loaded from disk over the
// console scheme. So there is no
// UI code in here, and a page the operator sees is never written twice.
//
// What main answers is the installs on this machine: the Docker check, the verb
// runs that drive them (#555), the local read loop that feeds their tabs (#556)
// and the two write verbs that change them (#557). Both write verbs run against
// this machine (#526): main writes the file, or execs into the container beside
// it.
//
// Main owns state the window does not: `companion.json`, the runs in flight, the watchers and timers of the read loop, and where the
// companion's own update stands. All of it is
// here rather than in the renderer for the same reason — a reload must not lose
// them.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import electronUpdater from "electron-updater";
import type {
  CompanionEnvironment,
  CompanionPreferences,
  CompanionUpdate,
  LocalInstall,
  LocalReportEvent,
  VerbRun,
  VerbRunRequest,
  InstallPatch,
  InstallRepair,
  RepairOutcome,
} from "phoebe-agent/contracts";
import { createCompanionAlerts } from "./alerting.ts";
import { answering, BRIDGE_CHANNELS, BridgeRefusal, type BridgeResult } from "./channels.ts";
import {
  addInstall,
  COMPANION_FILE,
  readCompanionFile,
  removeInstall,
  writeCompanionFile,
  type CompanionFile,
  updateInstall,
} from "./companion-file.ts";
import { CONSOLE_SCHEME, consoleFileFor } from "./console-scheme.ts";
import { consoleSource } from "./console-source.ts";
import { createContainerLogs } from "./container-logs.ts";
import {
  defaultEventSpawner,
  readContainerReport,
  watchContainerEvents,
} from "./container-read.ts";
import { deploymentDirOf } from "./deployment-dir.ts";
import { probeDocker } from "./docker.ts";
import { CONTAINER_UID, grantEnvAccess, tenantEnvPath } from "./env-access.ts";
import { allInstallFacts, directoryFactsWithAccess, installFacts } from "./install-facts.ts";
import { createLocalReads } from "./local-read.ts";
import {
  defaultCommandRunner,
  formatResolveFailure,
  resolveDeploymentCompose,
} from "../../../src/deployment-compose.ts";
import { createCompanionUpdates } from "./updates.ts";
import { createDispatchVerb } from "./verb-dispatch.ts";
import { createVerbRuns } from "./verb-runs.ts";
import {
  listWslDistros,
  WSL_PICKER_ROOT,
  wslEventSpawner,
  wslLocationOf,
  wslRunner,
} from "./wsl.ts";

// Before `ready`, which is the only time Chromium will take it. `standard` is
// what gives the bundle a real origin — without it there is no `localStorage`,
// no relative URL resolution and no place for a later ticket to key a session
// on; `secure` keeps it out of the mixed-content and insecure-origin rules;
// `supportFetchAPI` lets the bundle's own modules load.
protocol.registerSchemesAsPrivileged([
  {
    scheme: CONSOLE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// One instance: `companion.json`, the read loop and the runs in flight are one
// process's to hold, and a second window onto the same installs would be a
// second writer of the same file.
if (!app.requestSingleInstanceLock()) app.exit(0);

/** The directory the console bundle was built into. */
function consoleBundleDir(): string {
  // Packaged, the bundle sits beside the app's resources; in a checkout it is
  // the directory `apps/console` builds into, three levels up from `dist/`.
  return app.isPackaged
    ? path.join(process.resourcesPath, "console")
    : path.join(import.meta.dirname, "..", "..", "..", "console");
}

/** Where `companion.json` lives. Electron's own per-app directory (#527 §12). */
function companionFile(): string {
  return path.join(app.getPath("userData"), COMPANION_FILE);
}

/** Read the file, turning an unreadable one into a refusal that names it. */
function readCompanion(): CompanionFile {
  try {
    return readCompanionFile(companionFile());
  } catch (error) {
    throw new BridgeRefusal({
      code: "unknown",
      message: error instanceof Error ? error.message : String(error),
      instruction: `Fix or delete ${companionFile()} and reopen the companion.`,
    });
  }
}

/**
 * The alerts the read loop feeds (#524). Built at module scope like the read loop it
 * listens to: a window can come and go, and what has been notified must not.
 */
const alerts = createCompanionAlerts();

/**
 * The dock or taskbar badge: how many deployments and local installs are in a
 * raised condition, and nothing on the icon at all when that is zero (#524 §4).
 *
 * Deliberately not gated on the notifications preference. The preference is
 * about being interrupted; the badge is a number on an icon the operator went
 * looking for, and turning notifications off is not a request to be told less
 * when you do look.
 */
function showBadge(): void {
  app.setBadgeCount(alerts.badge());
}

/** Say something to every open window. There is one today; the cost of two is nil. */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

/**
 * The install list with this moment's facts on it. Derived on every call, which
 * is the whole rule `companion.json` is built around (install-facts.ts).
 */
async function listInstalls(): Promise<LocalInstall[]> {
  const stored = readCompanion().installs;
  const docker = await probeDocker();
  const installs = await allInstallFacts(stored, { dockerPresent: docker.present });
  // Every list is also the loop's list. Adding a folder starts reading it and
  // forgetting one stops, with no second place that has to remember to say so.
  reads.sync(installs);
  return installs;
}

/** One install's facts, for the loop's own re-derivation between lists. */
async function factsFor(dir: string): Promise<LocalInstall | null> {
  const stored = readCompanion().installs.find((install) => install.dir === dir);
  if (stored === undefined) return null;
  const docker = await probeDocker();
  return installFacts(stored, { dockerPresent: docker.present });
}

/**
 * The local read loop (#556). Its seams are the real ones here and stubs in the
 * test: Compose's event stream, one `status --json` exec, and the directory.
 *
 * An install whose folder has no `container/compose.yml` has nothing to watch
 * and nothing to exec, so both seams answer without reaching Docker at all.
 */
const reads = createLocalReads({
  facts: factsFor,
  directory: (install) => directoryFactsWithAccess(install),
  // An install inside a WSL distro is read and watched from inside the distro:
  // its containers are the distro's Docker's, not this machine's (wsl.ts).
  read: async (install) => {
    const deployment = resolveDeploymentCompose(deploymentDirOf(install.dir).dir);
    if ("kind" in deployment) return { ok: false, reason: "no container/compose.yml yet" };
    const wsl = wslLocationOf(install.dir);
    return readContainerReport({
      deployment,
      ...(wsl === null ? {} : { runner: wslRunner(wsl, defaultCommandRunner) }),
    });
  },
  watch: (install, onChange) => {
    const deployment = resolveDeploymentCompose(deploymentDirOf(install.dir).dir);
    if ("kind" in deployment) return () => undefined;
    const wsl = wslLocationOf(install.dir);
    return watchContainerEvents({
      deployment,
      onChange,
      ...(wsl === null ? {} : { deps: { spawn: wslEventSpawner(wsl, defaultEventSpawner) } }),
    });
  },
  emit: (event) => {
    broadcast(BRIDGE_CHANNELS.installsReport, event);
    // Every read is also an edge evaluation (#524 §3). The first read of an
    // install seeds it and raises nothing, so a relaunch onto a fleet that was
    // already wedged does not re-fire everything.
    for (const alert of alerts.local(event)) {
      broadcast(BRIDGE_CHANNELS.installsAlert, alert);
    }
    showBadge();
  },
});

/**
 * The logs pane's streams (container-logs.ts). Lines and endings go to every
 * window, tagged with their install; a pane keeps the ones that are its own.
 */
const logs = createContainerLogs({
  onLine: (line) => broadcast(BRIDGE_CHANNELS.logsLine, line),
  onEnded: (end) => broadcast(BRIDGE_CHANNELS.logsEnded, end),
});

/** Read, change, write, and tell the window. The only writer of the file. */
async function editInstalls(change: (contents: CompanionFile) => CompanionFile) {
  writeCompanionFile(companionFile(), change(readCompanion()));
  const installs = await listInstalls();
  broadcast(BRIDGE_CHANNELS.installsChanged, installs);
  return installs;
}

/**
 * The runs, held for the life of the process. Lines and exits go to every
 * window as they happen; a window that opened late reads the buffer instead
 * (#527 §13).
 */
const runs = createVerbRuns({
  // The dispatch reads an install's state through main's own derivation, so
  // `secret set` picks its writer off the same fact the rail is drawing (#527 §8)
  // — including the Docker probe, which a second reading could disagree about.
  dispatch: createDispatchVerb({
    installState: async (dir) => (await factsFor(dir))?.state ?? "not-initialised",
  }),
  onLine: (line) => broadcast(BRIDGE_CHANNELS.runLine, line),
  onExit: (exit) => {
    broadcast(BRIDGE_CHANNELS.runExit, exit);
    // A verb that just started or stopped a container changed the fact the rail
    // draws. The read loop hears the container move on its own; this is for the
    // verbs that move nothing — an `init` that made a folder initialised has no
    // Docker event behind it.
    void listInstalls().then(
      (installs) => broadcast(BRIDGE_CHANNELS.installsChanged, installs),
      () => undefined,
    );
  },
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    // Painted before the bundle lands, so a dark-mode launch does not flash white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14171c" : "#fafafa",
    title: "Phoebe",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // A link to a repository or a doc belongs in the operator's own
  // browser. Nothing in the console opens a second window, so every request for
  // one is that.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void window.loadURL(consoleSource(process.argv));
}

/** A second launch brings the window that is already open back to the front. */
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window === undefined) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.whenReady().then(
  () => {
    protocol.handle(CONSOLE_SCHEME, async (request) => {
      const file = consoleFileFor(request.url, consoleBundleDir());
      if (file === null) return new Response("not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    ipcMain.handle(BRIDGE_CHANNELS.version, (): BridgeResult<string> => {
      return { ok: true, value: __COMPANION_VERSION__ };
    });

    ipcMain.handle(BRIDGE_CHANNELS.environment, () =>
      answering<CompanionEnvironment>(async () => ({
        companionVersion: __COMPANION_VERSION__,
        platform: process.platform,
        docker: await probeDocker(),
        wslDistros: await listWslDistros(),
      })),
    );

    // The companion's own updates (#525 §3). Built here rather than at import
    // time because the feed it chooses is read from `companion.json`, and the
    // directory that file lives in is Electron's to name once the app is ready.
    const { autoUpdater } = electronUpdater;
    const updates = createCompanionUpdates({
      updater: autoUpdater,
      platform: process.platform,
      packaged: app.isPackaged,
      // The newest stable release there is (update-feed.ts).
      feed: () => Promise.resolve({ kind: "latest" }),
      onChange: (update) => broadcast(BRIDGE_CHANNELS.updateChanged, update),
    });

    // Main is the only listener the updater has; the window hears about all of
    // this through the state the arm keeps.
    autoUpdater.on("update-available", (info) => updates.available(info.version));
    autoUpdater.on("update-not-available", () => updates.notAvailable());
    autoUpdater.on("download-progress", (progress) => updates.progress(progress.percent));
    autoUpdater.on("update-downloaded", (info) => updates.downloaded(info.version));
    autoUpdater.on("error", (error) => updates.failed(error));

    ipcMain.handle(BRIDGE_CHANNELS.updateState, () =>
      answering<CompanionUpdate>(() => updates.state()),
    );
    ipcMain.handle(BRIDGE_CHANNELS.updateDownload, () => answering<void>(updates.download));
    ipcMain.handle(BRIDGE_CHANNELS.updateRestart, () => answering<void>(() => updates.restart()));

    ipcMain.handle(BRIDGE_CHANNELS.installsList, () => answering(listInstalls));

    ipcMain.handle(BRIDGE_CHANNELS.installsPick, (_event, inside?: "wsl") =>
      answering<string | null>(async () => {
        // Opened inside the distros when asked: the Windows picker will not take
        // a typed path, and its own way to WSL is a node at the foot of its tree.
        const picked = await dialog.showOpenDialog({
          title: inside === "wsl" ? "Add a local install from WSL" : "Add a local install",
          message: "Pick the repository folder Phoebe runs from.",
          properties: ["openDirectory", "createDirectory"],
          ...(inside === "wsl" ? { defaultPath: WSL_PICKER_ROOT } : {}),
        });
        return picked.canceled ? null : (picked.filePaths[0] ?? null);
      }),
    );

    ipcMain.handle(BRIDGE_CHANNELS.installsAdd, (_event, dir: string) =>
      // A folder that already carries a config is adopted exactly as it stands
      // (#555): adding it records the directory and derives the rest, and init
      // is a button the operator does not need to press.
      answering(() =>
        editInstalls((contents) => addInstall(contents, dir, new Date().toISOString())),
      ),
    );

    ipcMain.handle(BRIDGE_CHANNELS.installsRemove, (_event, dir: string) =>
      answering(() => {
        // Forgetting a folder drops what it was raising with it. A badge
        // counting an install that is no longer on the rail is a number the
        // operator cannot act on or clear.
        alerts.forgetInstall(dir);
        logs.stop(dir);
        showBadge();
        return editInstalls((contents) => removeInstall(contents, dir));
      }),
    );

    ipcMain.handle(BRIDGE_CHANNELS.installsUpdate, (_event, dir: string, patch: InstallPatch) =>
      answering(async () => {
        // A folder that moves is a new identity for the read loop, the alerts
        // and the logs stream, all keyed by directory: the old one is let go
        // the way forgetting lets it go, and the new one is picked up from the
        // list the change broadcasts. Let go only once the file is written:
        // a refused move — a duplicate, a relative path, a failed write —
        // leaves the entry where it was, and its alerts and logs with it.
        const now = path.resolve(patch.dir ?? dir);
        const installs = await editInstalls((contents) => updateInstall(contents, dir, patch));
        if (now !== path.resolve(dir)) {
          alerts.forgetInstall(dir);
          logs.stop(dir);
          showBadge();
        }
        return { installs, dir: now };
      }),
    );

    ipcMain.handle(BRIDGE_CHANNELS.installsRefresh, (_event, dir: string) =>
      answering<LocalReportEvent>(() => reads.refresh(dir)),
    );

    ipcMain.handle(BRIDGE_CHANNELS.installsRepair, (_event, dir: string, repair: InstallRepair) =>
      answering<RepairOutcome>(async () => {
        const install = await factsFor(dir);
        // Only a folder this install lists as its child: the repair changes a
        // file's permissions, and it does that for nothing outside the install.
        const child = install?.workspace?.children.find(
          (candidate) => candidate.dir === repair.tenant,
        );
        if (install === null || child === undefined) {
          throw new BridgeRefusal({
            code: "refused",
            message: `${repair.tenant} is not a tenant of an install the companion holds`,
          });
        }
        const config = path.join(child.dir, "phoebe.config.ts");
        let configText: string | null = null;
        try {
          configText = readFileSync(config, "utf8");
        } catch {
          configText = null;
        }
        const file = tenantEnvPath(child.dir, configText);
        const how = await grantEnvAccess(install.dir, file);
        // The read after it is what the rail redraws from.
        await reads.refresh(dir).catch(() => undefined);
        return how === "failed"
          ? { fixed: false, detail: `${file} could not be opened to the container's user.` }
          : {
              fixed: true,
              detail:
                how === "acl"
                  ? `The container's user (uid ${CONTAINER_UID}) may now read ${file}, and nobody else gained anything.`
                  : `${file} is now readable by every user on this machine: there was no ACL tool to name the container's user alone.`,
            };
      }),
    );

    ipcMain.handle(BRIDGE_CHANNELS.runStart, (_event, request: VerbRunRequest) =>
      answering<string>(() => runs.start(request)),
    );

    ipcMain.handle(BRIDGE_CHANNELS.runCurrent, (_event, install: string) =>
      answering<VerbRun | null>(() => runs.current(install)),
    );

    ipcMain.handle(BRIDGE_CHANNELS.runCancel, (_event, runId: string) =>
      answering<void>(() => runs.cancel(runId)),
    );

    ipcMain.handle(BRIDGE_CHANNELS.logsFollow, (_event, dir: string) =>
      answering<string[]>(() => {
        const deployment = resolveDeploymentCompose(deploymentDirOf(dir).dir);
        if ("kind" in deployment) {
          throw new BridgeRefusal({
            code: "not-initialised",
            message: formatResolveFailure(deployment),
            instruction: "Init and start this install; its container is what prints logs.",
          });
        }
        // Followed from inside the distro for a WSL install, like every other
        // `docker` the companion spawns for one (wsl.ts).
        const wsl = wslLocationOf(dir);
        const spawner =
          wsl === null ? defaultEventSpawner : wslEventSpawner(wsl, defaultEventSpawner);
        return logs.follow(dir, deployment, spawner);
      }),
    );

    ipcMain.handle(BRIDGE_CHANNELS.logsStop, (_event, dir: string) =>
      answering<void>(() => logs.stop(dir)),
    );

    ipcMain.handle(BRIDGE_CHANNELS.preferencesGet, () =>
      answering<CompanionPreferences>(() => readCompanion().preferences),
    );

    ipcMain.handle(BRIDGE_CHANNELS.preferencesSet, (_event, preferences: CompanionPreferences) =>
      answering<CompanionPreferences>(() => {
        const contents = readCompanion();
        const next = { ...contents, preferences };
        writeCompanionFile(companionFile(), next);
        return next.preferences;
      }),
    );

    createWindow();

    // One check, and no poll (#525 §3). It is fired after the window exists so
    // the first thing the operator sees is the window rather than a wait on
    // github.com, and nothing it finds moves anything on its own.
    void updates.check();

    // macOS keeps the process alive with no windows; clicking the dock icon is
    // the ask for one back.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  },
  (error: unknown) => {
    // Nothing has a window yet, so there is nowhere to draw this but the log.
    console.error("the companion could not start:", error);
    app.exit(1);
  },
);

app.on("before-quit", () => {
  reads.stop();
  logs.stopAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
