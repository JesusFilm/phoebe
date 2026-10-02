// The one global that says which surface this is.

import { describe, expect, test } from "vite-plus/test";
import { DESKTOP_BRIDGE_GLOBAL } from "phoebe-agent/contracts";
import { desktopBridge } from "./companion.ts";
import { bridge as bridgeOf } from "./test-fixture.ts";

describe("which surface this is", () => {
  test("is a browser when nothing exposed a bridge", () => {
    expect(desktopBridge({})).toBeNull();
  });

  test("is the companion when the preload did", () => {
    const bridge = bridgeOf();

    expect(desktopBridge({ [DESKTOP_BRIDGE_GLOBAL]: bridge })).toBe(bridge);
  });

  test("is not fooled by something else sitting on that name", () => {
    expect(desktopBridge({ [DESKTOP_BRIDGE_GLOBAL]: "phoebe" })).toBeNull();
    expect(desktopBridge({ [DESKTOP_BRIDGE_GLOBAL]: { version: "0.13.0" } })).toBeNull();
  });
});
