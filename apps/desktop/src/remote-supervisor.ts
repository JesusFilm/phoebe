// One supervisor per remote, in main (map #690, decided in #697): the thing
// that holds a deployment's event stream open, reads the descriptor before
// every open, and turns what it sees into the four reachability words.
//
// **Before every open, the descriptor.** It costs nothing and it is the only
// way to tell the four endings apart: a 401 means `revoked` when the stored id
// still answers and `replaced` when a different id does, and a protocol newer
// than this companion's is `protocol` before any bearer is sent. Blocked
// retries nothing and consumes no rung; the person pairs again.
//
// **The stream is the only source while connected.** Its first event is the
// latest report, so no `GET /api/report` ever runs beside it. Sixty seconds of
// silence on a stream that comments every 25 s means the socket is dead
// whatever it claims, so the read is aborted at 60 s idle and the state turns
// at the same moment.
//
// **Reconnect climbs a ladder**: 3, 4, 8, 16, 30 s, capped, with jitter. A
// network-online event, a power resume or a window focus resets it and tries
// now — not for blocked, which waits for the person. `src/backoff.ts` is not
// reused: it sleeps with `Atomics.wait` for the engine's synchronous seams and
// would stall main's event loop.
//
// The state derivation is apps/console/src/reachability.ts, pure and shared;
// this file owns the stream, the timers and nothing else. Every seam is a
// parameter, so the tests drive it with a fake fetch and a clock.

import type { BlockedReason, Reachability, StoredReport } from "phoebe-agent/contracts";
import { DESCRIPTOR_PATH, REMOTE_PROTOCOL, REMOTE_ROUTES } from "phoebe-agent/contracts";
import {
  blockedReasonOf,
  climbsLadder,
  DARK_AFTER_MS,
  ESTABLISH_TIMEOUT_MS,
  ladderDelayMs,
  reachabilityOf,
  STREAM_IDLE_MS,
  type DescriptorReading,
  type RemoteFailure,
} from "../../console/src/reachability.ts";
import { createSseReader } from "./sse.ts";

/** The reading the supervisor hands out with every change. */
export type SupervisorReading = {
  reachability: Reachability;
  blocked?: BlockedReason;
  /** The descriptor as last read, so the alert rule can say whether the id moved. */
  descriptor: DescriptorReading | null;
};

export type SupervisorDeps = {
  /** The remote's URL, `https://host[:port]`. */
  url: string;
  /** The record's id and the newest protocol this companion knows. */
  stored: { deploymentId: string; protocol?: number };
  /** The bearer, read at the moment of every open so a re-pair lands without a restart. */
  bearer: () => string | null;
  /** The last thing heard, as persisted; the supervisor dates darkness from it. */
  lastHeardAt: string | null;
  fetchFn: typeof fetch;
  /** Something arrived: the clock to persist, and the report when there was one. */
  onHeard: (at: string, report: StoredReport | null) => void;
  /** The reading moved. */
  onReading: (reading: SupervisorReading) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
};

export type RemoteSupervisor = {
  start: () => void;
  stop: () => void;
  /** Network back, machine awake, window focused: reset the ladder and try now. Not for blocked. */
  poke: () => void;
  reading: () => SupervisorReading;
};

export function createRemoteSupervisor(deps: SupervisorDeps): RemoteSupervisor {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const log = deps.log ?? (() => {});
  const stored = {
    deploymentId: deps.stored.deploymentId,
    protocol: deps.stored.protocol ?? REMOTE_PROTOCOL,
  };

  let lastHeardAt: number | null =
    deps.lastHeardAt === null
      ? null
      : Number.isFinite(Date.parse(deps.lastHeardAt))
        ? Date.parse(deps.lastHeardAt)
        : null;
  let streaming = false;
  let lastFailure: RemoteFailure | null = null;
  let descriptor: DescriptorReading | null = null;
  let attempt = 0;
  let stopped = true;
  let controller: AbortController | null = null;
  let retryTimer: unknown = null;
  let idleTimer: unknown = null;
  let darkTimer: unknown = null;
  let last: SupervisorReading | null = null;

  const derive = (): SupervisorReading => {
    const verdict = reachabilityOf({
      lastHeardAt,
      now: now(),
      streaming,
      lastFailure,
      descriptor,
      stored,
    });
    return {
      reachability: verdict.state,
      ...(verdict.blocked !== undefined ? { blocked: verdict.blocked } : {}),
      descriptor,
    };
  };

  /** Emit when the reading moved. */
  const settle = (): void => {
    const reading = derive();
    if (
      last !== null &&
      last.reachability === reading.reachability &&
      last.blocked === reading.blocked &&
      last.descriptor?.deploymentId === reading.descriptor?.deploymentId
    ) {
      return;
    }
    last = reading;
    deps.onReading(reading);
  };

  const clear = (handle: unknown): void => {
    if (handle !== null) clearTimer(handle);
  };

  /** A disconnected remote turns dark on its own at the 60 s mark. */
  const armDark = (): void => {
    clear(darkTimer);
    darkTimer = null;
    if (lastHeardAt === null) return;
    const left = lastHeardAt + DARK_AFTER_MS - now();
    if (left <= 0) return;
    darkTimer = setTimer(() => {
      darkTimer = null;
      settle();
    }, left);
  };

  const heard = (report: StoredReport | null): void => {
    lastHeardAt = now();
    lastFailure = null;
    attempt = 0;
    deps.onHeard(new Date(lastHeardAt).toISOString(), report);
    clear(darkTimer);
    darkTimer = null;
    settle();
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    clear(retryTimer);
    const delay = ladderDelayMs(attempt, random);
    attempt += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const failed = (failure: RemoteFailure): void => {
    streaming = false;
    lastFailure = failure;
    settle();
    if (!climbsLadder(failure)) return;
    armDark();
    scheduleRetry();
  };

  const readDescriptor = async (
    signal: AbortSignal,
  ): Promise<DescriptorReading | RemoteFailure> => {
    let response: Response;
    try {
      response = await deps.fetchFn(`${deps.url}${DESCRIPTOR_PATH}`, {
        signal,
        headers: { accept: "application/json" },
      });
    } catch {
      return signal.aborted ? { kind: "timeout" } : { kind: "request-failed" };
    }
    if (response.status !== 200) return { kind: "request-failed", status: response.status };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "request-failed", status: 200 };
    }
    const record = body as { deploymentId?: unknown; protocol?: unknown } | null;
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.deploymentId !== "string" ||
      typeof record.protocol !== "number"
    ) {
      return { kind: "request-failed", status: 200 };
    }
    return { deploymentId: record.deploymentId, protocol: record.protocol };
  };

  const connect = async (): Promise<void> => {
    if (stopped || controller !== null) return;
    const mine = new AbortController();
    controller = mine;
    // Fifteen seconds to establish: the descriptor, then the stream's headers.
    let establish: unknown = setTimer(() => mine.abort(), ESTABLISH_TIMEOUT_MS);

    const seen = await readDescriptor(mine.signal);
    if (mine.signal.aborted && stopped) return;
    if ("kind" in seen) {
      clear(establish);
      controller = null;
      failed(seen);
      return;
    }
    descriptor = seen;
    const blocked = blockedReasonOf(null, seen, stored);
    if (blocked !== null) {
      clear(establish);
      controller = null;
      streaming = false;
      settle();
      return;
    }

    const bearer = deps.bearer();
    let response: Response;
    try {
      response = await deps.fetchFn(`${deps.url}${REMOTE_ROUTES.events}`, {
        signal: mine.signal,
        headers: { accept: "text/event-stream", authorization: `Bearer ${bearer ?? ""}` },
      });
    } catch {
      clear(establish);
      controller = null;
      if (stopped) return;
      failed(mine.signal.aborted ? { kind: "timeout" } : { kind: "request-failed" });
      return;
    }
    clear(establish);
    establish = null;
    if (response.status === 401) {
      controller = null;
      let reason: "expired" | "unknown" = "unknown";
      try {
        const body = (await response.json()) as { reason?: unknown };
        if (body.reason === "expired") reason = "expired";
      } catch {
        // No body is an unknown bearer.
      }
      failed({ kind: "unauthenticated", reason });
      return;
    }
    if (response.status !== 200 || response.body === null) {
      controller = null;
      failed({ kind: "request-failed", status: response.status });
      return;
    }

    streaming = true;
    heard(null);
    const feed = createSseReader((frame) => {
      if (frame.name !== "report") return;
      let body: unknown;
      try {
        body = JSON.parse(frame.data);
      } catch {
        return;
      }
      const schema = (body as { schema?: unknown } | null)?.schema;
      heard({
        schema: typeof schema === "number" ? schema : 0,
        receivedAt: new Date(now()).toISOString(),
        report: body,
      });
    });

    const rearmIdle = (): void => {
      clear(idleTimer);
      idleTimer = setTimer(() => {
        idleTimer = null;
        mine.abort();
      }, STREAM_IDLE_MS);
    };
    rearmIdle();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let dropped: RemoteFailure = { kind: "stream-dropped" };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        rearmIdle();
        heard(null);
        feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      dropped = mine.signal.aborted ? { kind: "timeout" } : { kind: "stream-dropped" };
    }
    clear(idleTimer);
    idleTimer = null;
    controller = null;
    if (stopped) return;
    log(`[phoebe] remote ${deps.url}: stream ended (${dropped.kind}).`);
    failed(dropped);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      settle();
      armDark();
      void connect();
    },
    stop() {
      stopped = true;
      clear(retryTimer);
      clear(idleTimer);
      clear(darkTimer);
      retryTimer = idleTimer = darkTimer = null;
      controller?.abort();
      controller = null;
      streaming = false;
    },
    poke() {
      if (stopped) return;
      if (derive().reachability === "blocked") return;
      attempt = 0;
      clear(retryTimer);
      retryTimer = null;
      if (controller === null) void connect();
    },
    reading: derive,
  };
}
