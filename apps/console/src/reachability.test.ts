// The reachability state machine (map #690, #697) under a fake clock: every
// transition in the table, the four blocked reasons, the ladder's values and
// jitter bounds, and the words a row says.

import { describe, expect, test } from "vite-plus/test";
import {
  blockedLine,
  blockedReasonOf,
  climbsLadder,
  coarseDuration,
  DARK_AFTER_MS,
  expiryNotice,
  hostnameOf,
  LADDER_MS,
  ladderDelayMs,
  portOf,
  quietOf,
  reachabilityOf,
} from "./reachability.ts";

const T0 = 1_700_000_000_000;
const stored = { deploymentId: "dep_A", protocol: 1 };
const base = { now: T0, streaming: true, lastFailure: null, descriptor: null, stored };

describe("the four states", () => {
  test("connected: the stream is open and something arrived in the last 60 s", () => {
    expect(reachabilityOf({ ...base, lastHeardAt: T0 - 10_000 })).toEqual({ state: "connected" });
    expect(reachabilityOf({ ...base, lastHeardAt: T0 - DARK_AFTER_MS + 1 })).toEqual({
      state: "connected",
    });
  });

  test("disconnected: the stream dropped or a request failed, under 60 s ago", () => {
    expect(
      reachabilityOf({
        ...base,
        lastHeardAt: T0 - 10_000,
        streaming: false,
        lastFailure: { kind: "stream-dropped" },
      }),
    ).toEqual({ state: "disconnected" });
    expect(
      reachabilityOf({
        ...base,
        lastHeardAt: T0 - 10_000,
        lastFailure: { kind: "request-failed", status: 503 },
      }),
    ).toEqual({ state: "disconnected" });
    expect(reachabilityOf({ ...base, lastHeardAt: T0 - 10_000, streaming: false })).toEqual({
      state: "disconnected",
    });
  });

  test("dark: unheard for 60 s, whatever the stream claims; never heard is dark too", () => {
    expect(reachabilityOf({ ...base, lastHeardAt: T0 - DARK_AFTER_MS })).toEqual({ state: "dark" });
    expect(
      reachabilityOf({
        ...base,
        lastHeardAt: T0 - 3_600_000,
        streaming: false,
        lastFailure: { kind: "timeout" },
      }),
    ).toEqual({ state: "dark" });
    expect(reachabilityOf({ ...base, lastHeardAt: null })).toEqual({ state: "dark" });
  });

  test("blocked wins over everything, with its reason", () => {
    expect(
      reachabilityOf({
        ...base,
        lastHeardAt: T0,
        lastFailure: { kind: "unauthenticated", reason: "expired" },
      }),
    ).toEqual({ state: "blocked", blocked: "expired" });
  });
});

describe("the four endings", () => {
  test("401 expired is expired; 401 unknown with the stored id answering is revoked", () => {
    expect(
      blockedReasonOf(
        { kind: "unauthenticated", reason: "expired" },
        { deploymentId: "dep_A", protocol: 1 },
        stored,
      ),
    ).toBe("expired");
    expect(
      blockedReasonOf(
        { kind: "unauthenticated", reason: "unknown" },
        { deploymentId: "dep_A", protocol: 1 },
        stored,
      ),
    ).toBe("revoked");
    expect(blockedReasonOf({ kind: "unauthenticated", reason: "unknown" }, null, stored)).toBe(
      "revoked",
    );
  });

  test("a descriptor with another id is replaced, whatever the failure", () => {
    expect(blockedReasonOf(null, { deploymentId: "dep_B", protocol: 1 }, stored)).toBe("replaced");
    expect(
      blockedReasonOf(
        { kind: "unauthenticated", reason: "unknown" },
        { deploymentId: "dep_B", protocol: 1 },
        stored,
      ),
    ).toBe("replaced");
  });

  test("a newer protocol is protocol; an older or equal one is fine", () => {
    expect(blockedReasonOf(null, { deploymentId: "dep_A", protocol: 2 }, stored)).toBe("protocol");
    expect(blockedReasonOf(null, { deploymentId: "dep_A", protocol: 1 }, stored)).toBeNull();
    expect(blockedReasonOf(null, { deploymentId: "dep_A", protocol: 0 }, stored)).toBeNull();
  });

  test("ordinary failures block nothing", () => {
    expect(blockedReasonOf({ kind: "request-failed", status: 503 }, null, stored)).toBeNull();
    expect(blockedReasonOf({ kind: "timeout" }, null, stored)).toBeNull();
    expect(blockedReasonOf({ kind: "stream-dropped" }, null, stored)).toBeNull();
  });
});

describe("the ladder", () => {
  test("3, 4, 8, 16, 30 s, capped at 30, within ±25 %", () => {
    expect(LADDER_MS).toEqual([3_000, 4_000, 8_000, 16_000, 30_000]);
    for (const [attempt, rung] of [
      [0, 3_000],
      [1, 4_000],
      [2, 8_000],
      [3, 16_000],
      [4, 30_000],
      [9, 30_000],
    ] as const) {
      expect(ladderDelayMs(attempt, () => 0.5)).toBe(rung);
      expect(ladderDelayMs(attempt, () => 0)).toBe(Math.round(rung * 0.75));
      expect(ladderDelayMs(attempt, () => 0.999_999)).toBeLessThanOrEqual(Math.round(rung * 1.25));
      for (let i = 0; i < 20; i++) {
        const delay = ladderDelayMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(rung * 0.75 - 1);
        expect(delay).toBeLessThanOrEqual(rung * 1.25 + 1);
      }
    }
  });

  test("a 401 never climbs; everything else does", () => {
    expect(climbsLadder({ kind: "unauthenticated", reason: "expired" })).toBe(false);
    expect(climbsLadder({ kind: "request-failed", status: 503 })).toBe(true);
    expect(climbsLadder({ kind: "request-failed", status: 500 })).toBe(true);
    expect(climbsLadder({ kind: "timeout" })).toBe(true);
    expect(climbsLadder({ kind: "stream-dropped" })).toBe(true);
  });
});

describe("the words", () => {
  test("quiet clocks for the alert rule", () => {
    expect(quietOf(null, T0)).toEqual({ quietForMs: null, quietSince: null });
    expect(quietOf(T0 - 5_000, T0)).toEqual({
      quietForMs: 5_000,
      quietSince: new Date(T0 - 5_000).toISOString(),
    });
  });

  test("coarse durations never print 10080 min", () => {
    expect(coarseDuration(30_000)).toBe("under a minute");
    expect(coarseDuration(3 * 60_000)).toBe("3 min");
    expect(coarseDuration(5 * 3_600_000)).toBe("5 h");
    expect(coarseDuration(7 * 86_400_000)).toBe("7 d");
  });

  test("the expiry notice appears three days out and not before", () => {
    const expiresAt = new Date(T0 + 2 * 86_400_000).toISOString();
    expect(expiryNotice(expiresAt, T0)).toBe("session expires in 2 d");
    expect(expiryNotice(new Date(T0 + 10 * 86_400_000).toISOString(), T0)).toBeNull();
    expect(expiryNotice(new Date(T0 - 1).toISOString(), T0)).toBeNull();
    expect(expiryNotice("nope", T0)).toBeNull();
  });

  test("each blocked reason has its line and its action", () => {
    expect(blockedLine("expired")).toEqual({ text: "session expired", action: "pair again" });
    expect(blockedLine("revoked")).toEqual({ text: "session revoked", action: "pair again" });
    expect(blockedLine("replaced")).toEqual({
      text: "a different deployment answers here",
      action: "pair again",
    });
    expect(blockedLine("protocol")).toEqual({
      text: "newer than this companion",
      action: "update",
    });
  });

  test("hostname and port off a URL", () => {
    expect(hostnameOf("https://demo-host.tail4f2c.ts.net:8443")).toBe("demo-host.tail4f2c.ts.net");
    expect(portOf("https://demo-host.tail4f2c.ts.net:8443")).toBe("8443");
    expect(portOf("https://demo-host.tail4f2c.ts.net")).toBeNull();
    expect(hostnameOf("not a url")).toBe("not a url");
  });
});
