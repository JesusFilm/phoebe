// The seam's two arms, and the one global that chooses between them.

import { describe, expect, test } from "vite-plus/test";
import { DESKTOP_BRIDGE_GLOBAL } from "phoebe-agent/contracts";
import type { DesktopBridge, RelayArmState } from "phoebe-agent/contracts";
import { desktopBridge } from "./companion.ts";
import { createBridgeRelayClient, isNotSignedIn } from "./relay-client.ts";
import { bridge, type BridgeAnswers } from "./test-fixture.ts";

const ADA = { sub: "1", email: "ada@example.test" };

/** A bridge that answers `state` with whatever it is given and refuses the rest. */
function bridgeOf(state: RelayArmState, answers: BridgeAnswers = {}): DesktopBridge {
  return bridge({ ...answers, relay: state });
}

describe("which surface this is", () => {
  test("is a browser when nothing exposed a bridge", () => {
    expect(desktopBridge({})).toBeNull();
  });

  test("is the companion when the preload did", () => {
    const bridge = bridgeOf({ url: null, person: null, persisted: false });

    expect(desktopBridge({ [DESKTOP_BRIDGE_GLOBAL]: bridge })).toBe(bridge);
  });

  test("is not fooled by something else sitting on that name", () => {
    expect(desktopBridge({ [DESKTOP_BRIDGE_GLOBAL]: "phoebe" })).toBeNull();
    expect(desktopBridge({ [DESKTOP_BRIDGE_GLOBAL]: { version: "0.13.0" } })).toBeNull();
  });
});

describe("the companion's relay client", () => {
  test("reads who is signed in from the bridge's relay state", async () => {
    const client = createBridgeRelayClient(
      bridgeOf({ url: "https://relay.example.test", person: ADA, persisted: true }),
    );

    await expect(client.me()).resolves.toEqual(ADA);
  });

  test("says nobody when there is no session, which is a page and not an error", async () => {
    const client = createBridgeRelayClient(bridgeOf({ url: null, person: null, persisted: false }));

    await expect(client.me()).resolves.toBeNull();
  });

  test("asks main for the routes rather than fetching them itself", async () => {
    const client = createBridgeRelayClient(
      bridgeOf(
        { url: "https://relay.example.test", person: ADA, persisted: true },
        { request: (path) => ({ path, deployments: [] }) },
      ),
    );

    await expect(client.deployments()).resolves.toEqual([]);
    await expect(client.deployment("a/b")).resolves.toEqual({
      path: "/api/deployments/a%2Fb",
      deployments: [],
    });
  });

  test("asks main for the version too — the open route still goes through main", async () => {
    // There is no origin to fetch from in the companion: the bundle came off
    // disk. Unauthenticated on the relay does not mean direct from the renderer.
    const client = createBridgeRelayClient(
      bridgeOf(
        { url: "https://relay.example.test", person: null, persisted: false },
        { request: (path) => ({ path, version: "0.13.0", console: 1 }) },
      ),
    );

    await expect(client.version()).resolves.toEqual({
      path: "/api/version",
      version: "0.13.0",
      console: 1,
    });
  });

  test("turns a signed-out refusal into the 401 the browser arm would have got", async () => {
    const client = createBridgeRelayClient(bridgeOf({ url: null, person: null, persisted: false }));

    // Same predicate, same page, whichever arm raised it.
    await expect(client.deployments()).rejects.toSatisfy(isNotSignedIn);
  });

  test("signs in by prompt, carrying what the arm can promise about keeping it (#554)", async () => {
    const client = createBridgeRelayClient(
      bridgeOf(
        {
          url: "https://relay.example.test",
          person: null,
          persisted: false,
          reason: "no keyring here",
        },
        { signIn: (url) => ({ url, person: ADA, persisted: false }) },
      ),
    );

    const how = await client.signIn();

    expect(how).toMatchObject({
      kind: "prompt",
      relay: "https://relay.example.test",
      persisted: false,
      reason: "no keyring here",
    });
    if (how.kind !== "prompt") throw new Error("the companion's arm signs in by prompt");
    await expect(how.start("https://relay.example.test")).resolves.toEqual(ADA);
  });

  test("a sign-in that comes back with nobody is not a session", async () => {
    const client = createBridgeRelayClient(
      bridgeOf(
        { url: null, person: null, persisted: true },
        { signIn: (url) => ({ url, person: null, persisted: true }) },
      ),
    );

    const how = await client.signIn();
    if (how.kind !== "prompt") throw new Error("the companion's arm signs in by prompt");

    await expect(how.start("https://relay.example.test")).rejects.toThrow("did not complete");
  });
});
