import { describe, expect, test } from "vite-plus/test";
import { readContext, textToCopy, type ElementLike } from "./context-menu.ts";

/** An element by the classes and tags above it, with the text each level holds. */
function element(chain: { matches: string[]; text: string; laidOut?: string }[]): ElementLike {
  const make = (depth: number): ElementLike => ({
    closest: (selector) => {
      for (let at = depth; at < chain.length; at += 1) {
        if (selector.split(",").some((one) => chain[at]!.matches.includes(one.trim()))) {
          return make(at);
        }
      }
      return null;
    },
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

  test("the console's empty space is the console, with no line under the pointer", () => {
    const target = element([{ matches: [".logs-lines", "pre"], text: "", laidOut: "" }]);

    expect(readContext(target, "")).toMatchObject({
      request: { kind: "console", selection: "", line: null, lines: 0 },
      line: null,
    });
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
