// The companion's main process: one window, one privileged scheme, and the
// handlers behind the preload's bridge.
//
// This package is main and preload and nothing else (#521 §5, #522 §5). The
// window's contents are the `apps/console` bundle — the same React app the relay
// serves in a browser — loaded from disk over the console scheme. So there is no
// UI code in here, and a page the operator sees is never written twice.
//
// What main answers is the local arm in full — the installs on this machine,
// the Docker check, and the verb runs that drive them (#555) — beside the relay
// arm, where main is the relay client proper (#523 §1, #554): it holds the
// device token, makes every call, and re-emits the relay's event stream to the
// renderer over IPC. The wiring for that is here; the flow itself is
// relay-session.ts, which needs no Electron to run. The local read loop joins
// with #556, behind the contract the preload already exposes.
//
// Main owns state the window does not: `companion.json`, the device token, and
// the runs in flight. All three are here rather than in the renderer for the
// same reason — a reload must not lose them.

import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  shell,
} from "electron";
import { RELAY_ROUTES } from "phoebe-agent/contracts";
import type {
  CompanionEnvironment,
  CompanionPreferences,
  LocalInstall,
  MintedPairingToken,
  RelayArmState,
  RelayEvent,
  RelayPassthrough,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import { authCodeIn, authCodeInArgv } from "./auth-link.ts";
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
import type { PairArm } from "./pair.ts";
import { companionName, createRelaySession, type RelaySession } from "./relay-session.ts";
import { createTokenVault } from "./vault.ts";
import { createVerbDispatch } from "./verb-dispatch.ts";
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

// One instance, because the sign-in comes back as a URL the OS hands to *an*
// instance. On Windows and Linux that is a fresh process with the URL on its
// command line; the lock turns it into a `second-instance` event on the process
// that is already holding the PKCE verifier, which is the only one that can
// spend the code. Without the lock the second process would hold the code and
// the first would hold the verifier, and neither could finish (#523 §2).
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
 * Claim `phoebe://` with the OS. Packaged, the executable is the app. In a
 * checkout it is Electron's own binary running a directory, so the registration
 * has to name both or the OS launches a bare Electron with no app in it.
 */
function claimScheme(): void {
  if (!process.defaultApp) {
    app.setAsDefaultProtocolClient(CONSOLE_SCHEME);
    return;
  }
  const entry = process.argv[1];
  if (entry !== undefined) {
    app.setAsDefaultProtocolClient(CONSOLE_SCHEME, process.execPath, [path.resolve(entry)]);
  }
}

/**
 * The relay arm, built on `ready` and not before: `safeStorage` cannot say
 * whether Linux has a keyring until the app has one, and the keyring is what
 * decides whether this companion persists a sign-in at all (#523 §5).
 */
let relay: RelaySession | null = null;

function openRelayArm(): RelaySession {
  return createRelaySession({
    vault: createTokenVault({ safeStorage, userDataDir: app.getPath("userData") }),
    // Electron's own stack rather than Node's global `fetch`, so the relay is
    // reached through whatever proxy and certificate store the OS has configured.
    fetch: (url, init) => net.fetch(url, init),
    openExternal: (url) => shell.openExternal(url),
    deviceName: companionName(os.hostname(), process.platform),
    onEvent: (event: RelayEvent) => broadcast(BRIDGE_CHANNELS.relayEvent, event),
    onState: (state: RelayArmState) => broadcast(BRIDGE_CHANNELS.relayArm, state),
  });
}

/**
 * The one place a bridge call reaches the arm. Before `ready` there is no arm,
 * and a renderer cannot be asking — it has no window yet — so this refusal is
 * for the impossible case rather than a state anyone can get into.
 */
function arm(): RelaySession {
  if (relay === null) throw new Error("the companion's relay arm is not open yet");
  return relay;
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
  dispatch: createVerbDispatch({ relayArm: pairArm }),
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

/**
 * The relay arm a pairing mints on, or null when there is no session to mint
 * with. Narrow by construction: the device token stays inside the session, and
 * what pairing gets is one call it is allowed to make (#527 §14).
 */
function pairArm(): PairArm | null {
  const session = relay;
  if (session === null) return null;
  const { person, url } = session.state();
  if (person === null || url === null) return null;
  return {
    url,
    mint: () =>
      session.request({
        method: "POST",
        path: RELAY_ROUTES.pairingTokens,
      }) as Promise<MintedPairingToken>,
  };
}

/**
 * What `pair` needs before it is worth starting (#558).
 *
 * Both refusals are states the install tab already disables the control for;
 * this is what answers a renderer that asked anyway — an operator who signed
 * out in another window, or a container that stopped between the render and the
 * click. Checked here rather than inside the run because a refusal with an
 * instruction on it is more use than a run that starts and immediately fails.
 */
async function assertPairable(install: string): Promise<void> {
  if (pairArm() === null) {
    throw new BridgeRefusal({
      code: "signed-out",
      message: "this companion is not signed in to a relay, so there is nothing to pair with",
      instruction: "Sign in to a relay on the rail, then pair this install.",
    });
  }
  const listed = await listInstalls();
  const found = listed.find((candidate) => candidate.dir === install);
  if (found === undefined) {
    throw new BridgeRefusal({
      code: "refused",
      message: "this companion does not hold an install at that folder",
    });
  }
  if (found.state !== "running") {
    throw new BridgeRefusal({
      code: "container-not-running",
      message:
        "pairing writes a token the container spends on its next boot, and this one is not up",
      instruction: "Start this install, then pair it.",
    });
  }
}

/**
 * A URL the OS handed us. An auth link is spent against whichever sign-in this
 * process has open; anything else is not ours, and a code with no attempt
 * behind it is dropped — only the instance holding the verifier can spend one.
 */
function deliverDeepLink(url: string): void {
  const code = authCodeIn(url);
  if (code !== null) relay?.deliver(code);
}

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

/** Bring the window back and put the URL that woke us in front of the arm. */
app.on("second-instance", (_event, argv) => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window !== undefined) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
  const code = authCodeInArgv(argv);
  if (code !== null) relay?.deliver(code);
});

// macOS does not relaunch for a URL; it fires this on the running app.
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

app.whenReady().then(
  () => {
    claimScheme();
    relay = openRelayArm();

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
      answering<string>(async () => {
        if (request.verb === "pair") await assertPairable(request.install);
        return runs.start(request);
      }),
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

    ipcMain.handle(BRIDGE_CHANNELS.relayState, () => answering(() => arm().state()));

    ipcMain.handle(BRIDGE_CHANNELS.relaySignIn, (_event, request: { url: string }) =>
      answering(() => arm().signIn(request.url)),
    );

    ipcMain.handle(BRIDGE_CHANNELS.relayRequest, (_event, request: RelayPassthrough) =>
      answering(() => arm().request(request)),
    );

    ipcMain.handle(BRIDGE_CHANNELS.relaySignOut, () => answering(() => arm().signOut()));

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

app.on("before-quit", () => relay?.close());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
