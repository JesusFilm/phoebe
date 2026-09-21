// The two rules the relay rail's shape rests on: which side has to be newer,
// and what counts as a message at all.

import { describe, expect, test } from "vite-plus/test";
import {
  RELAY_CLOSE,
  RELAY_MESSAGES,
  RELAY_PROTOCOL,
  relayMessageType,
  relaySpeaks,
} from "./relay-protocol.ts";

describe("relaySpeaks", () => {
  test("a relay admits a deployment at or below its own protocol", () => {
    expect(relaySpeaks(2, 1)).toBe(true);
    expect(relaySpeaks(2, 2)).toBe(true);
  });

  test("and refuses one above it — upgrade the relay first", () => {
    expect(relaySpeaks(1, 2)).toBe(false);
  });

  test("the protocol this engine speaks is an integer, not a package version", () => {
    expect(Number.isInteger(RELAY_PROTOCOL)).toBe(true);
  });
});

describe("relayMessageType", () => {
  test("names a known type", () => {
    expect(relayMessageType({ type: RELAY_MESSAGES.hello })).toBe(RELAY_MESSAGES.hello);
  });

  test.each([
    ["a type nobody defined", { type: "phoebe:relay:sudo" }],
    ["a type that is not a string", { type: 7 }],
    ["an object with no type", { nonce: "abc" }],
    ["null", null],
    ["a bare string", "phoebe:relay:hello"],
  ])("refuses %s", (_what, frame) => {
    expect(relayMessageType(frame)).toBeNull();
  });
});

describe("the close codes", () => {
  test("no two refusals share a code", () => {
    const codes = Object.values(RELAY_CLOSE);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
