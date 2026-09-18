// The companion's main process: one window, one privileged scheme, and the
// handlers behind the preload's bridge.
//
// This package is main and preload and nothing else (#521 §5, #522 §5). The
// window's contents are the `apps/console` bundle — the same React app the relay
// serves in a browser — loaded from disk over the console scheme. So there is no
// UI code in here, and a page the operator sees is never written twice.
//
// What main answers today is the shell's worth of the bridge: its version, and a
// relay arm with no session. Main becomes the relay client proper with #554, and
// grows the host verbs and the local read loop with #555 and #556; both are
// changes in here, behind the contract the preload already exposes.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import type { RelayArmState } from "phoebe-agent/contracts";
import { BRIDGE_CHANNELS, refusal, type BridgeResult } from "./channels.ts";
import { CONSOLE_SCHEME, consoleFileFor } from "./console-scheme.ts";
import { consoleSource } from "./console-source.ts";

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
    : path.join(__dirname, "..", "..", "..", "console");
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

    ipcMain.handle(BRIDGE_CHANNELS.relayState, (): BridgeResult<RelayArmState> => {
      // No relay is paired and no device token is held, which is the honest
      // answer until #554 mints one. The console draws the signed-out Relay
      // group from exactly this.
      return { ok: true, value: { url: null, person: null, persisted: false } };
    });

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
