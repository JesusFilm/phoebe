// Crash-safe issue claim tests (#15): TTL resolution, the lease marker
// round-trip, and the reclaim decision (no marker / own-restart / expired /
// still-fresh).

import { describe, expect, test } from "vite-plus/test";
import {
  buildLeaseComment,
  buildLeaseMarker,
  buildReclaimComment,
  DEFAULT_LEASE_TTL_MS,
  leaseHeartbeatIntervalMs,
  parseLeaseMarker,
  reclaimDecision,
  resolveLeaseTtlMs,
  type LeaseMarker,
} from "./claim-lease.ts";

describe("resolveLeaseTtlMs", () => {
  test("defaults to 30 minutes", () => {
    expect(resolveLeaseTtlMs({})).toBe(DEFAULT_LEASE_TTL_MS);
    expect(DEFAULT_LEASE_TTL_MS).toBe(1_800_000);
  });
  test("env overrides config overrides default", () => {
    expect(resolveLeaseTtlMs({}, 60_000)).toBe(60_000);
    expect(resolveLeaseTtlMs({ PHOEBE_LEASE_TTL_MS: "120000" }, 60_000)).toBe(120_000);
    expect(resolveLeaseTtlMs({ PHOEBE_LEASE_TTL_MS: "0" }, 60_000)).toBe(60_000);
    expect(resolveLeaseTtlMs({ PHOEBE_LEASE_TTL_MS: "-5" }, 60_000)).toBe(60_000);
    expect(resolveLeaseTtlMs({ PHOEBE_LEASE_TTL_MS: "not-a-number" }, 60_000)).toBe(60_000);
  });
});

describe("leaseHeartbeatIntervalMs", () => {
  test("a third of the TTL", () => {
    expect(leaseHeartbeatIntervalMs(900_000)).toBe(300_000);
  });
  test("floors at 30s so a tiny TTL never busy-loops", () => {
    expect(leaseHeartbeatIntervalMs(10_000)).toBe(30_000);
  });
});

describe("lease marker", () => {
  const lease: LeaseMarker = {
    runtimeId: "runtime-abc-123",
    claimedAt: "2026-08-04T10:00:00.000Z",
    heartbeatAt: "2026-08-04T10:05:00.000Z",
    branch: "phoebe/issue-15",
  };

  test("round-trips through build/parse", () => {
    expect(parseLeaseMarker(buildLeaseMarker(lease))).toEqual(lease);
  });

  test("comment embeds the marker and the runtime/branch", () => {
    const comment = buildLeaseComment(lease);
    expect(comment).toContain(lease.runtimeId);
    expect(comment).toContain(lease.branch);
    expect(parseLeaseMarker(comment)).toEqual(lease);
  });

  test("no marker in unrelated text", () => {
    expect(parseLeaseMarker("just a regular comment")).toBeNull();
  });

  test("reclaim comment names the reason", () => {
    expect(buildReclaimComment("expired")).toContain("stale");
    expect(buildReclaimComment("own-restart")).toContain("restarted");
    expect(buildReclaimComment("no-lease")).toContain("no lease marker");
  });
});

describe("reclaimDecision", () => {
  const ttlMs = 1_800_000; // 30 min
  const nowMs = Date.parse("2026-08-04T12:00:00.000Z");
  const owned = (heartbeatAt: string): LeaseMarker => ({
    runtimeId: "runtime-self",
    claimedAt: heartbeatAt,
    heartbeatAt,
    branch: "phoebe/issue-15",
  });
  const foreign = (heartbeatAt: string): LeaseMarker => ({
    runtimeId: "runtime-other",
    claimedAt: heartbeatAt,
    heartbeatAt,
    branch: "phoebe/issue-15",
  });

  test("no marker at all is always reclaimed", () => {
    expect(
      reclaimDecision(null, { ownRuntimeId: "runtime-self", nowMs, ttlMs, forceOwnReclaim: false }),
    ).toBe("no-lease");
    expect(
      reclaimDecision(null, { ownRuntimeId: "runtime-self", nowMs, ttlMs, forceOwnReclaim: true }),
    ).toBe("no-lease");
  });

  test("boot (forceOwnReclaim) reclaims its own claim unconditionally, even with a fresh heartbeat", () => {
    const fresh = owned(new Date(nowMs - 1_000).toISOString());
    expect(
      reclaimDecision(fresh, { ownRuntimeId: "runtime-self", nowMs, ttlMs, forceOwnReclaim: true }),
    ).toBe("own-restart");
  });

  test("mid-run (not forceOwnReclaim) leaves its own fresh claim alone", () => {
    const fresh = owned(new Date(nowMs - 1_000).toISOString());
    expect(
      reclaimDecision(fresh, {
        ownRuntimeId: "runtime-self",
        nowMs,
        ttlMs,
        forceOwnReclaim: false,
      }),
    ).toBeNull();
  });

  test("a slow-but-alive foreign claim with a fresh heartbeat is never reclaimed", () => {
    const fresh = foreign(new Date(nowMs - 1_000).toISOString());
    expect(
      reclaimDecision(fresh, {
        ownRuntimeId: "runtime-self",
        nowMs,
        ttlMs,
        forceOwnReclaim: false,
      }),
    ).toBeNull();
  });

  test("a foreign claim past the TTL is reclaimed as expired", () => {
    const stale = foreign(new Date(nowMs - ttlMs - 1_000).toISOString());
    expect(
      reclaimDecision(stale, {
        ownRuntimeId: "runtime-self",
        nowMs,
        ttlMs,
        forceOwnReclaim: false,
      }),
    ).toBe("expired");
  });

  test("exactly at the TTL boundary is not yet expired", () => {
    const boundary = foreign(new Date(nowMs - ttlMs).toISOString());
    expect(
      reclaimDecision(boundary, {
        ownRuntimeId: "runtime-self",
        nowMs,
        ttlMs,
        forceOwnReclaim: false,
      }),
    ).toBeNull();
  });

  test("an unparseable heartbeat timestamp is treated as expired", () => {
    const malformed = foreign("not-a-timestamp");
    expect(
      reclaimDecision(malformed, {
        ownRuntimeId: "runtime-self",
        nowMs,
        ttlMs,
        forceOwnReclaim: false,
      }),
    ).toBe("expired");
  });

  test("mid-run, a stale own claim is still reclaimed like any other (no thrash-retry)", () => {
    const stale = owned(new Date(nowMs - ttlMs - 1_000).toISOString());
    expect(
      reclaimDecision(stale, {
        ownRuntimeId: "runtime-self",
        nowMs,
        ttlMs,
        forceOwnReclaim: false,
      }),
    ).toBe("expired");
  });
});
