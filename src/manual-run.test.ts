import { EventEmitter } from "node:events";
import { describe, expect, test } from "vite-plus/test";
import {
  createManualRunInbox,
  isPeriod,
  MANUAL_RUN,
  parseManualRunMessage,
  type ManualRun,
} from "./manual-run.ts";

const RUN: ManualRun = {
  kind: "observer",
  by: "shell",
  at: "2026-11-25T12:00:00.000Z",
  lookback: "3d",
};

describe("isPeriod", () => {
  test("takes a positive count and a unit, nothing else", () => {
    for (const ok of ["14d", "36h", "2w", "90m", "1s"]) expect(isPeriod(ok)).toBe(true);
    for (const bad of ["0d", "14", "d", "14 d", "1.5d", "14y", ""])
      expect(isPeriod(bad)).toBe(false);
  });
});

describe("parseManualRunMessage", () => {
  test("reads a manual run and nothing else on the channel", () => {
    expect(parseManualRunMessage({ type: MANUAL_RUN, run: RUN })).toEqual(RUN);
    expect(parseManualRunMessage({ type: MANUAL_RUN, run: { ...RUN, lookback: null } })).toEqual({
      ...RUN,
      lookback: null,
    });
    expect(parseManualRunMessage({ type: "phoebe:slot:granted" })).toBeNull();
    expect(
      parseManualRunMessage({ type: MANUAL_RUN, run: { ...RUN, lookback: "soon" } }),
    ).toBeNull();
    expect(parseManualRunMessage({ type: MANUAL_RUN, run: { ...RUN, kind: "" } })).toBeNull();
    expect(parseManualRunMessage({ type: MANUAL_RUN })).toBeNull();
    expect(parseManualRunMessage("observer")).toBeNull();
  });
});

describe("the inbox", () => {
  function inbox(schedules: string[]) {
    const channel = new EventEmitter();
    const logged: string[] = [];
    const box = createManualRunInbox(
      { on: (event, listener) => channel.on(event, listener) },
      { schedules: (kind) => schedules.includes(kind), log: (line) => logged.push(line) },
    )!;
    return { channel, logged, box };
  }

  test("is null with no channel: nobody can ask an unsupervised engine", () => {
    expect(createManualRunInbox({}, { schedules: () => true, log: () => {} })).toBeNull();
  });

  test("keeps the newest ask per kind, hands it out once, and wakes on arrival", () => {
    const { channel, logged, box } = inbox(["observer"]);
    let arrivals = 0;
    box.onArrival(() => arrivals++);
    channel.emit("message", { type: MANUAL_RUN, run: { ...RUN, lookback: null } });
    channel.emit("message", { type: MANUAL_RUN, run: RUN });
    expect(arrivals).toBe(2);
    expect(box.take("observer")).toEqual(RUN);
    expect(box.take("observer")).toBeNull();
    expect(logged).toEqual([
      "Manual observer run asked for by shell.",
      "Manual observer run asked for by shell.",
    ]);
  });

  test("drops an ask for a kind this pipeline does not run", () => {
    const { channel, logged, box } = inbox(["issues"]);
    let arrivals = 0;
    box.onArrival(() => arrivals++);
    channel.emit("message", { type: MANUAL_RUN, run: RUN });
    expect(arrivals).toBe(0);
    expect(box.take("observer")).toBeNull();
    expect(logged).toEqual([
      "Manual observer run asked for by shell dropped: this pipeline does not run observer.",
    ]);
  });
});
