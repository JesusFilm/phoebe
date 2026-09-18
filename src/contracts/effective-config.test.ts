// The effective-config shape is types only, with one exception: the version a
// reader compares before trusting a tree it did not compute. A runtime value in
// contracts is written twice (index.ts for the type condition, index.mjs for
// Node's), so this holds the two copies together.

import { describe, expect, test } from "vite-plus/test";
import { EFFECTIVE_CONFIG_VERSION } from "./effective-config.ts";
import { EFFECTIVE_CONFIG_VERSION as MIRRORED } from "./index.mjs";

describe("EFFECTIVE_CONFIG_VERSION", () => {
  test("the .mjs mirror carries the same value the .ts declares", () => {
    expect(MIRRORED).toBe(EFFECTIVE_CONFIG_VERSION);
  });

  test("it is an integer — a reader compares it, it does not parse it", () => {
    expect(Number.isInteger(EFFECTIVE_CONFIG_VERSION)).toBe(true);
  });
});
