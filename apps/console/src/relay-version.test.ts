// The version handshake as the console performs it: the inequality, the three
// verdicts, and the sentence each one puts on screen.

import { describe, expect, test } from "vite-plus/test";
import { CONSOLE_PROTOCOL } from "phoebe-agent/contracts";
import type { RelayVersion } from "phoebe-agent/contracts";
import { RelayRequestError, type RelayClient } from "./relay-client.ts";
import { readRelayVersion, relayServesConsole, tooOldText } from "./relay-version.ts";

/** A client whose only answered read is the version one. */
function clientAnswering(answer: RelayVersion | Error): RelayClient {
  return {
    version: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
    me: () => Promise.reject(new Error("the console asked for more than the version")),
    signOut: () => Promise.reject(new Error("the console asked for more than the version")),
    deployments: () => Promise.reject(new Error("the console asked for more than the version")),
    deployment: () => Promise.reject(new Error("the console asked for more than the version")),
    events: () => () => {},
  };
}

describe("the rule", () => {
  test("a relay at the console's own protocol serves it", () => {
    expect(relayServesConsole(2, 2)).toBe(true);
  });

  test("a relay above it serves it — upgrading a relay never strands a console", () => {
    expect(relayServesConsole(3, 2)).toBe(true);
  });

  test("a relay below it does not; that is the whole refusal", () => {
    expect(relayServesConsole(1, 2)).toBe(false);
  });
});

describe("reading a relay", () => {
  test("a relay at or above this build serves it, and carries its version along", async () => {
    const reading = await readRelayVersion(
      clientAnswering({ version: "0.13.0", console: CONSOLE_PROTOCOL }),
    );

    expect(reading).toEqual({
      kind: "serves",
      relay: { version: "0.13.0", console: CONSOLE_PROTOCOL },
    });
  });

  test("a relay below this build is too old, with the integer it answered", async () => {
    const reading = await readRelayVersion(
      clientAnswering({ version: "0.9.0", console: CONSOLE_PROTOCOL - 1 }),
    );

    expect(reading.kind).toBe("too-old");
    expect(reading.kind === "too-old" ? reading.relay?.version : null).toBe("0.9.0");
  });

  test("a relay with no /api/version at all is too old — a 404 is the same verdict", async () => {
    // The route arrived with console protocol 1, so a relay that does not answer
    // it predates every protocol there has been.
    const reading = await readRelayVersion(
      clientAnswering(new RelayRequestError(404, "no-such-route")),
    );

    expect(reading).toEqual({ kind: "too-old", relay: null });
  });

  test("a relay that could not be reached is unread, not refused", async () => {
    // Refusing on a read that did not happen would strand every operator whose
    // relay was merely slow, or whose companion has no session to ask through.
    const reading = await readRelayVersion(clientAnswering(new TypeError("failed to fetch")));

    expect(reading).toEqual({ kind: "unread" });
  });

  test("a 401 is unread too — a door in front of the version is not an old relay", async () => {
    const reading = await readRelayVersion(
      clientAnswering(new RelayRequestError(401, "signed-out")),
    );

    expect(reading).toEqual({ kind: "unread" });
  });
});

describe("what it says", () => {
  test("names both integers and the one sentence the wire already uses", () => {
    const text = tooOldText({ version: "0.9.0", console: 0 });

    expect(text).toContain("console protocol 0");
    expect(text).toContain("phoebe-agent 0.9.0");
    expect(text).toContain(`speaks ${CONSOLE_PROTOCOL}`);
    expect(text).toContain("upgrade the relay first");
  });

  test("says what it can when the relay answered nothing at all", () => {
    const text = tooOldText(null);

    expect(text).toContain("older console API");
    expect(text).toContain("upgrade the relay first");
    expect(text).not.toContain("undefined");
  });
});
