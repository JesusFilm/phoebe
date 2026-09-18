// The companion's main process: one window, one privileged scheme, and the
// handlers behind the preload's bridge.
//
// This package is main and preload and nothing else (#521 §5, #522 §5). The
// window's contents are the `apps/console` bundle — the same React app the relay
// serves in a browser — loaded from disk over the console scheme. So there is no
// UI code in here, and a page the operator sees is never written twice.
//
// Main is also the relay client (#523 §1): it holds the device token, makes every
// call to the relay, and re-emits the relay's event stream to the renderer over
// IPC. The wiring for that is here; the flow itself is relay-session.ts, which
// needs no Electron to run. The host verbs and the local read loop arrive with
// #555 and #556, behind the contract the preload already exposes.

import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  shell,
} from "electron";
import type { RelayArmState, RelayEvent, RelayPassthrough } from "phoebe-agent/contracts";
import { authCodeIn, authCodeInArgv } from "./auth-link.ts";
import { answer, BRIDGE_CHANNELS, type BridgeResult } from "./channels.ts";
import { CONSOLE_SCHEME, consoleFileFor } from "./console-scheme.ts";
import { consoleSource } from "./console-source.ts";
import { companionName, createRelaySession, type RelaySession } from "./relay-session.ts";
import { createTokenVault } from "./vault.ts";

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
    : path.join(__dirname, "..", "..", "..", "console");
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
      preload: path.join(__dirname, "preload.cjs"),
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

    ipcMain.handle(BRIDGE_CHANNELS.relayState, () => answer(() => arm().state()));

    ipcMain.handle(BRIDGE_CHANNELS.relaySignIn, (_event, request: { url: string }) =>
      answer(() => arm().signIn(request.url)),
    );

    ipcMain.handle(BRIDGE_CHANNELS.relayRequest, (_event, request: RelayPassthrough) =>
      answer(() => arm().request(request)),
    );

    ipcMain.handle(BRIDGE_CHANNELS.relaySignOut, () => answer(() => arm().signOut()));

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
