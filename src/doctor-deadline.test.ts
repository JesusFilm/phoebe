// Doctor's internal deadline (#507 §7): what a check that does not finish in
// time turns into, and what the clock must never do to the run around it.

import { describe, expect, test } from "vite-plus/test";
import { createDeadline, noDeadline, DOCTOR_DEADLINE_MS } from "./doctor-deadline.ts";

/** A promise that never settles — the check this whole module exists for. */
function hangs<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("createDeadline", () => {
  test("work that finishes in time comes back as itself", async () => {
    const deadline = createDeadline(1_000);
    await expect(deadline.race(Promise.resolve("probed"))).resolves.toEqual({
      done: true,
      value: "probed",
    });
    deadline.cancel();
  });

  test("work that hangs past the deadline is given up on", async () => {
    const deadline = createDeadline(5);
    await expect(deadline.race(hangs<string>())).resolves.toEqual({ done: false });
  });

  test("a check that fails still fails — the clock does not swallow the error", async () => {
    const deadline = createDeadline(1_000);
    await expect(deadline.race(Promise.reject(new Error("no route to host")))).rejects.toThrow(
      "no route to host",
    );
    deadline.cancel();
  });

  test("work abandoned at the deadline cannot reject into the run later", async () => {
    const deadline = createDeadline(5);
    let reject!: (error: Error) => void;
    const slow = new Promise<string>((_resolve, settle) => {
      reject = settle;
    });
    expect(await deadline.race(slow)).toEqual({ done: false });

    // The fetch the run stopped waiting for finally gives up. Nothing is
    // listening any more, and an unhandled rejection here would take the whole
    // doctor process down with it.
    reject(new Error("socket hang up"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  test("expired is what gates a check that cannot be raced", async () => {
    const deadline = createDeadline(5);
    expect(deadline.expired()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(deadline.expired()).toBe(true);
  });

  test("the clock reads from an injected now, not only from its timer", () => {
    let clock = 1_000;
    const deadline = createDeadline(500, () => clock);
    expect(deadline.expired()).toBe(false);
    clock += 500;
    expect(deadline.expired()).toBe(true);
    deadline.cancel();
  });

  test("the default is the five minutes #507 §7 fixed", () => {
    expect(DOCTOR_DEADLINE_MS).toBe(5 * 60 * 1000);
  });
});

describe("noDeadline", () => {
  test("never expires and never gives up — the default for a caller with no clock", async () => {
    const deadline = noDeadline();
    expect(deadline.expired()).toBe(false);
    expect(await deadline.race(Promise.resolve(7))).toEqual({ done: true, value: 7 });
    deadline.cancel();
  });
});
