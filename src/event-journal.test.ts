import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createEventJournal,
  eventJournalDir,
  replayEventJournal,
  type WorkOutcomeInput,
} from "./event-journal.ts";

const roots: string[] = [];

function makeStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "phoebe-events-v1-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function outcome(overrides: Partial<WorkOutcomeInput> = {}): WorkOutcomeInput {
  return {
    work: {
      workId: "issues:42",
      kind: "issues",
      issueNumber: 42,
    },
    provider: {
      name: "codex",
      model: "gpt-test",
      digest: "sha256:provider-model",
    },
    digests: {
      config: "sha256:config",
      policy: "sha256:policy",
      prompts: "sha256:prompts",
    },
    startedAt: "2026-07-30T12:00:00.000Z",
    endedAt: "2026-07-30T12:01:00.000Z",
    outcome: "success",
    failure: null,
    verification: [
      {
        command: "vp run ready",
        status: "passed",
        summary: "All checks passed.",
      },
    ],
    retries: 0,
    escalations: 0,
    resources: {
      durationMs: 60_000,
      agentExitCode: 0,
      summary: "1 commit",
    },
    links: {
      issue: "https://github.com/owner/repo/issues/42",
      branch: "https://github.com/owner/repo/tree/phoebe/issue-42",
    },
    ...overrides,
  };
}

describe("events-v1 journal", () => {
  test("appends monotonic events and replays idempotently by runtime and event ID", () => {
    const stateDir = makeStateDir();
    let id = 0;
    const journal = createEventJournal({
      stateDir,
      runtimeId: "runtime-1",
      randomId: () => `event-${++id}`,
    });

    const first = journal.append(outcome());
    const second = journal.append(
      outcome({
        work: { workId: "checks:9", kind: "checks", pullRequestNumber: 9 },
      }),
    );
    appendFileSync(
      join(eventJournalDir(stateDir), "events-00000000000000000001-open.jsonl"),
      `${JSON.stringify(first)}\n`,
    );

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect([first.eventId, second.eventId]).toEqual(["event-1", "event-2"]);
    expect(replayEventJournal(stateDir)).toMatchObject({
      events: [{ eventId: "event-1" }, { eventId: "event-2" }],
      earliestSequence: 1,
      latestSequence: 2,
      missingRanges: [],
      duplicatesIgnored: 1,
    });
  });

  test("round-trips resources.usage and resources.costUsd (#165)", () => {
    const stateDir = makeStateDir();
    const journal = createEventJournal({ stateDir, runtimeId: "runtime-1" });

    journal.append(
      outcome({
        resources: {
          durationMs: 60_000,
          agentExitCode: 0,
          usage: { inputTokens: 9, outputTokens: 56, cacheReadTokens: 17_748 },
          costUsd: 0.015,
          summary: "1 commit",
        },
      }),
    );

    expect(replayEventJournal(stateDir).events[0]).toMatchObject({
      resources: {
        usage: { inputTokens: 9, outputTokens: 56, cacheReadTokens: 17_748 },
        costUsd: 0.015,
      },
    });
  });

  test("rotates on event count, prunes deterministically, and reports the unavailable range", () => {
    const stateDir = makeStateDir();
    let id = 0;
    const journal = createEventJournal({
      stateDir,
      runtimeId: "runtime-1",
      maxEventsPerSegment: 2,
      maxSegments: 2,
      randomId: () => `event-${++id}`,
    });

    for (let n = 0; n < 5; n += 1) journal.append(outcome());

    expect(
      readdirSync(eventJournalDir(stateDir)).filter((name) => name.endsWith(".jsonl")),
    ).toEqual([
      "events-00000000000000000003-00000000000000000004.jsonl",
      "events-00000000000000000005-open.jsonl",
    ]);
    expect(replayEventJournal(stateDir, { afterSequence: 0 })).toMatchObject({
      earliestSequence: 3,
      latestSequence: 5,
      retainedSegments: 2,
      missingRanges: [{ fromSequence: 1, toSequence: 2 }],
    });
  });

  test("quarantines a partial corrupt tail without hiding earlier complete events", () => {
    const stateDir = makeStateDir();
    const journal = createEventJournal({
      stateDir,
      runtimeId: "runtime-1",
      randomId: () => "event-1",
    });
    journal.append(outcome());
    const segment = join(eventJournalDir(stateDir), "events-00000000000000000001-open.jsonl");
    appendFileSync(segment, '{"schemaVersion":"events-v1","sequence":2');

    const replay = replayEventJournal(stateDir);

    expect(replay.events).toHaveLength(1);
    expect(replay.quarantinedTailCount).toBe(1);
    expect(readdirSync(join(eventJournalDir(stateDir), "quarantine"))[0]).toMatch(
      /events-.*\.corrupt-/,
    );
  });

  test("quarantines a complete record that violates events-v1 semantics", () => {
    const stateDir = makeStateDir();
    const journal = createEventJournal({
      stateDir,
      runtimeId: "runtime-1",
      randomId: () => "event-1",
    });
    const first = journal.append(outcome());
    appendFileSync(
      join(eventJournalDir(stateDir), "events-00000000000000000001-open.jsonl"),
      `${JSON.stringify({
        ...first,
        eventId: "event-2",
        sequence: 2,
        outcome: "everything-is-fine",
        retries: -1,
      })}\n`,
    );

    expect(replayEventJournal(stateDir)).toMatchObject({
      events: [{ sequence: 1 }],
      quarantinedTailCount: 1,
    });
  });

  test("detects an internal missing sequence range", () => {
    const stateDir = makeStateDir();
    const dir = eventJournalDir(stateDir);
    mkdirSync(dir, { recursive: true });
    const one = {
      ...createEventJournal({
        stateDir: makeStateDir(),
        runtimeId: "runtime-1",
        randomId: () => "event-1",
      }).append(outcome()),
      sequence: 1,
      eventId: "event-1",
    };
    const three = { ...one, sequence: 3, eventId: "event-3" };
    writeFileSync(
      join(dir, "events-00000000000000000001-open.jsonl"),
      `${JSON.stringify(one)}\n${JSON.stringify(three)}\n`,
    );

    expect(replayEventJournal(stateDir).missingRanges).toEqual([
      { fromSequence: 2, toSequence: 2 },
    ]);
  });

  test("surfaces an unsupported event major as a capability error", () => {
    const stateDir = makeStateDir();
    const dir = eventJournalDir(stateDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "events-00000000000000000001-open.jsonl"),
      `${JSON.stringify({ ...outcome(), schemaVersion: "events-v2" })}\n`,
    );

    expect(() => replayEventJournal(stateDir)).toThrow(/supports events-v1 but received events-v2/);
  });
});
