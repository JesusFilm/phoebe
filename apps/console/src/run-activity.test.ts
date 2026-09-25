import { describe, expect, test } from "vite-plus/test";
import {
  busyInstalls,
  NO_ACTIVITY,
  runAnswered,
  runAsked,
  runEnded,
  runSeen,
} from "./run-activity.ts";

const ONE = "/repos/one";
const TWO = "/repos/two";

describe("which installs are busy", () => {
  test("an install is busy from the click, before main has answered with an id", () => {
    const activity = runAsked(NO_ACTIVITY, ONE);

    expect(busyInstalls(activity)).toEqual(new Set([ONE]));
  });

  test("the answer moves it from pending to the run, and the exit clears it", () => {
    let activity = runAnswered(runAsked(NO_ACTIVITY, ONE), ONE, "run-1");
    expect(busyInstalls(activity)).toEqual(new Set([ONE]));
    expect(activity.pending.size).toBe(0);

    activity = runEnded(activity, "run-1");

    expect(busyInstalls(activity)).toEqual(new Set());
  });

  test("a refusal clears the pending mark and starts no run", () => {
    const activity = runAnswered(runAsked(NO_ACTIVITY, ONE), ONE, null);

    expect(busyInstalls(activity)).toEqual(new Set());
  });

  test("a run seen from its lines counts too, so the page's runs spin the rail", () => {
    const activity = runSeen(NO_ACTIVITY, "run-7", TWO);

    expect(busyInstalls(activity)).toEqual(new Set([TWO]));
    expect(runSeen(activity, "run-7", TWO)).toBe(activity);
  });

  test("an exit for a run never seen changes nothing", () => {
    expect(runEnded(NO_ACTIVITY, "run-9")).toBe(NO_ACTIVITY);
  });

  test("two installs busy at once are two entries, not one", () => {
    const activity = runSeen(runAnswered(runAsked(NO_ACTIVITY, ONE), ONE, "run-1"), "run-2", TWO);

    expect(busyInstalls(activity)).toEqual(new Set([ONE, TWO]));
    expect(busyInstalls(runEnded(activity, "run-1"))).toEqual(new Set([TWO]));
  });
});
