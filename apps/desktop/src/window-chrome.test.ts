import { describe, expect, test } from "vite-plus/test";
import {
  applicationMenuTemplate,
  chromeShortcutFor,
  titleBarOverlayFor,
  windowChromeOptions,
  type KeyInput,
} from "./window-chrome.ts";

/** A key going down, with Ctrl unless the test says otherwise. */
function key(name: string, mods: Partial<KeyInput> = {}): KeyInput {
  return {
    type: "keyDown",
    key: name,
    control: true,
    shift: false,
    alt: false,
    meta: false,
    ...mods,
  };
}

describe("the window's chrome", () => {
  test("macOS hides the titlebar and keeps the traffic lights over the rail", () => {
    expect(windowChromeOptions("darwin", true)).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 12 },
    });
  });

  test("Windows and Linux hide it and have the system draw its buttons, in the console's colours", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(windowChromeOptions(platform, false)).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#ffffff", symbolColor: "#111418", height: 39 },
      });
      expect(windowChromeOptions(platform, true)).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: titleBarOverlayFor(true),
      });
    }
    expect(titleBarOverlayFor(true)).toEqual({
      color: "#1b1f26",
      symbolColor: "#e7eaee",
      height: 39,
    });
  });
});

describe("the application menu", () => {
  test("Windows and Linux have none, so no bar and nothing for Alt to open", () => {
    expect(applicationMenuTemplate("win32", true)).toBeNull();
    expect(applicationMenuTemplate("linux", false)).toBeNull();
  });

  test("macOS keeps the app menu, Edit, View and Window, with reload and devtools only in a checkout", () => {
    const roles = (devTools: boolean) =>
      applicationMenuTemplate("darwin", devTools)?.map(
        (item) =>
          item.role ?? [
            item.label,
            (item.submenu as { role?: string }[]).map((sub) => sub.role ?? "—"),
          ],
      );

    expect(roles(true)).toEqual([
      "appMenu",
      "editMenu",
      [
        "View",
        [
          "reload",
          "forceReload",
          "toggleDevTools",
          "—",
          "resetZoom",
          "zoomIn",
          "zoomOut",
          "—",
          "togglefullscreen",
        ],
      ],
      "windowMenu",
    ]);
    expect(roles(false)?.[2]).toEqual([
      "View",
      ["resetZoom", "zoomIn", "zoomOut", "—", "togglefullscreen"],
    ]);
  });
});

describe("the stock menu's keys, kept without it", () => {
  test("reload and devtools answer in a checkout and not in a packaged app", () => {
    expect(chromeShortcutFor(key("r"), "win32", true)).toBe("reload");
    expect(chromeShortcutFor(key("R", { shift: true }), "linux", true)).toBe("force-reload");
    expect(chromeShortcutFor(key("I", { shift: true }), "win32", true)).toBe("toggle-devtools");

    expect(chromeShortcutFor(key("r"), "win32", false)).toBeNull();
    expect(chromeShortcutFor(key("I", { shift: true }), "linux", false)).toBeNull();
  });

  test("zoom and full screen answer everywhere", () => {
    expect(chromeShortcutFor(key("="), "win32", false)).toBe("zoom-in");
    expect(chromeShortcutFor(key("+", { shift: true }), "win32", false)).toBe("zoom-in");
    expect(chromeShortcutFor(key("-"), "linux", false)).toBe("zoom-out");
    expect(chromeShortcutFor(key("0"), "linux", false)).toBe("reset-zoom");
    expect(chromeShortcutFor(key("F11", { control: false }), "win32", false)).toBe(
      "toggle-fullscreen",
    );
  });

  test("Ctrl+Q quits on Linux, where the stock Quit had it, and not on Windows", () => {
    expect(chromeShortcutFor(key("q"), "linux", false)).toBe("quit");
    expect(chromeShortcutFor(key("q"), "win32", false)).toBeNull();
  });

  test("everything else reaches the page", () => {
    // The page's own copy, paste and typing.
    expect(chromeShortcutFor(key("c"), "win32", true)).toBeNull();
    expect(chromeShortcutFor(key("v"), "linux", true)).toBeNull();
    expect(chromeShortcutFor(key("r", { control: false }), "win32", true)).toBeNull();
    // Alt and the key going up are not the shortcut.
    expect(chromeShortcutFor(key("r", { alt: true }), "win32", true)).toBeNull();
    expect(chromeShortcutFor(key("r", { type: "keyUp" }), "win32", true)).toBeNull();
    // macOS has its menu for these.
    expect(chromeShortcutFor(key("r"), "darwin", true)).toBeNull();
  });
});
