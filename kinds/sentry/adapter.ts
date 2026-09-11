// The Sentry-protocol read adapter (#470): one implementation for Sentry and
// GlitchTip behind a small policy object for the four places they diverge —
// the stats window (`statsPeriod` vs `start`/`end`), the sort vocabulary,
// whether the search grammar can be trusted past `is:unresolved`, and nothing
// else the loop needs. Two calls do the loop: the org issues list, and the
// latest event of a group. Neither collector's field names leak past this
// file: the kind and its prompt see the internal shape below.

import { nextPageUrl, sentryApiRequest, type FetchLike } from "../../src/sentry-protocol.ts";
import { WINDOW_RE, type Collector, type SentryKindOptions } from "./options.ts";

/** One unresolved group, as the kind reads it. */
export type SentryGroup = {
  id: string;
  shortId: string | null;
  title: string;
  culprit: string;
  level: string;
  /** Events counted for the group, as the list reports it. */
  count: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  /** The list row verbatim, written to scratch for the agent. */
  raw: unknown;
};

/** One stack frame, camelCased the way both collectors serve it. */
export type SentryFrame = {
  filename: string | null;
  function: string | null;
  lineNo: number | null;
  colNo: number | null;
  inApp: boolean;
  /** `[lineNumber, sourceText]` pairs around the frame, when the SDK sent them. */
  context: ReadonlyArray<readonly [number, string]>;
};

/** The latest event of a group, as the kind reads it. */
export type SentryEvent = {
  eventId: string | null;
  /** The release the crash happened on, the unit's `revision` (#471). */
  release: string | null;
  environment: string | null;
  transaction: string | null;
  dateCreated: string | null;
  tags: ReadonlyArray<{ key: string; value: string }>;
  /** Innermost exception's frames, outermost call first. */
  frames: readonly SentryFrame[];
  /** The event verbatim, written to scratch for the agent. */
  raw: unknown;
};

/** What the kind asks of a collector. Injectable so the kind's tests need no HTTP. */
export type SentrySource = {
  listUnresolvedGroups(signal?: AbortSignal): Promise<SentryGroup[]>;
  latestEvent(groupId: string, signal?: AbortSignal): Promise<SentryEvent>;
};

/** Pages of 100 the list walk follows before stopping; the noise floor should bite first. */
const MAX_LIST_PAGES = 5;
const REQUEST_TIMEOUT_MS = 30_000;

const WINDOW_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** A window such as `24h` in milliseconds. Validated upstream; throws on a bad one. */
export function windowMs(window: string): number {
  const match = WINDOW_RE.exec(window);
  if (match === null) throw new Error(`not a window: ${JSON.stringify(window)}`);
  return Number(match[1]) * WINDOW_UNIT_MS[match[2] as string]!;
}

/**
 * The org issues list URL for one page — every gate the collector can be
 * trusted with expressed server-side, the rest applied client-side below.
 */
export function buildListUrl(options: SentryKindOptions, now: Date): string {
  const url = new URL(
    `${options.url}/api/0/organizations/${encodeURIComponent(options.org)}/issues/`,
  );
  url.searchParams.set("project", String(options.project));
  url.searchParams.set("limit", "100");
  for (const environment of options.environments) {
    url.searchParams.append("environment", environment);
  }
  const policy = collectorPolicy(options.collector);
  if (policy.statsPeriod) {
    url.searchParams.set("statsPeriod", options.window);
  } else {
    url.searchParams.set("start", new Date(now.getTime() - windowMs(options.window)).toISOString());
    url.searchParams.set("end", now.toISOString());
  }
  url.searchParams.set("sort", policy.sortByFrequency);
  const terms = ["is:unresolved"];
  if (policy.searchGrammar) {
    terms.push(`timesSeen:>=${options.minEvents}`);
    terms.push(
      options.levels.length === 1
        ? `level:${options.levels[0]}`
        : `level:[${options.levels.join(",")}]`,
    );
  }
  url.searchParams.set("query", terms.join(" "));
  return url.toString();
}

function collectorPolicy(collector: Collector): {
  statsPeriod: boolean;
  sortByFrequency: string;
  searchGrammar: boolean;
} {
  switch (collector) {
    case "sentry":
      return { statsPeriod: true, sortByFrequency: "freq", searchGrammar: true };
    case "glitchtip":
      // No `statsPeriod`, its own sort names, and a `query` whose grammar past
      // `is:unresolved` is undocumented — so the floor is applied client-side.
      return { statsPeriod: false, sortByFrequency: "-count", searchGrammar: false };
  }
}

type RawGroup = {
  id: string | number;
  shortId?: string;
  title?: string;
  culprit?: string | null;
  level?: string;
  count?: string | number;
  firstSeen?: string;
  lastSeen?: string;
  permalink?: string;
};

function readGroup(raw: RawGroup): SentryGroup {
  return {
    id: String(raw.id),
    shortId: raw.shortId ?? null,
    title: raw.title ?? "(untitled)",
    culprit: raw.culprit ?? "",
    level: raw.level ?? "error",
    count: Number(raw.count ?? 0),
    firstSeen: raw.firstSeen ?? "",
    lastSeen: raw.lastSeen ?? "",
    permalink: raw.permalink ?? "",
    raw,
  };
}

/**
 * The gates, applied client-side whatever the collector: the level set, the
 * event floor, and the window on `lastSeen`. Redundant for Sentry, which
 * already filtered server-side; the whole floor for GlitchTip.
 */
export function passesGates(group: SentryGroup, options: SentryKindOptions, now: Date): boolean {
  if (!options.levels.includes(group.level)) return false;
  if (group.count < options.minEvents) return false;
  const lastSeen = Date.parse(group.lastSeen);
  if (Number.isNaN(lastSeen)) return true;
  return now.getTime() - lastSeen <= windowMs(options.window);
}

type RawFrame = {
  filename?: string | null;
  function?: string | null;
  lineNo?: number | null;
  colNo?: number | null;
  inApp?: boolean;
  context?: unknown;
};

type RawEvent = {
  eventID?: string;
  id?: string;
  release?: { version?: string } | string | null;
  culprit?: string | null;
  dateCreated?: string;
  tags?: Array<{ key: string; value: string }>;
  entries?: Array<{
    type: string;
    data?: { values?: Array<{ stacktrace?: { frames?: RawFrame[] } | null }> };
  }>;
};

function readFrames(raw: RawEvent): SentryFrame[] {
  const exception = raw.entries?.find((entry) => entry.type === "exception");
  const values = exception?.data?.values ?? [];
  // The last value is the innermost (the one that was thrown); its frames are
  // the ones a triage reads. Sentry lists frames outermost-first.
  const frames = values[values.length - 1]?.stacktrace?.frames ?? [];
  return frames.map((frame) => ({
    filename: frame.filename ?? null,
    function: frame.function ?? null,
    lineNo: frame.lineNo ?? null,
    colNo: frame.colNo ?? null,
    inApp: frame.inApp ?? false,
    context: Array.isArray(frame.context)
      ? (frame.context as unknown[])
          .filter(
            (pair): pair is [number, string] =>
              Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "string",
          )
          .map((pair) => [pair[0], pair[1]] as const)
      : [],
  }));
}

export function readEvent(raw: RawEvent): SentryEvent {
  const tags = raw.tags ?? [];
  const tag = (key: string): string | null => tags.find((t) => t.key === key)?.value ?? null;
  const release =
    typeof raw.release === "string" ? raw.release : (raw.release?.version ?? tag("release"));
  return {
    eventId: raw.eventID ?? raw.id ?? null,
    release: release && release.length > 0 ? release : null,
    environment: tag("environment"),
    transaction: tag("transaction") ?? raw.culprit ?? null,
    dateCreated: raw.dateCreated ?? null,
    tags,
    frames: readFrames(raw),
    raw,
  };
}

/** The live adapter: `fetch` straight to the collector, bearer token, no proxy knob. */
export function createSentrySource(deps: {
  options: SentryKindOptions;
  token: string;
  fetchFn?: FetchLike;
  now?: () => Date;
}): SentrySource {
  const fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const { options, token } = deps;

  return {
    async listUnresolvedGroups(signal) {
      const at = now();
      const groups: SentryGroup[] = [];
      let url: string | null = buildListUrl(options, at);
      for (let page = 0; url !== null && page < MAX_LIST_PAGES; page += 1) {
        const { body, headers } = await sentryApiRequest<RawGroup[]>({
          fetchFn,
          url,
          token,
          timeoutMs: REQUEST_TIMEOUT_MS,
          ...(signal !== undefined ? { signal } : {}),
        });
        for (const raw of body) {
          const group = readGroup(raw);
          if (passesGates(group, options, at)) groups.push(group);
        }
        url = nextPageUrl(headers.get("Link"));
      }
      return groups;
    },

    async latestEvent(groupId, signal) {
      const url =
        `${options.url}/api/0/organizations/${encodeURIComponent(options.org)}/issues/` +
        `${encodeURIComponent(groupId)}/events/latest/`;
      const { body } = await sentryApiRequest<RawEvent>({
        fetchFn,
        url,
        token,
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...(signal !== undefined ? { signal } : {}),
      });
      return readEvent(body);
    },
  };
}
