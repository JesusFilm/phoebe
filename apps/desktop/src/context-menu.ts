// The right-click menu, as the OS draws it.
//
// Electron draws none by itself, so a right-click on the console did nothing.
// The window says what was clicked (contracts/desktop-bridge.ts, `menu.show`)
// and main pops the native menu for it: the edit set on a field, Copy on a
// selection, and on the console's lines Copy, Copy line and Copy all lines
// beside Select all. Main hands back what was chosen and the window does the
// copying: the text is already there, and the menu is the only part a renderer
// cannot draw.

import type { MenuItemConstructorOptions } from "electron";
import type { ContextMenuChoice, ContextMenuRequest } from "phoebe-agent/contracts";

/**
 * The items for one request. `choose` is what a click on an item calls; the
 * edit roles need no call, because the OS carries them out itself.
 */
export function contextMenuTemplate(
  request: ContextMenuRequest,
  choose: (choice: ContextMenuChoice) => void,
): MenuItemConstructorOptions[] {
  switch (request.kind) {
    case "edit":
      return [
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        { role: "selectAll" },
      ];
    case "text":
      return [{ label: "Copy", enabled: request.selection !== "", click: () => choose("copy") }];
    case "console":
      return [
        { label: "Copy", enabled: request.selection !== "", click: () => choose("copy") },
        { label: "Copy line", enabled: request.line !== null, click: () => choose("copy-line") },
        {
          label: "Copy all lines",
          enabled: request.lines > 0,
          click: () => choose("copy-all"),
        },
        { type: "separator" },
        { label: "Select all", enabled: request.lines > 0, click: () => choose("select-all") },
      ];
  }
}
