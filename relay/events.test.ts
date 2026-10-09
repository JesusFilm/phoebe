// The event hub: who hears what, and what happens to a listener that has gone.

import { describe, expect, test } from "vite-plus/test";
import { RELAY_EVENTS } from "../src/contracts/relay-events.ts";
import type { RelayEvent } from "../src/contracts/relay-events.ts";
import { createRelayEvents } from "./events.ts";

const arrival: RelayEvent = {
  type: RELAY_EVENTS.report,
  at: "2026-09-18T10:00:00.000Z",
  fingerprint: "a".repeat(32),
  schema: 1,
  report: { anything: true },
};

describe("the relay's event hub", () => {
  test("every subscriber gets every event", () => {
    const events = createRelayEvents();
    const console1: RelayEvent[] = [];
    const console2: RelayEvent[] = [];
    events.subscribe((event) => console1.push(event));
    events.subscribe((event) => console2.push(event));

    events.emit(arrival);

    expect(console1).toEqual([arrival]);
    expect(console2).toEqual([arrival]);
  });

  test("an event before anyone is watching is an event nobody gets", () => {
    const events = createRelayEvents();
    events.emit(arrival);
    const late: RelayEvent[] = [];

    events.subscribe((event) => late.push(event));

    // No replay by decision: there is a GET behind every event, and a page that
    // missed one refetches rather than resyncs.
    expect(late).toEqual([]);
  });

  test("unsubscribing stops the events and frees the slot", () => {
    const events = createRelayEvents();
    const seen: RelayEvent[] = [];
    const stop = events.subscribe((event) => seen.push(event));

    stop();
    events.emit(arrival);

    expect(seen).toEqual([]);
    expect(events.watching()).toBe(0);
  });

  test("a listener that throws is dropped, and the rest still hear it", () => {
    const warnings: string[] = [];
    const events = createRelayEvents({ warn: (message) => warnings.push(message) });
    const survivor: RelayEvent[] = [];
    events.subscribe(() => {
      // A response whose socket died between the emit and the write.
      throw new Error("write after end");
    });
    events.subscribe((event) => survivor.push(event));

    expect(() => events.emit(arrival)).not.toThrow();

    expect(survivor).toEqual([arrival]);
    expect(events.watching()).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});
