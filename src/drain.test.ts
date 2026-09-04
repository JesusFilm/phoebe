// The drain latch that turns a SIGTERM into a graceful "finish the current work
// unit, then stop" for the persistent engine loop. Exercised through an injected
// EventEmitter so the latch and its interruptible wait are tested without
// sending real process signals.

import { EventEmitter } from "node:events";
import { describe, expect, test } from "vite-plus/test";
import { installDrainSignal } from "./drain.ts";

describe("installDrainSignal", () => {
  test("starts un-requested", () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    expect(drain.requested).toBe(false);
    drain.dispose();
  });

  test("flips `requested` on the signal", () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    emitter.emit("SIGTERM");
    expect(drain.requested).toBe(true);
    drain.dispose();
  });

  test("is a one-way latch — repeated signals keep it requested", () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    emitter.emit("SIGTERM");
    emitter.emit("SIGTERM");
    expect(drain.requested).toBe(true);
    drain.dispose();
  });

  test("listens on every configured signal", () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM", "SIGINT"]);
    emitter.emit("SIGINT");
    expect(drain.requested).toBe(true);
    drain.dispose();
  });

  test("wait short-circuits when a drain is already requested", async () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    emitter.emit("SIGTERM");
    // A huge timeout would hang the test if wait() did not short-circuit.
    await drain.wait(60_000);
    drain.dispose();
  });

  test("wait wakes early when a drain arrives mid-wait", async () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    const waited = drain.wait(60_000);
    emitter.emit("SIGTERM");
    await waited; // resolves without sleeping out the 60s
    expect(drain.requested).toBe(true);
    drain.dispose();
  });

  test("wait resolves on timeout when no drain arrives", async () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    await drain.wait(1);
    expect(drain.requested).toBe(false);
    drain.dispose();
  });

  // The engine loop races a poll sleep against its in-flight units settling
  // (#422), so it abandons waits it no longer cares about. An abandoned wait
  // timing out must not take the live one's wake-up with it.
  test("an abandoned wait timing out still leaves a later wait wakeable", async () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    const abandoned = drain.wait(1);
    const live = drain.wait(60_000);
    await abandoned;

    emitter.emit("SIGTERM");
    await live; // resolves without sleeping out the 60s
    expect(drain.requested).toBe(true);
    drain.dispose();
  });

  test("a drain wakes every outstanding wait", async () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    const waits = [drain.wait(60_000), drain.wait(60_000), drain.wait(60_000)];
    emitter.emit("SIGTERM");
    await Promise.all(waits);
    drain.dispose();
  });

  test("dispose removes the listener so later signals are ignored", () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    drain.dispose();
    emitter.emit("SIGTERM");
    expect(drain.requested).toBe(false);
  });

  test("dispose is idempotent", () => {
    const emitter = new EventEmitter();
    const drain = installDrainSignal(emitter, ["SIGTERM"]);
    drain.dispose();
    expect(() => drain.dispose()).not.toThrow();
  });
});
