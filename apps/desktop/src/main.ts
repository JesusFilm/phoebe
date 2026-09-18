// The companion's main process: one window, one privileged scheme, and the
// handlers behind the preload's bridge.
//
// This package is main and preload and nothing else (#521 §5, #522 §5). The
// window's contents are the `apps/console` bundle — the same React app the relay
// serves in a browser — loaded from disk over the console scheme. So there is no
// UI code in here, and a page the operator sees is never written twice.
//
// What main answers today is the local arm in full — the installs on this
// machine, the Docker check, and the verb runs that drive them (#555) — beside a
// relay arm with no session. Main becomes the relay client proper with #554 and
// grows the local read loop with #556; both are changes in here, behind the
// contract the preload already exposes.
//
// Main owns state the window does not: `companion.json`, and the runs in
// flight. Both are here rather than in the renderer for the same reason — a
// reload must not lose them.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import type {
  CompanionEnvironment,
  CompanionPreferences,
  LocalInstall,
  RelayArmState,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import {
  answering,
  BRIDGE_CHANNELS,
  BridgeRefusal,
  refusal,
  type BridgeResult,
} from "./channels.ts";
import {
  addInstall,
  COMPANION_FILE,
  readCompanionFile,
  removeInstall,
  writeCompanionFile,
  type CompanionFile,
} from "./companion-file.ts";
import { CONSOLE_SCHEME, consoleFileFor } from "./console-scheme.ts";
import { consoleSource } from "./console-source.ts";
import { probeDocker } from "./docker.ts";
import { allInstallFacts } from "./install-facts.ts";
import { dispatchVerb } from "./verb-dispatch.ts";
import { createVerbRuns } from "./verb-runs.ts";

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

/** Every window gets every event. There is one today; a second is #524's. */
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
  return allInstallFacts(stored, { dockerPresent: docker.present });
}

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
  dispatch: dispatchVerb,
  onLine: (line) => broadcast(BRIDGE_CHANNELS.runLine, line),
  onExit: (exit) => {
    broadcast(BRIDGE_CHANNELS.runExit, exit);
    // A verb that just started or stopped a container changed the one fact the
    // rail draws, and nothing else is watching for it until #556's read loop.
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

  // A link to a relay, a repository or a doc belongs in the operator's own
  // browser. Nothing in the console opens a second window, so every request for
  // one is that.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void window.loadURL(consoleSource(process.argv));
}

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
      })),
    );

    ipcMain.handle(BRIDGE_CHANNELS.installsList, () => answering(listInstalls));

    ipcMain.handle(BRIDGE_CHANNELS.installsPick, () =>
      answering<string | null>(async () => {
        const picked = await dialog.showOpenDialog({
          title: "Add a local install",
          message: "Pick the repository folder Phoebe runs from.",
          properties: ["openDirectory", "createDirectory"],
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
      answering(() => editInstalls((contents) => removeInstall(contents, dir))),
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

    ipcMain.handle(BRIDGE_CHANNELS.relayState, () =>
      // The url comes off `companion.json` (#527 §12); no device token is held,
      // which is the honest answer until #554 mints one. The console draws the
      // signed-out Relay group from exactly this.
      answering<RelayArmState>(() => ({
        url: readCompanion().relay?.url ?? null,
        person: null,
        persisted: false,
      })),
    );

    for (const channel of [BRIDGE_CHANNELS.relayRequest, BRIDGE_CHANNELS.relaySignOut]) {
      ipcMain.handle(channel, () =>
        refusal({
          code: "signed-out",
          message: "the companion is not signed in to a relay",
        }),
      );
    }

    createWindow();

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
