import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createEventJournal, type WorkOutcomeInput } from "./event-journal.ts";
import { dailyCostBudgetExhausted, dailyCostSpent, utcDay } from "./cost-cap.ts";

const roots: string[] = [];

function makeStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "phoebe-cost-cap-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function outcome(overrides: Partial<WorkOutcomeInput> = {}): WorkOutcomeInput {
  return {
    work: { workId: "issues:42", kind: "issues", issueNumber: 42 },
    provider: { name: "claude", model: "claude-test", digest: "sha256:provider-model" },
    digests: { config: "sha256:config", policy: "sha256:policy", prompts: "sha256:prompts" },
    startedAt: "2026-08-12T12:00:00.000Z",
    endedAt: "2026-08-12T12:01:00.000Z",
    outcome: "success",
    failure: null,
    verification: [],
    retries: 0,
    escalations: 0,
    resources: { durationMs: 60_000, summary: "1 commit" },
    links: {},
    ...overrides,
  };
}

describe("utcDay", () => {
  test("formats a UTC calendar day", () => {
    expect(utcDay(new Date("2026-08-12T23:59:59.000Z"))).toBe("2026-08-12");
  });
});

describe("dailyCostSpent", () => {
  test("is zero with no journal", () => {
    const dir = makeStateDir();
    expect(dailyCostSpent(dir, new Date("2026-08-12T12:00:00.000Z"))).toBe(0);
  });

  test("sums costUsd across events that ended the same UTC day", () => {
    const dir = makeStateDir();
    const journal = createEventJournal({ stateDir: dir, runtimeId: "runtime-1" });
    journal.append(outcome({ resources: { durationMs: 1000, costUsd: 1.5, summary: "a" } }));
    journal.append(
      outcome({
        endedAt: "2026-08-12T18:00:00.000Z",
        resources: { durationMs: 1000, costUsd: 2.25, summary: "b" },
      }),
    );
    expect(dailyCostSpent(dir, new Date("2026-08-12T23:00:00.000Z"))).toBe(3.75);
  });

  test("ignores events with no costUsd and events from other UTC days", () => {
    const dir = makeStateDir();
    const journal = createEventJournal({ stateDir: dir, runtimeId: "runtime-1" });
    journal.append(outcome({ resources: { durationMs: 1000, summary: "no cost reported" } }));
    journal.append(
      outcome({
        endedAt: "2026-08-13T00:00:01.000Z",
        resources: { durationMs: 1000, costUsd: 9, summary: "next day" },
      }),
    );
    expect(dailyCostSpent(dir, new Date("2026-08-12T23:00:00.000Z"))).toBe(0);
  });
});

describe("dailyCostBudgetExhausted", () => {
  test("a cap of 0 is always disabled, no matter what was spent", () => {
    const dir = makeStateDir();
    const journal = createEventJournal({ stateDir: dir, runtimeId: "runtime-1" });
    journal.append(outcome({ resources: { durationMs: 1000, costUsd: 1_000, summary: "big" } }));
    expect(dailyCostBudgetExhausted(dir, 0, new Date("2026-08-12T12:00:00.000Z"))).toBe(false);
  });

  test("reports exhausted once today's spend meets the cap", () => {
    const dir = makeStateDir();
    const journal = createEventJournal({ stateDir: dir, runtimeId: "runtime-1" });
    journal.append(outcome({ resources: { durationMs: 1000, costUsd: 5, summary: "a" } }));
    const now = new Date("2026-08-12T12:00:00.000Z");
    expect(dailyCostBudgetExhausted(dir, 5, now)).toBe(true);
    expect(dailyCostBudgetExhausted(dir, 5.01, now)).toBe(false);
  });
});
