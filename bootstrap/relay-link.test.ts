// The deployment's side of the handshake, driven through a fake socket: what it
// sends when, what it does with each refusal, and what the report says while it
// is doing it.
//
// Nothing here opens a real connection. The socket seam is one function, so the
// test is the far side of it — which is also how the close codes get exercised,
// since half of them are refusals a healthy relay never sends.

import { describe, expect, test } from "vite-plus/test";
import { RELAY_CLOSE, RELAY_MESSAGES, RELAY_PROTOCOL } from "../src/contracts/relay-protocol.ts";
import { verifyNonceSignature } from "../src/ed25519.ts";
import type { RelayStatus } from "./deployment-state.ts";
import { generateDeploymentKey, type DeploymentKey } from "./relay-key.ts";
import {
  connectRelay,
  PROTOCOL_RETRY_MS,
  RECONNECT_SCHEDULE_MS,
  reconnectDelayMs,
  type RelaySocketHandlers,
} from "./relay-link.ts";

const NONCE = Buffer.from("nonce-from-the-relay").toString("base64url");

/** One dial, as the link drove it. */
type Dialled = {
  url: string;
  handlers: RelaySocketHandlers;
  sent: string[];
  closed: boolean;
};

type Harness = {
  dials: Dialled[];
  statuses: RelayStatus[];
  saved: DeploymentKey[];
  forgotten: true[];
  timers: Array<{ ms: number; fire: () => void }>;
  logs: string[];
  /** Answer the newest dial with a challenge, as a relay does on open. */
  challenge: (protocol?: number) => void;
  /** Close the newest dial. */
  close: (code: number, reason?: string) => void;
  /** Run the one scheduled retry. */
  elapse: () => void;
  last: () => RelayStatus;
  hello: () => Record<string, unknown>;
  stop: () => void;
};

function harness(
  overrides: {
    key?: DeploymentKey | null;
    pairingToken?: string;
    protocol?: number;
  } = {},
): Harness {
  const dials: Dialled[] = [];
  const statuses: RelayStatus[] = [];
  const saved: DeploymentKey[] = [];
  const forgotten: true[] = [];
  const timers: Array<{ ms: number; fire: () => void }> = [];
  const logs: string[] = [];
  let clock = 1_000_000;

  const link = connectRelay({
    url: "wss://relay.example.com/deployments",
    name: "acme/widget",
    key: overrides.key === undefined ? null : overrides.key,
    ...(overrides.pairingToken !== undefined ? { pairingToken: overrides.pairingToken } : {}),
    ...(overrides.protocol !== undefined ? { protocol: overrides.protocol } : {}),
    mintKey: generateDeploymentKey,
    saveKey: (key) => {
      saved.push(key);
    },
    forgetKey: () => {
      forgotten.push(true);
    },
    onStatus: (status) => statuses.push(status),
    log: (message) => logs.push(message),
    open: (url, handlers) => {
      const dial: Dialled = { url, handlers, sent: [], closed: false };
      dials.push(dial);
      return {
        send: (data) => dial.sent.push(data),
        close: () => {
          dial.closed = true;
        },
      };
    },
    now: () => clock,
    setTimer: (fire, ms) => {
      timers.push({ ms, fire });
      return timers.length;
    },
    clearTimer: () => {},
    random: () => 0,
  });

  const newest = (): Dialled => dials[dials.length - 1]!;
  return {
    dials,
    statuses,
    saved,
    forgotten,
    timers,
    logs,
    challenge: (protocol = RELAY_PROTOCOL) => {
      newest().handlers.onOpen();
      newest().handlers.onMessage(
        JSON.stringify({ type: RELAY_MESSAGES.challenge, nonce: NONCE, protocol }),
      );
    },
    close: (code, reason = "") => {
      clock += 1_000;
      newest().handlers.onClose(code, reason);
    },
    elapse: () => {
      const timer = timers.pop()!;
      clock += timer.ms;
      timer.fire();
    },
    last: () => statuses[statuses.length - 1]!,
    hello: () => JSON.parse(newest().sent[0]!) as Record<string, unknown>,
    stop: () => link.stop(),
  };
}

describe("dialling", () => {
  test("the deployment says nothing until the relay challenges it", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.dials[0]!.handlers.onOpen();
    expect(relay.dials[0]!.sent).toEqual([]);
  });

  test("a configured relay reports `reconnecting` from the first dial", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    expect(relay.statuses[0]).toMatchObject({ configured: true, state: "reconnecting" });
  });
});

describe("a first pairing", () => {
  test("spends the token, names the deployment, and carries no signature", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    expect(relay.hello()).toMatchObject({
      type: RELAY_MESSAGES.hello,
      protocol: RELAY_PROTOCOL,
      name: "acme/widget",
      pairingToken: "mint-fresh",
    });
    expect(relay.hello()["signature"]).toBeUndefined();
  });

  test("the key it presents is the key it saves", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    expect(relay.saved).toHaveLength(1);
    expect(relay.hello()["publicKey"]).toBe(relay.saved[0]!.publicKey);
  });

  test("a refused pairing takes the key back off the volume", () => {
    const relay = harness({ pairingToken: "mistyped" });
    relay.challenge();
    expect(relay.saved).toHaveLength(1);
    relay.close(RELAY_CLOSE.tokenSpent, "token-spent");
    expect(relay.forgotten).toHaveLength(1);
  });

  test("a dropped socket is not a refusal — the key stays, the token is gone", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    relay.close(1006);
    expect(relay.forgotten).toEqual([]);
  });

  test("a later refusal does not take a key an earlier pairing earned", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    relay.close(1006);
    relay.elapse();
    relay.challenge();
    relay.close(RELAY_CLOSE.unlinked, "unlinked");
    expect(relay.forgotten).toEqual([]);
  });

  test("and it reports connected once the hello is away", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    expect(relay.last()).toMatchObject({ state: "connected", nextRetryAt: null });
  });

  test("the token is spent once — a reconnect signs instead", () => {
    const relay = harness({ pairingToken: "mint-fresh" });
    relay.challenge();
    relay.close(1006);
    relay.elapse();
    relay.challenge();
    const second = JSON.parse(relay.dials[1]!.sent[0]!) as Record<string, unknown>;
    expect(second["pairingToken"]).toBeUndefined();
    expect(typeof second["signature"]).toBe("string");
  });
});

describe("a deployment that has already paired", () => {
  test("signs the relay's nonce with the key on its volume", () => {
    const key = generateDeploymentKey();
    const relay = harness({ key });
    relay.challenge();
    const hello = relay.hello();
    expect(hello["publicKey"]).toBe(key.publicKey);
    expect(verifyNonceSignature(key.publicKey, NONCE, hello["signature"] as string)).toBe(true);
  });

  test("saves nothing — the key is already where it belongs", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    expect(relay.saved).toEqual([]);
  });

  test("and ignores a pairing token still sitting in the environment", () => {
    const key = generateDeploymentKey();
    const relay = harness({ key, pairingToken: "left-in-dot-env" });
    relay.challenge();
    expect(relay.hello()["pairingToken"]).toBeUndefined();
    expect(relay.logs.join("\n")).toContain("PHOEBE_RELAY_TOKEN is ignored");
  });
});

describe("a deployment with neither a key nor a token", () => {
  test("never dials, and says why through the report", () => {
    const relay = harness();
    expect(relay.dials).toEqual([]);
    expect(relay.last()).toMatchObject({ configured: true, state: "unpaired" });
  });
});

describe("refusals", () => {
  test.each([
    ["unlinked", RELAY_CLOSE.unlinked],
    ["bad-signature", RELAY_CLOSE.badSignature],
    ["token-spent", RELAY_CLOSE.tokenSpent],
    ["replaced", RELAY_CLOSE.replaced],
  ])("a %s close stops the link rather than retrying it", (reason, code) => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.close(code, reason);
    expect(relay.timers).toEqual([]);
    expect(relay.last()).toMatchObject({ state: "unpaired", nextRetryAt: null });
    expect(relay.last().lastClose).toMatchObject({ code, reason });
  });

  test("a protocol close retries slowly — the fix is an operator upgrading the relay", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.close(RELAY_CLOSE.protocol, "relay speaks 1");
    expect(relay.timers[0]!.ms).toBe(PROTOCOL_RETRY_MS);
    expect(relay.last().state).toBe("reconnecting");
  });

  test("an older relay is named before its refusal arrives", () => {
    const relay = harness({ key: generateDeploymentKey(), protocol: 3 });
    relay.challenge(2);
    expect(relay.logs.join("\n")).toContain("Upgrade the relay first");
  });

  test("an ordinary drop backs off and says when it will try again", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.close(1006);
    expect(relay.timers[0]!.ms).toBe(reconnectDelayMs(0, () => 0));
    expect(relay.last().state).toBe("reconnecting");
    expect(relay.last().nextRetryAt).not.toBeNull();
  });

  test("the ladder climbs while the relay stays down, and resets when it comes back", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.close(1006);
    expect(relay.timers[0]!.ms).toBe(reconnectDelayMs(0, () => 0));
    relay.elapse();
    relay.close(1006);
    expect(relay.timers[0]!.ms).toBe(reconnectDelayMs(1, () => 0));
    relay.elapse();
    relay.challenge();
    relay.close(1006);
    expect(relay.timers[0]!.ms).toBe(reconnectDelayMs(0, () => 0));
  });
});

describe("reconnectDelayMs", () => {
  test("it never exceeds the ladder's entry, and never collapses to zero", () => {
    for (let attempt = 0; attempt < RECONNECT_SCHEDULE_MS.length + 3; attempt += 1) {
      const ceiling = RECONNECT_SCHEDULE_MS[Math.min(attempt, RECONNECT_SCHEDULE_MS.length - 1)]!;
      expect(reconnectDelayMs(attempt, () => 1)).toBeLessThanOrEqual(ceiling);
      expect(reconnectDelayMs(attempt, () => 0)).toBe(ceiling / 2);
    }
  });

  test("the last rung repeats — a relay down for an hour is still worth a knock", () => {
    const last = RECONNECT_SCHEDULE_MS.length - 1;
    expect(reconnectDelayMs(last + 50, () => 0)).toBe(reconnectDelayMs(last, () => 0));
  });
});

describe("stopping", () => {
  test("closes the socket and cancels the pending retry", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.stop();
    expect(relay.dials[0]!.closed).toBe(true);
    relay.close(1006);
    expect(relay.timers).toEqual([]);
  });
});

describe("noise on the wire", () => {
  test("a frame that is not JSON, or not a challenge, is ignored", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.dials[0]!.handlers.onOpen();
    relay.dials[0]!.handlers.onMessage("{not json");
    relay.dials[0]!.handlers.onMessage(JSON.stringify({ type: RELAY_MESSAGES.heartbeat }));
    expect(relay.dials[0]!.sent).toEqual([]);
  });

  test("a second challenge on one connection is answered once", () => {
    const relay = harness({ key: generateDeploymentKey() });
    relay.challenge();
    relay.challenge();
    expect(relay.dials[0]!.sent).toHaveLength(1);
  });
});
