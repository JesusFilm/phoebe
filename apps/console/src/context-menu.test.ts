import { describe, expect, test } from "vite-plus/test";
import { readContext, textToCopy, type ElementLike } from "./context-menu.ts";

/**
 * An element by the classes and tags above it, with the text each level holds
 * and the attributes it carries; `[name]` in a selector matches a level that
 * carries `name`.
 */
function element(
  chain: {
    matches: string[];
    text: string;
    laidOut?: string;
    attributes?: Record<string, string>;
  }[],
): ElementLike {
  const matches = (at: number, one: string): boolean => {
    const attribute = /^\[(.+)\]$/.exec(one);
    if (attribute !== null) return attribute[1]! in (chain[at]!.attributes ?? {});
    return chain[at]!.matches.includes(one);
  };
  const make = (depth: number): ElementLike => ({
    closest: (selector) => {
      for (let at = depth; at < chain.length; at += 1) {
        if (selector.split(",").some((one) => matches(at, one.trim()))) return make(at);
      }
      return null;
    },
    getAttribute: (name) => chain[depth]!.attributes?.[name] ?? null,
    textContent: chain[depth]!.text,
    ...(chain[depth]!.laidOut === undefined ? {} : { innerText: chain[depth]!.laidOut }),
  });
  return make(0);
}

describe("what a right-click is on", () => {
  test("a line of the console: the line, the selection, and every line", () => {
    const target = element([
      { matches: ["span"], text: "boot: ok" },
      { matches: [".log-line"], text: "[phoebe] boot: ok\n" },
      {
        matches: [".logs-lines", "pre"],
        text: "x",
        laidOut: "[phoebe] boot: ok\n[phoebe] cycle\n",
      },
    ]);

    const read = readContext(target, "boot");

    expect(read).toMatchObject({
      request: { kind: "console", selection: "boot", line: "[phoebe] boot: ok", lines: 2 },
      line: "[phoebe] boot: ok",
      all: "[phoebe] boot: ok\n[phoebe] cycle",
    });
    expect(textToCopy("copy", read!)).toBe("boot");
    expect(textToCopy("copy-line", read!)).toBe("[phoebe] boot: ok");
    expect(textToCopy("copy-all", read!)).toBe("[phoebe] boot: ok\n[phoebe] cycle");
    expect(textToCopy("select-all", read!)).toBeNull();
    expect(textToCopy(null, read!)).toBeNull();
  });

  // Copy all lines reads the text out of the box as it is laid out, so a clear
  // (#677) takes the hidden lines out of the copy as well as off the screen:
  // what the menu offers is always what the console is drawing.
  test("a cleared console copies the lines still drawn, and counts those", () => {
    const target = element([
      { matches: [".log-line"], text: "[phoebe] cycle\n" },
      { matches: [".logs-lines", "pre"], text: "x", laidOut: "[phoebe] cycle\n" },
    ]);

    const read = readContext(target, "");

    expect(read).toMatchObject({ request: { kind: "console", lines: 1 } });
    expect(textToCopy("copy-all", read!)).toBe("[phoebe] cycle");
  });

  test("the console's empty space is the console, with no line under the pointer", () => {
    const target = element([{ matches: [".logs-lines", "pre"], text: "", laidOut: "" }]);

    expect(readContext(target, "")).toMatchObject({
      request: { kind: "console", selection: "", line: null, lines: 0 },
      line: null,
    });
  });

  test("an install or a tenant on the rail is its folder, the nearest one up", () => {
    const tenant = element([
      { matches: ["span", ".label"], text: "acme/b" },
      { matches: ["button", ".rail-child"], text: "acme/b" },
      {
        matches: ["li", ".rail-child-row"],
        text: "",
        attributes: { "data-folder": "/repos/ws/b" },
      },
      { matches: [".rail-entry"], text: "", attributes: { "data-folder": "/repos/ws" } },
    ]);
    const install = element([
      { matches: ["div", ".name"], text: "ws" },
      { matches: [".rail-entry"], text: "", attributes: { "data-folder": "/repos/ws" } },
    ]);

    expect(readContext(tenant, "acme/b")).toMatchObject({
      request: { kind: "folder", dir: "/repos/ws/b" },
    });
    expect(readContext(install, "")).toMatchObject({
      request: { kind: "folder", dir: "/repos/ws" },
    });
    expect(textToCopy("open-folder", readContext(install, "")!)).toBeNull();
    expect(textToCopy("open-terminal", readContext(install, "")!)).toBeNull();
  });

  test("a field is the edit set, wherever it is", () => {
    const inside = element([
      { matches: ["input"], text: "" },
      { matches: [".logs-lines"], text: "" },
    ]);

    expect(readContext(inside, "abc")).toMatchObject({
      request: { kind: "edit", selection: "abc" },
    });
  });

  test("selected text elsewhere is Copy; nothing selected elsewhere is no menu", () => {
    const heading = element([{ matches: ["h2"], text: "Config" }]);

    expect(readContext(heading, "Config")).toMatchObject({
      request: { kind: "text", selection: "Config" },
    });
    expect(readContext(heading, "")).toBeNull();
    expect(readContext(null, "x")).toBeNull();
    expect(
      textToCopy("copy", {
        request: { kind: "text", selection: "" },
        line: null,
        all: null,
        box: null,
      }),
    ).toBeNull();
  });
});
