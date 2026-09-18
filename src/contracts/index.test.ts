// The hand-written mirror, checked (#528 §"A runtime value added here has to be
// mirrored by hand in index.mjs"). index.ts is what a type-checker reads and
// index.mjs is what an installed consumer's `import` actually loads, so a value
// that exists in one and not the other is a bug nobody sees until a console
// crashes in production on `undefined`.

import { describe, expect, test } from "vite-plus/test";
import { RELAY_ROUTES as typed } from "./index.ts";
import { RELAY_ROUTES as shipped } from "./index.mjs";

describe("index.mjs mirrors the typed contracts entry", () => {
  test("the relay's routes are the same object on both sides", () => {
    expect(shipped).toEqual(typed);
  });

  test("every route is an absolute path", () => {
    for (const [name, path] of Object.entries(typed)) {
      expect(path.startsWith("/"), `${name} is not absolute`).toBe(true);
    }
  });

  test("no two routes share a path", () => {
    const paths = Object.values(typed);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
