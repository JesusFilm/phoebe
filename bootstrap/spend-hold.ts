// The spend hold's sending half (#990, decision #978). The deployment report
// weighs the limits (bootstrap/deployment-state.ts) and hands over the holds it
// found on every publish; this diffs them against what each pipeline was last
// told and sends `phoebe:spend:hold` or `phoebe:spend:release` over the child's
// IPC channel (src/spend-hold.ts) when that moves.
//
// Three things move a hold, and each arrives here as an ordinary publish: a new
// unit record pushing a window over a ceiling, a config edit raising or removing
// one, and the window sliding. The hourly history tick slides it eventually.
// So that a hold lets go close to when the report says it will, this also asks
// for a history refresh at the earliest `releaseAt` it holds.
//
// A child spawned while its pipeline is held is told at once, so a respawn
// under a ceiling stays held.

import type { SpendHold } from "../src/contracts/spend.ts";
import { describeSpendHold } from "../src/spend.ts";
import { SPEND_HOLD, SPEND_RELEASE } from "../src/spend-hold.ts";
import type { BrokerChild } from "./broker-ipc.ts";
import { pipelineLabel, type SupervisedPipeline } from "./pipelines.ts";

/** How long past `releaseAt` the refresh waits, so the unit has aged out when it runs. */
export const RELEASE_SLACK_MS = 1_000;

/**
 * The shortest wait between two refreshes this asks for. A hold whose estimate
 * turned out early is weighed again after this long rather than in a tight loop.
 */
export const MIN_REFRESH_MS = 60_000;

export type SpendHoldRelay = {
  /** A pipeline's child spawned: tell it about any hold in force. Call once per spawn. */
  attach: (pipeline: SupervisedPipeline, child: BrokerChild) => void;
  /** The holds as of this publish, keyed by pipeline id. */
  update: (holds: ReadonlyMap<string, SpendHold>) => void;
  /** Cancel the pending refresh. */
  stop: () => void;
};

type Timer = { cancel: () => void };

export function createSpendHoldRelay(deps: {
  /** Re-sum the history now, so a window that slid is weighed again. */
  refresh: () => void;
  log?: (line: string) => void;
  now?: () => number;
  setTimer?: (ms: number, fn: () => void) => Timer;
}): SpendHoldRelay {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((ms: number, fn: () => void): Timer => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return { cancel: () => clearTimeout(handle) };
    });

  const children = new Map<string, { pipeline: SupervisedPipeline; child: BrokerChild }>();
  /** What each pipeline was last told, keyed the same way: present means held. */
  let told = new Map<string, SpendHold>();
  let timer: { at: number; handle: Timer } | null = null;

  const send = (id: string, message: unknown): void => {
    const entry = children.get(id);
    if (entry === undefined || entry.child.send === undefined) return;
    try {
      // Always with a callback: a child that exited with the message in flight
      // must fail here, not as an unhandled channel error in the supervisor.
      entry.child.send(message, () => {});
    } catch {
      // The child is going away; its respawn is told on attach.
    }
  };

  const schedule = (): void => {
    let earliest: number | null = null;
    for (const hold of told.values()) {
      const at = Date.parse(hold.releaseAt);
      if (Number.isFinite(at) && (earliest === null || at < earliest)) earliest = at;
    }
    if (timer !== null && timer.at === earliest) return;
    timer?.handle.cancel();
    timer = null;
    if (earliest === null) return;
    const at = earliest;
    timer = {
      at,
      handle: setTimer(Math.max(MIN_REFRESH_MS, at - now() + RELEASE_SLACK_MS), () => {
        timer = null;
        deps.refresh();
      }),
    };
  };

  return {
    attach(pipeline, child) {
      const entry = { pipeline, child };
      children.set(pipeline.id, entry);
      child.on("exit", () => {
        if (children.get(pipeline.id) === entry) children.delete(pipeline.id);
      });
      const hold = told.get(pipeline.id);
      if (hold !== undefined) send(pipeline.id, { type: SPEND_HOLD, hold });
    },

    update(holds) {
      const next = new Map(holds);
      for (const [id, hold] of next) {
        const before = told.get(id);
        if (before !== undefined && JSON.stringify(before) === JSON.stringify(hold)) continue;
        send(id, { type: SPEND_HOLD, hold });
        if (before === undefined) {
          const entry = children.get(id);
          const name = entry?.pipeline.pipeline.name ?? id;
          const label = entry === undefined ? id : pipelineLabel(entry.pipeline);
          log(`[phoebe] boot: holding ${label} — ${describeSpendHold(hold, name)}.`);
        }
      }
      for (const id of told.keys()) {
        if (next.has(id)) continue;
        send(id, { type: SPEND_RELEASE });
        const entry = children.get(id);
        log(
          `[phoebe] boot: spend hold on ${entry === undefined ? id : pipelineLabel(entry.pipeline)} ` +
            "released.",
        );
      }
      told = next;
      schedule();
    },

    stop() {
      timer?.handle.cancel();
      timer = null;
    },
  };
}
