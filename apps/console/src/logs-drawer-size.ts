// The logs drawer's geometry and its two switches, with no React in it.
//
// The drawer is the shape T3 Code's terminal drawer is: a strip along the
// bottom of the page with a pixel height the operator drags, kept between a
// floor and three quarters of the window, remembered across launches. This file
// is the arithmetic and the remembering; logs-drawer.tsx is the drawing.

/** The height a drawer opens at the first time. */
export const DEFAULT_LOGS_DRAWER_HEIGHT = 280;

/** Below this the lines are a slot, not a drawer. */
export const MIN_LOGS_DRAWER_HEIGHT = 180;

/** The drawer never takes more of the window than this; the page keeps the rest. */
export const MAX_LOGS_DRAWER_RATIO = 0.75;

export const LOGS_DRAWER_HEIGHT_KEY = "phoebe.logs-drawer.height";
export const LOGS_DRAWER_OPEN_KEY = "phoebe.logs-drawer.open";

/** A height kept within the floor and the window's share, whole pixels. */
export function clampDrawerHeight(height: number, windowHeight: number): number {
  const safe = Number.isFinite(height) ? Math.round(height) : DEFAULT_LOGS_DRAWER_HEIGHT;
  const max = Math.max(MIN_LOGS_DRAWER_HEIGHT, Math.floor(windowHeight * MAX_LOGS_DRAWER_RATIO));
  return Math.min(Math.max(safe, MIN_LOGS_DRAWER_HEIGHT), max);
}

/**
 * The height during a drag of the top edge. The edge moves with the pointer, so
 * dragging up from where the drag began makes the drawer taller by that much.
 */
export function draggedHeight(
  startHeight: number,
  startY: number,
  pointerY: number,
  windowHeight: number,
): number {
  return clampDrawerHeight(startHeight + (startY - pointerY), windowHeight);
}

/** The subset of Storage the drawer remembers itself through. Injectable. */
export type DrawerStorage = Pick<Storage, "getItem" | "setItem">;

/** The remembered height, or the default when nothing usable was remembered. */
export function rememberedHeight(storage: DrawerStorage | null, windowHeight: number): number {
  const raw = storage?.getItem(LOGS_DRAWER_HEIGHT_KEY);
  const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw);
  return clampDrawerHeight(
    Number.isFinite(parsed) ? parsed : DEFAULT_LOGS_DRAWER_HEIGHT,
    windowHeight,
  );
}

export function rememberHeight(storage: DrawerStorage | null, height: number): void {
  storage?.setItem(LOGS_DRAWER_HEIGHT_KEY, String(height));
}

/** Whether the drawer was open last time. Closed until it has ever been opened. */
export function rememberedOpen(storage: DrawerStorage | null): boolean {
  return storage?.getItem(LOGS_DRAWER_OPEN_KEY) === "1";
}

export function rememberOpen(storage: DrawerStorage | null, open: boolean): void {
  storage?.setItem(LOGS_DRAWER_OPEN_KEY, open ? "1" : "0");
}

/**
 * The toggle: Ctrl+` (Cmd+` on a Mac), the key T3 Code's terminal drawer
 * answers to. Read off `code` rather than `key` so a layout that puts the
 * backquote elsewhere still has it on the same physical key.
 */
export function isLogsToggleShortcut(event: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    event.code === "Backquote" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}
