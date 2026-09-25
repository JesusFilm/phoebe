import { describe, expect, test } from "vite-plus/test";
import {
  clampDrawerHeight,
  DEFAULT_LOGS_DRAWER_HEIGHT,
  draggedHeight,
  isLogsToggleShortcut,
  LOGS_DRAWER_HEIGHT_KEY,
  LOGS_DRAWER_OPEN_KEY,
  MIN_LOGS_DRAWER_HEIGHT,
  rememberedHeight,
  rememberedOpen,
  rememberHeight,
  rememberOpen,
} from "./logs-drawer-size.ts";

/** A Storage that is a Map. */
function storage(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    held,
  };
}

describe("the drawer's height", () => {
  test("stays between the floor and three quarters of the window", () => {
    expect(clampDrawerHeight(50, 800)).toBe(MIN_LOGS_DRAWER_HEIGHT);
    expect(clampDrawerHeight(5000, 800)).toBe(600);
    expect(clampDrawerHeight(300.6, 800)).toBe(301);
  });

  test("a short window still leaves the floor, and nothing sensible falls back to the default", () => {
    expect(clampDrawerHeight(400, 200)).toBe(MIN_LOGS_DRAWER_HEIGHT);
    expect(clampDrawerHeight(Number.NaN, 800)).toBe(DEFAULT_LOGS_DRAWER_HEIGHT);
  });

  test("dragging the top edge up makes the drawer taller by that much, within the clamp", () => {
    expect(draggedHeight(280, 500, 440, 800)).toBe(340);
    expect(draggedHeight(280, 500, 700, 800)).toBe(MIN_LOGS_DRAWER_HEIGHT);
    expect(draggedHeight(280, 500, 0, 800)).toBe(600);
  });
});

describe("what the drawer remembers", () => {
  test("its height, clamped to the window it comes back into", () => {
    const held = storage();
    rememberHeight(held, 420);

    expect(held.held.get(LOGS_DRAWER_HEIGHT_KEY)).toBe("420");
    expect(rememberedHeight(held, 800)).toBe(420);
    expect(rememberedHeight(held, 400)).toBe(300);
  });

  test("the default when nothing usable was remembered, or there is no storage", () => {
    expect(rememberedHeight(storage(), 800)).toBe(DEFAULT_LOGS_DRAWER_HEIGHT);
    expect(rememberedHeight(storage({ [LOGS_DRAWER_HEIGHT_KEY]: "tall" }), 800)).toBe(
      DEFAULT_LOGS_DRAWER_HEIGHT,
    );
    expect(rememberedHeight(null, 800)).toBe(DEFAULT_LOGS_DRAWER_HEIGHT);
  });

  test("whether it was open, closed until it has ever been opened", () => {
    const held = storage();
    expect(rememberedOpen(held)).toBe(false);
    rememberOpen(held, true);
    expect(held.held.get(LOGS_DRAWER_OPEN_KEY)).toBe("1");
    expect(rememberedOpen(held)).toBe(true);
    rememberOpen(held, false);
    expect(rememberedOpen(held)).toBe(false);
  });
});

describe("the toggle shortcut", () => {
  const press = (over: Partial<Parameters<typeof isLogsToggleShortcut>[0]>) =>
    isLogsToggleShortcut({
      code: "Backquote",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...over,
    });

  test("is the backquote with Ctrl, or with Cmd", () => {
    expect(press({ ctrlKey: true })).toBe(true);
    expect(press({ metaKey: true })).toBe(true);
  });

  test("and not the bare key, nor with Alt or Shift, nor another key", () => {
    expect(press({})).toBe(false);
    expect(press({ ctrlKey: true, altKey: true })).toBe(false);
    expect(press({ ctrlKey: true, shiftKey: true })).toBe(false);
    expect(press({ ctrlKey: true, code: "KeyJ" })).toBe(false);
  });
});
