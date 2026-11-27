// The spend hold's receiving half (#990): what a pipeline makes of the two
// messages. The loop that acts on it is src/main.test.ts.

import { EventEmitter } from "node:events";
import { describe, expect, test } from "vite-plus/test";
import type { SpendHold } from "./contracts/spend.ts";
import {
  createSpendHoldState,
  parseSpendHoldMessage,
  SPEND_HOLD,
  SPEND_RELEASE,
} from "./spend-hold.ts";

const HOLD: SpendHold = {
  scope: "tenant",
  measure: "tokens",
  window: "7d",
  limit: 1000,
  spent: 1200,
  since: "2026-11-25T12:00:00.000Z",
  releaseAt: "2026-11-30T12:00:00.000Z",
};

describe("the spend hold messages", () => {
  test("parse a hold and a release, and nothing else", () => {
    expect(parseSpendHoldMessage({ type: SPEND_HOLD, hold: HOLD })).toEqual({
      kind: "hold",
      hold: HOLD,
    });
    expect(parseSpendHoldMessage({ type: SPEND_RELEASE })).toEqual({ kind: "release" });
    expect(
      parseSpendHoldMessage({ type: SPEND_HOLD, hold: { ...HOLD, window: "30d" } }),
    ).toBeNull();
    expect(parseSpendHoldMessage({ type: SPEND_HOLD })).toBeNull();
    expect(parseSpendHoldMessage({ type: "phoebe:slot:granted" })).toBeNull();
    expect(parseSpendHoldMessage("nope")).toBeNull();
  });
});

describe("the spend hold state", () => {
  test("is null with no channel to hear it on", () => {
    expect(createSpendHoldState({}, { log: () => {} })).toBeNull();
  });

  test("holds from the hold message until the release, and tells listeners of the release", () => {
    const channel = new EventEmitter();
    const logged: string[] = [];
    const state = createSpendHoldState(channel, { log: (line) => logged.push(line) })!;
    let released = 0;
    state.onRelease(() => {
      released += 1;
    });
    expect(state.current()).toBeNull();

    channel.emit("message", { type: SPEND_HOLD, hold: HOLD });
    expect(state.current()).toEqual(HOLD);

    channel.emit("message", { type: SPEND_RELEASE });
    expect(state.current()).toBeNull();
    expect(released).toBe(1);
    expect(logged).toEqual(["Spend hold released — admitting units again."]);

    // A release with nothing held is not news.
    channel.emit("message", { type: SPEND_RELEASE });
    expect(released).toBe(1);
  });
});
