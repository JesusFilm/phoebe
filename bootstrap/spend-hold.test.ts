// The spend hold's sending half (#990): what each pipeline is told, and when.
// The verdicts themselves are bootstrap/deployment-state.test.ts.

import { EventEmitter } from "node:events";
import { describe, expect, test } from "vite-plus/test";
import type { SpendHold } from "../src/contracts/spend.ts";
import { SPEND_HOLD, SPEND_RELEASE } from "../src/spend-hold.ts";
import type { SupervisedPipeline } from "./pipelines.ts";
import { createSpendHoldRelay, MIN_REFRESH_MS, RELEASE_SLACK_MS } from "./spend-hold.ts";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function pipelineOf(name: string): SupervisedPipeline {
  return {
    id: `/t/a#${name}`,
    tenant: {
      id: "/t/a",
      slug: "acme/widget",
      dir: "/t/a",
      configPath: "/t/a/phoebe.config.ts",
      envPath: "/t/a/.env",
      gitIdentity: null,
    },
    pipeline: {
      name,
      disabled: false,
      priority: 0,
      concurrency: 1,
      needsClone: true,
      env: [],
      kinds: [],
      fingerprint: "fp",
    },
    enumerated: true,
    siblingEnv: [],
  };
}

class FakeChild extends EventEmitter {
  sent: unknown[] = [];
  send(message: unknown, callback?: (error: Error | null) => void): void {
    this.sent.push(message);
    callback?.(null);
  }
}

function holdUntil(releaseAt: number, overrides: Partial<SpendHold> = {}): SpendHold {
  return {
    scope: "pipeline",
    measure: "usd",
    window: "24h",
    limit: 5,
    spent: 6,
    since: new Date(NOW).toISOString(),
    releaseAt: new Date(releaseAt).toISOString(),
    ...overrides,
  };
}

function harness() {
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const logged: string[] = [];
  let refreshes = 0;
  const relay = createSpendHoldRelay({
    refresh: () => {
      refreshes += 1;
    },
    log: (line) => logged.push(line),
    now: () => NOW,
    setTimer: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  });
  return { relay, timers, logged, refreshes: () => refreshes };
}

const work = pipelineOf("work");
const triage = pipelineOf("triage");

describe("the spend hold relay", () => {
  test("tells a held pipeline once, and a release when it lets go", () => {
    const h = harness();
    const child = new FakeChild();
    h.relay.attach(work, child);
    const hold = holdUntil(NOW + HOUR);

    h.relay.update(new Map([[work.id, hold]]));
    h.relay.update(new Map([[work.id, hold]]));
    expect(child.sent).toEqual([{ type: SPEND_HOLD, hold }]);
    expect(h.logged[0]).toContain("holding acme/widget:work");

    h.relay.update(new Map());
    expect(child.sent).toEqual([{ type: SPEND_HOLD, hold }, { type: SPEND_RELEASE }]);
    expect(h.logged[1]).toContain("released");
  });

  test("leaves a pipeline no ceiling covers alone", () => {
    const h = harness();
    const held = new FakeChild();
    const free = new FakeChild();
    h.relay.attach(work, held);
    h.relay.attach(triage, free);

    h.relay.update(new Map([[work.id, holdUntil(NOW + HOUR)]]));

    expect(held.sent).toHaveLength(1);
    expect(free.sent).toEqual([]);
  });

  test("a hold that moved is sent again", () => {
    const h = harness();
    const child = new FakeChild();
    h.relay.attach(work, child);
    h.relay.update(new Map([[work.id, holdUntil(NOW + HOUR)]]));
    const later = holdUntil(NOW + 2 * HOUR, { spent: 9 });

    h.relay.update(new Map([[work.id, later]]));

    expect(child.sent[1]).toEqual({ type: SPEND_HOLD, hold: later });
  });

  test("a child respawned under a ceiling is told before it can admit anything", () => {
    const h = harness();
    const first = new FakeChild();
    h.relay.attach(work, first);
    const hold = holdUntil(NOW + HOUR);
    h.relay.update(new Map([[work.id, hold]]));
    first.emit("exit");

    const second = new FakeChild();
    h.relay.attach(work, second);

    expect(second.sent).toEqual([{ type: SPEND_HOLD, hold }]);
  });

  test("asks for a refresh just after the earliest hold is due to let go", () => {
    const h = harness();
    h.relay.update(
      new Map([
        [work.id, holdUntil(NOW + 3 * HOUR)],
        [triage.id, holdUntil(NOW + 2 * HOUR)],
      ]),
    );
    const live = h.timers.filter((timer) => !timer.cancelled);
    expect(live.map((timer) => timer.ms)).toEqual([2 * HOUR + RELEASE_SLACK_MS]);

    live[0]!.fn();
    expect(h.refreshes()).toBe(1);
  });

  test("never asks again sooner than its floor, so an early estimate cannot spin", () => {
    const h = harness();
    h.relay.update(new Map([[work.id, holdUntil(NOW - HOUR)]]));
    expect(h.timers[0]!.ms).toBe(MIN_REFRESH_MS);
  });

  test("cancels the refresh once nothing holds", () => {
    const h = harness();
    h.relay.update(new Map([[work.id, holdUntil(NOW + HOUR)]]));
    h.relay.update(new Map());
    expect(h.timers.every((timer) => timer.cancelled)).toBe(true);
  });
});
