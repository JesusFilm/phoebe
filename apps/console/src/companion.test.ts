// The seam's two arms, and the one global that chooses between them.

import { describe, expect, test } from "vite-plus/test";
import { DESKTOP_BRIDGE_GLOBAL } from "phoebe-agent/contracts";
import type { DesktopBridge, RelayArmState, RelayEvent } from "phoebe-agent/contracts";
import { desktopBridge } from "./companion.ts";
import { createBridgeRelayClient, isNotSignedIn } from "./relay-client.ts";

const ADA = { sub: "1", email: "ada@example.test" };

/** A bridge that answers `state` with whatever it is given and refuses the rest. */
function bridgeOf(
  state: RelayArmState,
  answers: { request?: (path: string) => unknown; events?: RelayEvent[] } = {},
): DesktopBridge {
  return {
    version: () => Promise.resolve("0.13.0"),
    relay: {
      state: () => Promise.resolve(state),
      request: ({ path }) => {
        if (answers.request === undefined) return Promise.reject(signedOut());
        return Promise.resolve(answers.request(path));
      },
      events: (onEvent) => {
        for (const event of answers.events ?? []) onEvent(event);
        return () => undefined;
      },
      signOut: () => Promise.resolve(),
    },
  };
}

/** What the preload throws when main refuses a call (#527 §16). */
function signedOut(): Error {
  return Object.assign(new Error("the companion is not signed in to a relay"), {
    code: "signed-out",
  });
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

  test("turns a signed-out refusal into the 401 the browser arm would have got", async () => {
    const client = createBridgeRelayClient(bridgeOf({ url: null, person: null, persisted: false }));

    // Same predicate, same page, whichever arm raised it.
    await expect(client.deployments()).rejects.toSatisfy(isNotSignedIn);
  });
});
