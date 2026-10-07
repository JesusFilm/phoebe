import { describe, expect, test } from "vite-plus/test";
import type { ContextMenuChoice } from "phoebe-agent/contracts";
import { contextMenuTemplate } from "./context-menu.ts";

/** The items, with each one's click pressed, as labels and what pressing chose. */
function pressed(template: ReturnType<typeof contextMenuTemplate>, chosen: ContextMenuChoice[]) {
  return template.map((item) => {
    if (item.type === "separator") return "—";
    if (item.click !== undefined) {
      (item.click as () => void)();
      return `${item.label}${item.enabled === false ? " (off)" : ""} → ${chosen.pop() ?? "nothing"}`;
    }
    return `role:${item.role}`;
  });
}

describe("the right-click menu", () => {
  test("a field gets the OS's own edit set, which chooses nothing here", () => {
    const chosen: ContextMenuChoice[] = [];
    const items = pressed(
      contextMenuTemplate({ kind: "edit", selection: "x" }, (choice) => chosen.push(choice)),
      chosen,
    );

    expect(items).toEqual(["role:cut", "role:copy", "role:paste", "—", "role:selectAll"]);
  });

  test("selected text gets Copy, and nothing selected gets it greyed", () => {
    const chosen: ContextMenuChoice[] = [];

    expect(
      pressed(
        contextMenuTemplate({ kind: "text", selection: "hi" }, (c) => chosen.push(c)),
        chosen,
      ),
    ).toEqual(["Copy → copy"]);
    expect(
      pressed(
        contextMenuTemplate({ kind: "text", selection: "" }, (c) => chosen.push(c)),
        chosen,
      ),
    ).toEqual(["Copy (off) → copy"]);
  });

  test("the console's lines get the line and all of them beside the selection", () => {
    const chosen: ContextMenuChoice[] = [];
    const items = pressed(
      contextMenuTemplate(
        { kind: "console", selection: "", line: "[phoebe] boot: ok", lines: 12 },
        (choice) => chosen.push(choice),
      ),
      chosen,
    );

    expect(items).toEqual([
      "Copy (off) → copy",
      "Copy line → copy-line",
      "Copy all lines → copy-all",
      "—",
      "Select all → select-all",
    ]);
  });

  test("an empty console has nothing to copy or select", () => {
    const items = contextMenuTemplate(
      { kind: "console", selection: "", line: null, lines: 0 },
      () => undefined,
    );

    expect(items.filter((item) => item.type !== "separator").map((item) => item.enabled)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
