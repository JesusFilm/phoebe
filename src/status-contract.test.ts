import { describe, expect, test } from "vite-plus/test";
import {
  ContractCapabilityError,
  digestValue,
  parseStatusSnapshot,
  STATUS_SCHEMA_VERSION,
  type StatusSnapshot,
} from "./status-contract.ts";

const snapshot = (): StatusSnapshot => ({
  schemaVersion: STATUS_SCHEMA_VERSION,
  updatedAt: "2026-07-30T12:00:00.000Z",
  runtime: {
    runtimeId: "runtime-1",
    instanceId: "instance-1",
    startedAt: "2026-07-30T11:00:00.000Z",
  },
  repository: {
    slug: "owner/repo",
    url: "https://github.com/owner/repo",
    defaultBranch: "main",
  },
  digests: {
    engine: "sha256:engine",
    bootstrap: "sha256:bootstrap",
    config: "sha256:config",
    policy: "sha256:policy",
    prompts: "sha256:prompts",
    providerModel: "sha256:provider-model",
  },
  capabilities: ["status-v1", "events-v1", "events-replay-v1", "events-range-v1"],
  lifecycle: { state: "idle", reason: "No work this cycle." },
  activeWork: null,
  lastSuccess: null,
  lastFailure: null,
  control: {
    retry: { attempt: 0 },
    backoff: { active: false },
    quarantine: { active: false },
    drain: { requested: false },
  },
  health: {
    state: "healthy",
    telemetry: { writable: true, lastError: null, lastErrorAt: null },
  },
  journal: {
    earliestSequence: null,
    latestSequence: null,
    retainedSegments: 0,
    quarantinedTailCount: 0,
  },
  links: {
    repository: "https://github.com/owner/repo",
  },
});

describe("status-v1 contract", () => {
  test("accepts the v1 projection and tolerates unknown additive fields", () => {
    const input = {
      ...snapshot(),
      additiveTopLevelField: true,
      runtime: { ...snapshot().runtime, additiveRuntimeField: "future" },
    };

    expect(parseStatusSnapshot(input)).toBe(input);
  });

  test("rejects an unsupported major with an explicit capability error", () => {
    expect(() => parseStatusSnapshot({ ...snapshot(), schemaVersion: "status-v2" })).toThrowError(
      ContractCapabilityError,
    );
    expect(() => parseStatusSnapshot({ ...snapshot(), schemaVersion: "status-v2" })).toThrow(
      /supports status-v1 but received status-v2/,
    );
  });

  test("rejects malformed v1 data instead of treating it as another version", () => {
    expect(() =>
      parseStatusSnapshot({ ...snapshot(), runtime: { runtimeId: "runtime-1" } }),
    ).toThrow(/invalid status-v1 snapshot/);
  });

  test("produces stable, key-order-independent sha256 digests", () => {
    expect(digestValue({ b: 2, a: 1 })).toBe(digestValue({ a: 1, b: 2 }));
    expect(digestValue({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("rejects semantically invalid v1 values that would violate the published schemas", () => {
    expect(() =>
      parseStatusSnapshot({
        ...snapshot(),
        lifecycle: { state: "teleporting" },
      }),
    ).toThrow(/invalid status-v1/);
  });
});
