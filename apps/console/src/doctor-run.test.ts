// The words around the button (#546): when a deployment cannot be asked, and
// what each receipt reads as once it has been.

import { describe, expect, test } from "vite-plus/test";
import { fleetLine, outcomeLine, whyNotAskable } from "./doctor-run.ts";
import { ago, NOW, row } from "./test-fixture.ts";

/** One result, with the fields a receipt always carries. */
function result(overrides: Partial<Parameters<typeof outcomeLine>[0]> = {}) {
  return {
    fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    name: "youtube-studio",
    state: "connected" as const,
    outcome: "started",
    ...overrides,
  };
}

describe("who can be asked", () => {
  test("a connected deployment can", () => {
    expect(whyNotAskable(row(), NOW)).toBeNull();
  });

  test("a disconnected one cannot, and the reason carries the relay's seconds", () => {
    const why = whyNotAskable(
      row({ state: "disconnected", connectedSince: null, disconnectedForSeconds: 12 }),
      NOW,
    );

    expect(why).toContain("12 s");
    expect(why).toContain("undelivered");
  });

  test("a dark one cannot, and the reason is its age rather than a count of seconds", () => {
    const why = whyNotAskable(
      row({ state: "dark", connectedSince: null, lastSeen: ago(2 * 86_400) }),
      NOW,
    );

    expect(why).toContain("dark");
    expect(why).toContain("2 d");
  });

  test("an unseen one is told it has never connected, not that it went dark", () => {
    const why = whyNotAskable(row({ state: "unseen", connectedSince: null, lastSeen: null }), NOW);

    expect(why).toContain("never connected");
    expect(why).not.toContain("dark");
  });
});

describe("what came back", () => {
  test("started says the report is what to wait for", () => {
    expect(outcomeLine(result({ outcome: "started" }))).toContain("report");
  });

  test("joined names the run that was already under way", () => {
    expect(outcomeLine(result({ outcome: "joined" }))).toBe("joined the run already under way");
  });

  test("refused quotes the deployment's own sentence", () => {
    const line = outcomeLine(
      result({ outcome: "refused", detail: "the deployment is shutting down" }),
    );

    expect(line).toBe("refused: the deployment is shutting down");
  });

  test("undelivered says where the relay held it", () => {
    const line = outcomeLine(result({ outcome: "undelivered", state: "dark" }));

    expect(line).toContain("undelivered");
    expect(line).toContain("dark");
  });

  test("a word this console has never heard of is quoted, not translated", () => {
    expect(outcomeLine(result({ outcome: "deferred", detail: "until Tuesday" }))).toBe(
      "deferred: until Tuesday",
    );
  });
});

describe("the fleet press", () => {
  test("counts each word and says how many were asked", () => {
    const line = fleetLine([
      result({ fingerprint: "one", outcome: "started" }),
      result({ fingerprint: "two", outcome: "started" }),
      result({ fingerprint: "three", outcome: "joined" }),
      result({ fingerprint: "four", outcome: "undelivered", state: "dark" }),
    ]);

    expect(line).toBe("4 asked — 2 started, 1 joined, 1 undelivered.");
  });

  test("a relay with no link says so rather than reading as a press that did nothing", () => {
    expect(fleetLine([])).toContain("no link yet");
  });
});
