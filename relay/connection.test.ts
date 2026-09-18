// The four words the relay has for a deployment, and the two clocks that decide
// between them.

import { describe, expect, test } from "vite-plus/test";
import { RELAY_DARK_AFTER_MS } from "../src/contracts/relay-protocol.ts";
import { connectionOf, deploymentRows, NOTHING_HEARD } from "./connection.ts";
import type { Link } from "./links.ts";

const STARTED = new Date("2026-09-18T12:00:00.000Z");

function link(overrides: Partial<Link> = {}): Link {
  return {
    publicKey: "pk-widget",
    boxKey: "box-widget",
    fingerprint: "fp-widget",
    name: "acme/widget",
    firstSeen: "2026-09-01T09:00:00.000Z",
    lastSeen: "2026-09-18T11:59:30.000Z",
    pairedBy: "ada@example.test",
    ...overrides,
  };
}

/** `ms` after the relay started. */
function at(ms: number): Date {
  return new Date(STARTED.getTime() + ms);
}

describe("connectionOf", () => {
  test("a live socket is connected, and nothing else is asked", () => {
    const verdict = connectionOf({
      link: link(),
      facts: { ...NOTHING_HEARD, connectedSince: at(1_000) },
      relayStartedAt: STARTED,
      now: at(10 * RELAY_DARK_AFTER_MS),
    });

    expect(verdict).toEqual({ state: "connected", disconnectedForSeconds: null });
  });

  test("inside the window it is a duration, not a verdict", () => {
    const verdict = connectionOf({
      link: link(),
      facts: { ...NOTHING_HEARD, lastHeard: at(5_000) },
      relayStartedAt: STARTED,
      now: at(17_400),
    });

    expect(verdict).toEqual({ state: "disconnected", disconnectedForSeconds: 12 });
  });

  test("past the threshold it is dark, and the seconds stop being interesting", () => {
    const verdict = connectionOf({
      link: link(),
      facts: { ...NOTHING_HEARD, lastHeard: at(5_000) },
      relayStartedAt: STARTED,
      now: at(5_000 + RELAY_DARK_AFTER_MS),
    });

    expect(verdict).toEqual({ state: "dark", disconnectedForSeconds: null });
  });

  test("a clean close and a half-open socket are the same silence", () => {
    const quiet = { ...NOTHING_HEARD, lastHeard: at(1_000) };
    const cleanly = connectionOf({
      link: link(),
      facts: {
        ...quiet,
        lastClose: { code: 1001, reason: "going away", at: at(1_000).toISOString() },
      },
      relayStartedAt: STARTED,
      now: at(1_000 + RELAY_DARK_AFTER_MS),
    });
    const abruptly = connectionOf({
      link: link(),
      facts: quiet,
      relayStartedAt: STARTED,
      now: at(1_000 + RELAY_DARK_AFTER_MS),
    });

    expect(cleanly).toEqual(abruptly);
  });

  test("a restart clocks from the restart, so a healthy fleet is not painted dark", () => {
    // `lastSeen` is hours old and nothing has been heard in this process: the
    // naive reading would be dark, and it would be wrong.
    const verdict = connectionOf({
      link: link({ lastSeen: "2026-09-18T06:00:00.000Z" }),
      facts: NOTHING_HEARD,
      relayStartedAt: STARTED,
      now: at(9_000),
    });

    expect(verdict).toEqual({ state: "disconnected", disconnectedForSeconds: 9 });
  });

  test("and a minute after the restart that same deployment is dark", () => {
    const verdict = connectionOf({
      link: link({ lastSeen: "2026-09-18T06:00:00.000Z" }),
      facts: NOTHING_HEARD,
      relayStartedAt: STARTED,
      now: at(RELAY_DARK_AFTER_MS),
    });

    expect(verdict.state).toBe("dark");
  });

  test("a link with no completed handshake is unseen, which is not dark", () => {
    const verdict = connectionOf({
      link: link({ lastSeen: null }),
      facts: NOTHING_HEARD,
      relayStartedAt: STARTED,
      now: at(10 * RELAY_DARK_AFTER_MS),
    });

    expect(verdict).toEqual({ state: "unseen", disconnectedForSeconds: null });
  });
});

describe("deploymentRows", () => {
  test("carries the link's facts and the connection's beside them", () => {
    const rows = deploymentRows({
      links: [link()],
      facts: () => ({
        connectedSince: at(2_000),
        lastHeard: at(3_000),
        lastClose: { code: 4005, reason: "replaced", at: at(1_000).toISOString() },
      }),
      relayStartedAt: STARTED,
      now: at(4_000),
    });

    expect(rows).toEqual([
      {
        fingerprint: "fp-widget",
        name: "acme/widget",
        publicKey: "pk-widget",
        boxKey: "box-widget",
        firstSeen: "2026-09-01T09:00:00.000Z",
        lastSeen: "2026-09-18T11:59:30.000Z",
        pairedBy: "ada@example.test",
        state: "connected",
        connectedSince: at(2_000).toISOString(),
        disconnectedForSeconds: null,
        lastClose: { code: 4005, reason: "replaced", at: at(1_000).toISOString() },
        maybeReplaced: false,
      },
    ]);
  });

  test("a dark link whose name a newer one has taken is asked about", () => {
    const wiped = link({ fingerprint: "fp-old", publicKey: "pk-old" });
    const repaired = link({
      fingerprint: "fp-new",
      publicKey: "pk-new",
      firstSeen: "2026-09-18T11:00:00.000Z",
    });

    const rows = deploymentRows({
      links: [wiped, repaired],
      facts: (entry) =>
        entry.fingerprint === "fp-new"
          ? { ...NOTHING_HEARD, connectedSince: at(1_000) }
          : NOTHING_HEARD,
      relayStartedAt: STARTED,
      now: at(RELAY_DARK_AFTER_MS),
    });

    expect(rows.map((row) => [row.fingerprint, row.state, row.maybeReplaced])).toEqual([
      ["fp-old", "dark", true],
      ["fp-new", "connected", false],
    ]);
  });

  test("the newer record is never the replaced one, however the names line up", () => {
    const older = link({ fingerprint: "fp-old", publicKey: "pk-old" });
    const newer = link({
      fingerprint: "fp-new",
      publicKey: "pk-new",
      firstSeen: "2026-09-18T11:00:00.000Z",
    });

    const rows = deploymentRows({
      links: [older, newer],
      facts: () => NOTHING_HEARD,
      relayStartedAt: STARTED,
      now: at(RELAY_DARK_AFTER_MS),
    });

    expect(rows.map((row) => row.maybeReplaced)).toEqual([true, false]);
  });

  test("two deployments sharing a name while both are dark is not a replacement", () => {
    const twins = [
      link({ fingerprint: "fp-a", publicKey: "pk-a" }),
      link({ fingerprint: "fp-b", publicKey: "pk-b" }),
    ];

    const rows = deploymentRows({
      links: twins,
      facts: () => NOTHING_HEARD,
      relayStartedAt: STARTED,
      now: at(RELAY_DARK_AFTER_MS),
    });

    expect(rows.map((row) => row.maybeReplaced)).toEqual([false, false]);
  });
});
