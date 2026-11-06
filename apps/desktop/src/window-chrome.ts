// The window's chrome: no native titlebar and no menu bar (#788).
//
// The console's own top row is the titlebar. The rail's brand and the pane's
// route line are 40px each and are the drag region (console.css, under
// `[data-platform]`), and the OS draws its window buttons over them: macOS its
// traffic lights over the rail, Windows and Linux their minimise, maximise and
// close through the window-controls overlay, themed here and drawn by the
// system. The preload puts the platform on the document so the console can make
// room for whichever it is before its first paint.
//
// The menu bar goes with the titlebar. Electron's stock File / Edit / View /
// Window / Help held nothing of ours, but it quietly held some keys, so the
// ones worth keeping come back without it: on macOS through a small menu in
// the system bar, where Cmd+C and Cmd+Q have to live; on Windows and Linux,
// where the renderer already does its own copy and paste, by catching the key
// before the page sees it.

import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from "electron";

/**
 * The row the window buttons sit on. The overlay is one short of the console's
 * 40px rows, so the pane's bottom border still runs the full width under the
 * buttons.
 */
const OVERLAY_HEIGHT = 39;

/** The traffic lights, centred on the rail's 40px brand row. */
const TRAFFIC_LIGHTS = { x: 14, y: 12 };

/**
 * The overlay's colours: the console's `--panel` behind the buttons and its
 * `--fg` for their glyphs (apps/console/src/console.css), read off the same
 * light-or-dark signal as the window's background.
 */
export function titleBarOverlayFor(dark: boolean): {
  color: string;
  symbolColor: string;
  height: number;
} {
  return dark
    ? { color: "#1b1f26", symbolColor: "#e7eaee", height: OVERLAY_HEIGHT }
    : { color: "#ffffff", symbolColor: "#111418", height: OVERLAY_HEIGHT };
}

/** What the window is opened with so the console's top row is its titlebar. */
export function windowChromeOptions(
  platform: NodeJS.Platform,
  dark: boolean,
): BrowserWindowConstructorOptions {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: TRAFFIC_LIGHTS };
  }
  return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlayFor(dark) };
}

/**
 * The application menu, or null for none. macOS keeps one because its app menu
 * and edit keys live in the system bar whatever the window draws; Windows and
 * Linux get none, which also takes the bar off the window and Alt with it.
 * Reload and devtools are for a checkout, as they were the stock menu's.
 */
export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  devTools: boolean,
): MenuItemConstructorOptions[] | null {
  if (platform !== "darwin") return null;
  return [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...(devTools
          ? ([
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
              { type: "separator" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}

/** What one of the kept keys does on Windows and Linux. */
export type ChromeShortcut =
  | "reload"
  | "force-reload"
  | "toggle-devtools"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom"
  | "toggle-fullscreen"
  | "quit";

/** The parts of Electron's `before-input-event` input read here. */
export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * The stock menu's keys on Windows and Linux, for a window that has no menu to
 * carry them: reload and devtools in a checkout, zoom and full screen always,
 * and Ctrl+Q on Linux, where the stock Quit had it (Windows has Alt+F4).
 * Null for any other key, which the page then gets as usual.
 */
export function chromeShortcutFor(
  input: KeyInput,
  platform: NodeJS.Platform,
  devTools: boolean,
): ChromeShortcut | null {
  if (platform === "darwin" || input.type !== "keyDown" || input.alt || input.meta) return null;
  const key = input.key.toLowerCase();
  if (!input.control) return key === "f11" && !input.shift ? "toggle-fullscreen" : null;

  if (devTools && key === "r") return input.shift ? "force-reload" : "reload";
  if (devTools && key === "i" && input.shift) return "toggle-devtools";
  // Plus is Shift+= on most layouts, so either is zoom in.
  if (key === "=" || key === "+") return "zoom-in";
  if (input.shift) return null;
  if (key === "-") return "zoom-out";
  if (key === "0") return "reset-zoom";
  if (key === "q" && platform === "linux") return "quit";
  return null;
}
