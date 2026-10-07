// The hand-written mirror, checked (#528 §"A runtime value added here has to be
// mirrored by hand in index.mjs"). index.ts is what a type-checker reads and
// index.mjs is what an installed consumer's `import` actually loads, so a value
// that exists in one and not the other is a bug nobody sees until a console
// crashes in production on `undefined`.

import { describe, expect, test } from "vite-plus/test";
import {
  CANCELLABLE_VERBS as typedCancellable,
  CLOSED_EDIT_BLOCKS as typedClosedBlocks,
  DESKTOP_BRIDGE_GLOBAL as typedGlobal,
  LOG_TAIL_LINES as typedLogTail,
  MAX_LOG_LINES as typedMaxLogLines,
  MAX_RUN_LINES as typedMaxLines,
} from "./index.ts";
import {
  CANCELLABLE_VERBS as shippedCancellable,
  CLOSED_EDIT_BLOCKS as shippedClosedBlocks,
  DESKTOP_BRIDGE_GLOBAL as shippedGlobal,
  LOG_TAIL_LINES as shippedLogTail,
  MAX_LOG_LINES as shippedMaxLogLines,
  MAX_RUN_LINES as shippedMaxLines,
} from "./index.mjs";

describe("the config-edit closed set", () => {
  test("is the same on both sides", () => {
    expect(shippedClosedBlocks).toEqual(typedClosedBlocks);
  });
});

describe("the companion's bridge global", () => {
  test("is the same name on both sides", () => {
    // The preload writes this global and the console bundle reads it; the two
    // ship together, so the only way they can disagree is through this file.
    expect(shippedGlobal).toBe(typedGlobal);
  });
});

describe("the verb run's constants", () => {
  test.each([
    ["MAX_RUN_LINES", typedMaxLines, shippedMaxLines],
    ["CANCELLABLE_VERBS", typedCancellable, shippedCancellable],
    ["MAX_LOG_LINES", typedMaxLogLines, shippedMaxLogLines],
    ["LOG_TAIL_LINES", typedLogTail, shippedLogTail],
  ])("%s is the same on both sides", (_name, typedValue, shippedValue) => {
    expect(shippedValue).toEqual(typedValue);
  });

  test("only the verbs whose child the companion holds can be cancelled (#527 §2)", () => {
    // `start` and `stop` drive Compose through an injected runner, so the
    // companion has the child to signal. Nothing else does — see verb-run.ts.
    expect([...typedCancellable].sort()).toEqual(["start", "stop"]);
  });
});
