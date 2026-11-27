// The spend hold (#990, decision #978): the bootstrapper tells a pipeline that a
// ceiling covering it is reached, and later that it has let go.
//
// Two parent-to-child IPC messages. `phoebe:spend:hold` carries the hold (the
// limit, the measure, the window, since when, and when it should let go), and
// `phoebe:spend:release` ends it. The bootstrapper sends the hold again to a
// child it respawns, so a pipeline that restarts under a ceiling stays held.
//
// A held pipeline takes the admission loop's "admit no unit this cycle" branch
// (src/main.ts). Units already running finish. A release ends the idle wait,
// so admission resumes on the next pass rather than a whole poll interval on.

import type { SpendHold } from "./contracts/spend.ts";
import type { ParentChannel } from "./slot-client.ts";

/** A ceiling holds this pipeline. */
export const SPEND_HOLD = "phoebe:spend:hold";
/** The hold has let go. */
export const SPEND_RELEASE = "phoebe:spend:release";

const SCOPES: ReadonlySet<string> = new Set(["tenant", "pipeline"]);
const MEASURES: ReadonlySet<string> = new Set(["usd", "tokens"]);
const WINDOWS: ReadonlySet<string> = new Set(["24h", "7d"]);

/** What one message on the channel says about the hold, or null for anything else. */
export function parseSpendHoldMessage(
  message: unknown,
): { kind: "hold"; hold: SpendHold } | { kind: "release" } | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record["type"] === SPEND_RELEASE) return { kind: "release" };
  if (record["type"] !== SPEND_HOLD) return null;
  const hold = record["hold"];
  if (typeof hold !== "object" || hold === null) return null;
  const { scope, measure, window, limit, spent, since, releaseAt } = hold as Record<
    string,
    unknown
  >;
  if (typeof scope !== "string" || !SCOPES.has(scope)) return null;
  if (typeof measure !== "string" || !MEASURES.has(measure)) return null;
  if (typeof window !== "string" || !WINDOWS.has(window)) return null;
  if (typeof limit !== "number" || typeof spent !== "number") return null;
  if (typeof since !== "string" || typeof releaseAt !== "string") return null;
  return { kind: "hold", hold: hold as SpendHold };
}

export type SpendHoldState = {
  /** The hold in force, or null when admission is free. */
  current: () => SpendHold | null;
  /** Called when a hold lets go. Returns the unsubscribe. */
  onRelease: (listener: () => void) => () => void;
};

/**
 * The hold as this process last heard it, or null with no channel: an engine
 * nobody supervises has nobody to weigh its spend.
 */
export function createSpendHoldState(
  parent: ParentChannel,
  opts: { log: (line: string) => void },
): SpendHoldState | null {
  if (typeof parent.on !== "function") return null;
  let hold: SpendHold | null = null;
  const listeners = new Set<() => void>();
  parent.on("message", (message) => {
    const parsed = parseSpendHoldMessage(message);
    if (parsed === null) return;
    // The loop says what a hold is when it first skips a pass for it, which is
    // the moment it means something; only the release is said here.
    if (parsed.kind === "hold") {
      hold = parsed.hold;
      return;
    }
    if (hold === null) return;
    hold = null;
    opts.log("Spend hold released — admitting units again.");
    for (const listener of listeners) listener();
  });
  return {
    current: () => hold,
    onRelease(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
