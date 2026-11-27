// Manual observer runs (#937, spec #924, decisions #920 and #916): an operator
// asks for one, and the observer's pipeline runs it on its next pass rather
// than when `every` says.
//
// Two doors, one handler. `phoebe observe` asks through a file drop under
// `state/`, the way `phoebe sessions revoke` does (file-drop.ts), and returns on
// the ack. `POST /api/observe` calls the same handler from the listener. Either
// way the bootstrapper settles on a tenant and forwards the ask to that
// tenant's observer pipeline as a parent-to-child IPC message
// (src/manual-run.ts), which ends the child's idle wait.
//
// Nothing is queued. The handler refuses, with the reason, when the fleet is
// stopped, when no tenant (or not the named one) declares the observer, when a
// spend ceiling holds that pipeline (#990), when a run is already in flight there, or when that pipeline's child is not up to
// hear the ask. Which pipeline runs the observer is the enumeration's `kinds`;
// whether a run is in flight is the pipeline's last snapshot in the report.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentReport, FleetCell } from "../src/contracts/deployment.ts";
import type { FleetStop, ObserveResponse } from "../src/contracts/remote-protocol.ts";
import { isPeriod, MANUAL_RUN, type ManualRun } from "../src/manual-run.ts";
import { describeSpendHold } from "../src/spend.ts";
import type { BrokerChild } from "./broker-ipc.ts";
import { watchDrop, type DropWatcher } from "./file-drop.ts";
import type { SupervisedPipeline } from "./pipelines.ts";

/** The catalog kind a manual run asks for. */
export const OBSERVER_KIND = "observer";

/** Where `phoebe observe` asks, and where the answer lands. */
export function observeDropDir(dataBase: string): string {
  return join(dataBase, "state", "observe");
}
export function observeAckDir(dataBase: string): string {
  return join(dataBase, "state", "observe-ack");
}

/** One ask, from either door. `by` is `shell` for the drop, the session's name over the API. */
export type ObserveAsk = { tenant: string | null; lookback: string | null; by: string };

export type ObserveDispatcher = {
  /** A pipeline's child spawned: remember it if it runs the observer. Call once per spawn. */
  attach: (pipeline: SupervisedPipeline, child: BrokerChild) => void;
  /** Start a run, or say why not. Never throws, never queues. */
  request: (ask: ObserveAsk) => ObserveResponse;
};

type Entry = { pipeline: SupervisedPipeline; child: BrokerChild | null };

function refused(detail: string, extra: Partial<ObserveResponse> = {}): ObserveResponse {
  return { outcome: "refused", detail, ...extra };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createObserveDispatcher(deps: {
  /** The fleet hold, if any (fleet-hold.ts). */
  stopped: () => FleetStop | null;
  /** The report as last built, for the live cells and their snapshots. */
  report: () => DeploymentReport | null;
  now?: () => number;
  log?: (line: string) => void;
}): ObserveDispatcher {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const entries = new Map<string, Entry>();

  /** How a cell's tenant is named: its slug, else the repo its engine reports, else its dir. */
  const nameOf = (entry: Entry, cell: FleetCell | undefined): string =>
    entry.pipeline.tenant.slug ?? cell?.snapshot?.tenant ?? entry.pipeline.tenant.dir;

  return {
    attach(pipeline, child) {
      if (!pipeline.pipeline.kinds.includes(OBSERVER_KIND)) return;
      const entry: Entry = { pipeline, child };
      entries.set(pipeline.id, entry);
      // Kept with no child after an exit, so a pipeline mid-respawn is "not
      // running" rather than "not declared". A pipeline that is gone for good
      // drops out of the report's cells, and `request` reads only those.
      child.on("exit", () => {
        if (entries.get(pipeline.id) === entry) entry.child = null;
      });
    },

    request(ask) {
      if (ask.lookback !== null && !isPeriod(ask.lookback)) {
        return refused(
          `\`lookback\` must be a period like "14d" or "36h" — got ${JSON.stringify(ask.lookback)}.`,
        );
      }
      const stop = deps.stopped();
      if (stop !== null) {
        return refused(
          `the fleet is stopped (by ${stop.by} at ${stop.at}), so nothing would run it. ` +
            "Start the fleet first.",
        );
      }

      const report = deps.report();
      const cells = new Map((report?.fleet.cells ?? []).map((cell) => [cell.id, cell]));
      // One observer pipeline per tenant: the kind refuses to share a pipeline,
      // and the first a tenant declares is the one its registration names.
      const byTenant = new Map<string, { entry: Entry; cell: FleetCell | undefined }>();
      for (const entry of entries.values()) {
        const cell = cells.get(entry.pipeline.id);
        if (report !== null && cell === undefined) continue;
        const name = nameOf(entry, cell);
        if (!byTenant.has(name)) byTenant.set(name, { entry, cell });
      }
      const declaring = [...byTenant.keys()].sort();

      if (declaring.length === 0) {
        return refused("no tenant on this deployment declares the observer kind.");
      }
      let tenant: string;
      if (ask.tenant === null) {
        if (declaring.length > 1) {
          return refused(
            `${declaring.length} tenants declare the observer (${declaring.join(", ")}). ` +
              "Name one with --tenant.",
          );
        }
        tenant = declaring[0]!;
      } else {
        if (!byTenant.has(ask.tenant)) {
          return refused(
            `${ask.tenant} does not declare the observer kind. ` +
              `${declaring.length === 1 ? "The tenant that does is" : "The tenants that do are"} ` +
              `${declaring.join(", ")}.`,
          );
        }
        tenant = ask.tenant;
      }

      const { entry, cell } = byTenant.get(tenant)!;
      // A held observer counts toward its limits like any other pipeline, so a
      // manual run is refused under the same ceiling its schedule is (#990).
      const hold = cell?.spend?.hold ?? null;
      if (hold !== null) {
        return refused(
          `the observer pipeline for ${tenant} (${entry.pipeline.pipeline.name}) is held: ` +
            `${describeSpendHold(hold, entry.pipeline.pipeline.name)}.`,
          { tenant },
        );
      }
      const running = cell?.snapshot?.currentUnits.find((unit) => unit.unit.kind === OBSERVER_KIND);
      if (running !== undefined) {
        return refused(
          `an observer run is already in flight for ${tenant}, started at ${running.startedAt}.`,
          { tenant, runningSince: running.startedAt },
        );
      }
      const child = entry.child;
      if (child === null || child.send === undefined) {
        return refused(
          `the observer pipeline for ${tenant} (${entry.pipeline.pipeline.name}) is not running ` +
            "right now. Try again once it is back up.",
          { tenant },
        );
      }

      const run: ManualRun = {
        kind: OBSERVER_KIND,
        by: ask.by,
        at: new Date(now()).toISOString(),
        lookback: ask.lookback,
      };
      try {
        child.send({ type: MANUAL_RUN, run }, (error) => {
          if (error) {
            log(
              `[phoebe] boot: the observer run for ${tenant} did not reach its pipeline — ` +
                `${describe(error)}.`,
            );
          }
        });
      } catch (error) {
        return refused(
          `the observer pipeline for ${tenant} could not be reached: ${describe(error)}.`,
          { tenant },
        );
      }
      const over = ask.lookback === null ? "its configured lookback" : `the last ${ask.lookback}`;
      log(`[phoebe] boot: observer run for ${tenant} asked for by ${ask.by}, over ${over}.`);
      return {
        outcome: "started",
        tenant,
        detail: `observer run started for ${tenant} (pipeline ${entry.pipeline.pipeline.name}), over ${over}.`,
      };
    },
  };
}

/** `{ tenant?, lookback? }` as `phoebe observe` writes it, or null. */
export function parseObserveFile(raw: string): Omit<ObserveAsk, "by"> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseObserveBody(parsed);
}

/** The body of either door: an object whose `tenant` and `lookback` are strings or absent. */
export function parseObserveBody(body: unknown): Omit<ObserveAsk, "by"> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const field = (key: string): string | null | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return null;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const tenant = field("tenant");
  const lookback = field("lookback");
  if (tenant === undefined || lookback === undefined) return null;
  return { tenant, lookback };
}

/**
 * Watch the observe drop. The ask directory is made here, since the asker is
 * uid 10001 like the bootstrapper and the ask has to have somewhere to land;
 * the watcher makes the ack directory when it first answers.
 */
export function watchObserveDrop(opts: {
  dataBase: string;
  dispatcher: ObserveDispatcher;
  log?: (line: string) => void;
  watch?: typeof watchDrop;
  mkdir?: (dir: string) => void;
}): DropWatcher {
  const dir = observeDropDir(opts.dataBase);
  const ackDir = observeAckDir(opts.dataBase);
  try {
    (opts.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true })))(dir);
  } catch (error) {
    // Never a reason not to boot: `phoebe observe` then finds no answer and says so.
    opts.log?.(
      `[phoebe] boot: could not make ${dir} — ${describe(error)}. phoebe observe will go unanswered.`,
    );
  }
  return (opts.watch ?? watchDrop)({
    dir,
    ackDir,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    onFile: ({ content }) => {
      const ask = parseObserveFile(content);
      if (ask === null) throw new Error("the drop file is not an observe request");
      const answer = opts.dispatcher.request({ ...ask, by: "shell" });
      if (answer.outcome === "refused") throw new Error(answer.detail);
      return `ok ${answer.detail}`;
    },
  });
}
