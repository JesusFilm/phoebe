// Reachability, as the companion derives it (map #690, decided in #697): the
// pure state machine behind the four words a remote's row can say, the retry
// ladder, and the four endings a descriptor read tells apart. No I/O and no
// clock of its own — the supervisor in apps/desktop owns the stream and the
// timers and hands this the facts — so every transition is tested with a
// number for `now`.

import type { BlockedReason, Reachability } from "phoebe-agent/contracts";

/** Silence on a stream that comments every 25 s means the socket is dead. */
export const DARK_AFTER_MS = 60_000;
/** The supervisor aborts a read after this much silence; the state turns at the same moment. */
export const STREAM_IDLE_MS = 60_000;
/** How long an open may take to establish before it counts as a failure. */
export const ESTABLISH_TIMEOUT_MS = 15_000;
/** The rungs, in ms. Past the last, the last. */
export const LADDER_MS = [3_000, 4_000, 8_000, 16_000, 30_000] as const;
/** ±25 % on every rung, so a fleet of companions does not knock in step. */
export const LADDER_JITTER = 0.25;
/** From here before `expiresAt` the row says the session is about to end. */
export const EXPIRY_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;

/** What the supervisor last ran into, if anything. */
export type RemoteFailure =
  | { kind: "stream-dropped" }
  | { kind: "request-failed"; status?: number }
  | { kind: "timeout" }
  | { kind: "unauthenticated"; reason: "expired" | "unknown" };

/** The descriptor as last read, against what the record holds. */
export type DescriptorReading = { deploymentId: string; protocol: number };

export type ReachabilityInput = {
  /** The last thing heard, ms since epoch, or null before anything was. */
  lastHeardAt: number | null;
  now: number;
  /** Is the stream open right now? */
  streaming: boolean;
  lastFailure: RemoteFailure | null;
  /** The descriptor read before the last open, when one was. */
  descriptor: DescriptorReading | null;
  /** The record's own id, and the newest protocol this companion knows. */
  stored: { deploymentId: string; protocol: number };
};

export type ReachabilityVerdict = { state: Reachability; blocked?: BlockedReason };

/**
 * The four endings a 401 or a descriptor can mean, or null when neither rules
 * the pairing out. Read before every open, because it is the only way to tell
 * `revoked` from `replaced`: the same 401 means one thing when the stored id
 * still answers and another when a different id does.
 */
export function blockedReasonOf(
  failure: RemoteFailure | null,
  descriptor: DescriptorReading | null,
  stored: { deploymentId: string; protocol: number },
): BlockedReason | null {
  if (descriptor !== null) {
    if (descriptor.deploymentId !== stored.deploymentId) return "replaced";
    if (descriptor.protocol > stored.protocol) return "protocol";
  }
  if (failure?.kind === "unauthenticated") {
    return failure.reason === "expired" ? "expired" : "revoked";
  }
  return null;
}

/** The state from the facts, as #697's table reads them. */
export function reachabilityOf(input: ReachabilityInput): ReachabilityVerdict {
  const blocked = blockedReasonOf(input.lastFailure, input.descriptor, input.stored);
  if (blocked !== null) return { state: "blocked", blocked };
  const quiet =
    input.lastHeardAt === null ? Number.POSITIVE_INFINITY : input.now - input.lastHeardAt;
  if (quiet >= DARK_AFTER_MS) return { state: "dark" };
  if (input.streaming && input.lastFailure === null) return { state: "connected" };
  return { state: "disconnected" };
}

/** `quietForMs` and `quietSince` for the alert rule, from the same two clocks. */
export function quietOf(
  lastHeardAt: number | null,
  now: number,
): { quietForMs: number | null; quietSince: string | null } {
  if (lastHeardAt === null) return { quietForMs: null, quietSince: null };
  return {
    quietForMs: Math.max(0, now - lastHeardAt),
    quietSince: new Date(lastHeardAt).toISOString(),
  };
}

/**
 * The delay before attempt `attempt` (0 is the first retry): the rung, with
 * jitter. `random` is `Math.random`'s shape, in [0, 1).
 */
export function ladderDelayMs(attempt: number, random: () => number = Math.random): number {
  const rung = LADDER_MS[Math.min(Math.max(attempt, 0), LADDER_MS.length - 1)]!;
  const spread = (random() * 2 - 1) * LADDER_JITTER;
  return Math.round(rung * (1 + spread));
}

/**
 * Whether a failure climbs the ladder. A 401 blocks and retries nothing; a
 * 503 (the deployment's 16-stream cap), a 5xx, a refused connection, a drop
 * and a timeout are ordinary and climb.
 */
export function climbsLadder(failure: RemoteFailure): boolean {
  return failure.kind !== "unauthenticated";
}

/** The coarse duration a row shows: `3 min`, `2 h`, `5 d`. Never `0 min`. */
export function coarseDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** The row's line from three days before expiry: `session expires in 2 d`, or null before then. */
export function expiryNotice(expiresAt: string, now: number): string | null {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  if (left <= 0 || left > EXPIRY_NOTICE_MS) return null;
  return `session expires in ${coarseDuration(left)}`;
}

/** What a blocked row says, and the action it offers. */
export function blockedLine(reason: BlockedReason): {
  text: string;
  action: "pair again" | "update";
} {
  switch (reason) {
    case "expired":
      return { text: "session expired", action: "pair again" };
    case "revoked":
      return { text: "session revoked", action: "pair again" };
    case "replaced":
      return { text: "a different deployment answers here", action: "pair again" };
    case "protocol":
      return { text: "newer than this companion", action: "update" };
  }
}

/** The hostname of a remote's URL, which is the rail's section header. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The port a row shows beside the name when it is not the default. */
export function portOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.port === "" || parsed.port === "443" ? null : parsed.port;
  } catch {
    return null;
  }
}
