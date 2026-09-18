// The hand-written mirror, checked (#528 §"A runtime value added here has to be
// mirrored by hand in index.mjs"). index.ts is what a type-checker reads and
// index.mjs is what an installed consumer's `import` actually loads, so a value
// that exists in one and not the other is a bug nobody sees until a console
// crashes in production on `undefined`.

import { describe, expect, test } from "vite-plus/test";
import {
  CANCELLABLE_VERBS as typedCancellable,
  DESKTOP_BRIDGE_GLOBAL as typedGlobal,
  MAX_RUN_LINES as typedMaxLines,
  RELAY_CLOSE as typedClose,
  RELAY_DARK_AFTER_MS as typedDark,
  RELAY_DEPLOYMENTS_PATH as typedPath,
  RELAY_EVENTS as typedEvents,
  RELAY_HEARTBEAT_MS as typedHeartbeat,
  RELAY_MESSAGES as typedMessages,
  RELAY_PROTOCOL as typedProtocol,
  RELAY_ROUTES as typed,
  RELAY_UNDELIVERED as typedUndelivered,
} from "./index.ts";
import {
  CANCELLABLE_VERBS as shippedCancellable,
  DESKTOP_BRIDGE_GLOBAL as shippedGlobal,
  MAX_RUN_LINES as shippedMaxLines,
  RELAY_CLOSE as shippedClose,
  RELAY_DARK_AFTER_MS as shippedDark,
  RELAY_DEPLOYMENTS_PATH as shippedPath,
  RELAY_EVENTS as shippedEvents,
  RELAY_HEARTBEAT_MS as shippedHeartbeat,
  RELAY_MESSAGES as shippedMessages,
  RELAY_PROTOCOL as shippedProtocol,
  RELAY_ROUTES as shipped,
  RELAY_UNDELIVERED as shippedUndelivered,
} from "./index.mjs";

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

describe("the deployment rail's constants are mirrored too", () => {
  test.each([
    ["RELAY_PROTOCOL", typedProtocol, shippedProtocol],
    ["RELAY_DEPLOYMENTS_PATH", typedPath, shippedPath],
    ["RELAY_MESSAGES", typedMessages, shippedMessages],
    ["RELAY_CLOSE", typedClose, shippedClose],
    ["RELAY_HEARTBEAT_MS", typedHeartbeat, shippedHeartbeat],
    ["RELAY_DARK_AFTER_MS", typedDark, shippedDark],
    ["RELAY_UNDELIVERED", typedUndelivered, shippedUndelivered],
    ["RELAY_EVENTS", typedEvents, shippedEvents],
  ])("%s is the same on both sides", (_name, typedValue, shippedValue) => {
    expect(shippedValue).toEqual(typedValue);
  });

  test("the dark threshold is three heartbeats, which is what makes it legible", () => {
    expect(typedDark).toBe(typedHeartbeat * 3);
  });

  test("every message type carries the rail's prefix", () => {
    for (const [name, type] of Object.entries(typedMessages)) {
      expect(type.startsWith("phoebe:relay:"), `${name} is unprefixed`).toBe(true);
    }
  });

  test("every close code is in WebSocket's private range", () => {
    for (const [name, code] of Object.entries(typedClose)) {
      expect(code >= 4000 && code <= 4999, `${name} is outside 4000–4999`).toBe(true);
    }
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
  ])("%s is the same on both sides", (_name, typedValue, shippedValue) => {
    expect(shippedValue).toEqual(typedValue);
  });

  test("only the verbs whose child the companion holds can be cancelled (#527 §2)", () => {
    // `start` and `stop` drive Compose through an injected runner, so the
    // companion has the child to signal. Nothing else does — see verb-run.ts.
    expect([...typedCancellable].sort()).toEqual(["start", "stop"]);
  });
});
