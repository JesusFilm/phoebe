// What a right-click is on, and what to do with what the menu chose.
//
// The OS menu is main's to draw (apps/desktop/src/context-menu.ts); this is
// the window's half. A right-click is read off the element under it: a field
// gets the edit menu, an install or a tenant on the rail gets Open folder and
// Open in terminal, the console's lines get Copy, Copy line and Copy all
// lines, and any other selected text gets Copy. The copying is done here, from
// text the page already has; the opening is main's, which answers once it is
// done.

import type { ContextMenuChoice, ContextMenuRequest } from "phoebe-agent/contracts";

/** As much of a DOM element as this reads, so a test needs no browser. */
export type ElementLike = {
  closest: (selector: string) => ElementLike | null;
  getAttribute: (name: string) => string | null;
  textContent: string | null;
  /** The text as laid out, where the element is drawn; a test may leave it out. */
  innerText?: string;
};

/** A right-click, read: what to ask the OS for, and the texts a choice would copy. */
export type ContextRead = {
  request: ContextMenuRequest;
  /** The line under the pointer, without its trailing newline. */
  line: string | null;
  /** Every line the console is showing. */
  all: string | null;
  /** The console's lines, to select all of. */
  box: ElementLike | null;
};

/**
 * The attribute the rail puts its folder on: an install's entry carries the
 * install's directory, a tenant's row the tenant's, so the nearest one up from
 * the pointer is the folder the click was on (rail.tsx).
 */
export const FOLDER_ATTRIBUTE = "data-folder";

/**
 * What was right-clicked, or null when nothing here has a menu for it: a
 * button, a heading, bare chrome. The console's lines are known by the class
 * the view draws them in (console-view.tsx); a field by being one; a folder by
 * the attribute the rail hangs on it.
 */
export function readContext(target: ElementLike | null, selection: string): ContextRead | null {
  if (target === null) return null;
  if (target.closest("input, textarea, [contenteditable=''], [contenteditable='true']") !== null) {
    return { request: { kind: "edit", selection }, line: null, all: null, box: null };
  }
  const folder = target.closest(`[${FOLDER_ATTRIBUTE}]`)?.getAttribute(FOLDER_ATTRIBUTE) ?? null;
  if (folder !== null && folder !== "") {
    return { request: { kind: "folder", dir: folder }, line: null, all: null, box: null };
  }
  const box = target.closest(".logs-lines");
  if (box !== null) {
    const line = target.closest(".log-line");
    const lineText = line === null ? null : (line.textContent ?? "").replace(/\n$/, "");
    const all = (box.innerText ?? box.textContent ?? "").replace(/\n$/, "");
    return {
      request: {
        kind: "console",
        selection,
        line: lineText,
        lines: all === "" ? 0 : all.split("\n").length,
      },
      line: lineText,
      all,
      box,
    };
  }
  if (selection !== "") {
    return { request: { kind: "text", selection }, line: null, all: null, box: null };
  }
  return null;
}

/** The text a choice copies, or null when it copies nothing (or selects instead). */
export function textToCopy(choice: ContextMenuChoice | null, read: ContextRead): string | null {
  switch (choice) {
    case "copy": {
      // A folder has no selection to copy; the rest carry one.
      const selection = "selection" in read.request ? read.request.selection : "";
      return selection === "" ? null : selection;
    }
    case "copy-line":
      return read.line;
    case "copy-all":
      return read.all;
    default:
      return null;
  }
}
