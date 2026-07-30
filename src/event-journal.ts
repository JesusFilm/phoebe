import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  ContractCapabilityError,
  EVENTS_SCHEMA_VERSION,
  parseWorkOutcomeEvent,
  type WorkOutcomeEvent,
} from "./status-contract.ts";

export const DEFAULT_EVENTS_PER_SEGMENT = 100;
export const DEFAULT_RETAINED_SEGMENTS = 20;
const SEGMENT_NAME = /^events-(\d{20})-(\d{20}|open)\.jsonl$/;

export type WorkOutcomeInput = Omit<
  WorkOutcomeEvent,
  "schemaVersion" | "runtimeId" | "eventId" | "sequence"
>;

export type MissingSequenceRange = {
  fromSequence: number;
  toSequence: number;
};

export type EventReplay = {
  events: WorkOutcomeEvent[];
  earliestSequence: number | null;
  latestSequence: number | null;
  missingRanges: MissingSequenceRange[];
  retainedSegments: number;
  quarantinedTailCount: number;
  duplicatesIgnored: number;
};

type Segment = {
  path: string;
  name: string;
  start: number;
  open: boolean;
};

type ScanResult = {
  segments: Segment[];
  eventsBySegment: Map<string, WorkOutcomeEvent[]>;
  quarantinedTailCount: number;
};

export function eventJournalDir(stateDir: string): string {
  return join(stateDir, EVENTS_SCHEMA_VERSION);
}

function sequenceText(sequence: number): string {
  return String(sequence).padStart(20, "0");
}

function segmentPath(dir: string, start: number, end: number | "open"): string {
  return join(
    dir,
    `events-${sequenceText(start)}-${end === "open" ? end : sequenceText(end)}.jsonl`,
  );
}

function listSegments(dir: string): Segment[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name): Segment[] => {
      const match = SEGMENT_NAME.exec(name);
      if (!match) return [];
      return [
        {
          path: join(dir, name),
          name,
          start: Number(match[1]),
          open: match[2] === "open",
        },
      ];
    })
    .sort((left, right) => left.start - right.start || left.name.localeCompare(right.name));
}

function quarantineCount(dir: string): number {
  const quarantineDir = join(dir, "quarantine");
  if (!existsSync(quarantineDir)) return 0;
  return readdirSync(quarantineDir).filter((name) => name.includes(".corrupt-")).length;
}

function quarantineTail(path: string, bytes: Buffer, offset: number, dir: string): void {
  const tail = bytes.subarray(offset);
  if (tail.length === 0) return;
  const quarantineDir = join(dir, "quarantine");
  mkdirSync(quarantineDir, { recursive: true });
  const digest = createHash("sha256").update(tail).digest("hex").slice(0, 12);
  const target = join(quarantineDir, `${basename(path)}.corrupt-${digest}`);
  if (!existsSync(target)) writeFileSync(target, tail);
  truncateSync(path, offset);
}

function readSegment(segment: Segment, dir: string): WorkOutcomeEvent[] {
  const bytes = readFileSync(segment.path);
  const events: WorkOutcomeEvent[] = [];
  let lineStart = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const line = bytes.subarray(lineStart, index).toString("utf8");
    if (line.length > 0) {
      try {
        events.push(parseWorkOutcomeEvent(JSON.parse(line)));
      } catch (error) {
        if (error instanceof ContractCapabilityError) throw error;
        quarantineTail(segment.path, bytes, lineStart, dir);
        return events;
      }
    }
    lineStart = index + 1;
  }
  if (lineStart < bytes.length) {
    quarantineTail(segment.path, bytes, lineStart, dir);
  }
  return events;
}

function scanJournal(dir: string): ScanResult {
  const segments = listSegments(dir);
  const eventsBySegment = new Map<string, WorkOutcomeEvent[]>();
  for (const segment of segments) {
    eventsBySegment.set(segment.path, readSegment(segment, dir));
  }
  return {
    segments,
    eventsBySegment,
    quarantinedTailCount: quarantineCount(dir),
  };
}

function closeExtraOpenSegments(scan: ScanResult, dir: string): void {
  const openSegments = scan.segments.filter((segment) => segment.open);
  for (const segment of openSegments.slice(0, -1)) {
    const events = scan.eventsBySegment.get(segment.path) ?? [];
    const end = events.at(-1)?.sequence;
    if (end !== undefined) renameSync(segment.path, segmentPath(dir, segment.start, end));
  }
}

function pruneSegments(dir: string, maxSegments: number): void {
  let segments = listSegments(dir);
  while (segments.length > maxSegments) {
    const removable = segments.find((segment) => !segment.open);
    if (!removable) return;
    unlinkSync(removable.path);
    segments = listSegments(dir);
  }
}

export function createEventJournal(options: {
  stateDir: string;
  runtimeId: string;
  maxEventsPerSegment?: number;
  maxSegments?: number;
  randomId?: () => string;
}): { append: (input: WorkOutcomeInput) => WorkOutcomeEvent } {
  const dir = eventJournalDir(options.stateDir);
  const maxEventsPerSegment = options.maxEventsPerSegment ?? DEFAULT_EVENTS_PER_SEGMENT;
  const maxSegments = options.maxSegments ?? DEFAULT_RETAINED_SEGMENTS;
  const randomId = options.randomId ?? randomUUID;

  return {
    append(input): WorkOutcomeEvent {
      mkdirSync(dir, { recursive: true });
      let scan = scanJournal(dir);
      closeExtraOpenSegments(scan, dir);
      scan = scanJournal(dir);
      const allEvents = [...scan.eventsBySegment.values()].flat();
      const latestSequence = allEvents.reduce(
        (latest, event) => Math.max(latest, event.sequence),
        0,
      );
      const sequence = latestSequence + 1;
      let active = scan.segments.findLast((segment) => segment.open);
      if (active) {
        const activeEvents = scan.eventsBySegment.get(active.path) ?? [];
        if (activeEvents.length >= maxEventsPerSegment) {
          const end = activeEvents.at(-1)?.sequence;
          if (end !== undefined) {
            renameSync(active.path, segmentPath(dir, active.start, end));
          }
          active = undefined;
        }
      }
      const path = active?.path ?? segmentPath(dir, sequence, "open");
      const event: WorkOutcomeEvent = {
        schemaVersion: EVENTS_SCHEMA_VERSION,
        runtimeId: options.runtimeId,
        eventId: randomId(),
        sequence,
        ...input,
      };
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
      pruneSegments(dir, Math.max(1, maxSegments));
      return event;
    },
  };
}

function findMissingRanges(
  events: readonly WorkOutcomeEvent[],
  afterSequence: number | undefined,
): MissingSequenceRange[] {
  const missing: MissingSequenceRange[] = [];
  let expected =
    (afterSequence ?? events[0]?.sequence ?? 1) + (afterSequence === undefined ? 0 : 1);
  for (const event of events) {
    if (event.sequence < expected) continue;
    if (event.sequence > expected) {
      missing.push({ fromSequence: expected, toSequence: event.sequence - 1 });
    }
    expected = event.sequence + 1;
  }
  return missing;
}

export function replayEventJournal(
  stateDir: string,
  options: { afterSequence?: number } = {},
): EventReplay {
  const dir = eventJournalDir(stateDir);
  const scan = scanJournal(dir);
  const seen = new Set<string>();
  let duplicatesIgnored = 0;
  const unique = [...scan.eventsBySegment.values()]
    .flat()
    .sort((left, right) => left.sequence - right.sequence)
    .filter((event) => {
      const key = `${event.runtimeId}\0${event.eventId}`;
      if (seen.has(key)) {
        duplicatesIgnored += 1;
        return false;
      }
      seen.add(key);
      return true;
    });
  const available = unique.filter(
    (event) => options.afterSequence === undefined || event.sequence > options.afterSequence,
  );
  return {
    events: available,
    earliestSequence: unique[0]?.sequence ?? null,
    latestSequence: unique.at(-1)?.sequence ?? null,
    missingRanges: findMissingRanges(available, options.afterSequence),
    retainedSegments: scan.segments.length,
    quarantinedTailCount: scan.quarantinedTailCount,
    duplicatesIgnored,
  };
}
