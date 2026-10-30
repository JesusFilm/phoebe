// Stop and start over the API (map #690): the fleet held down with the
// container up.
//
// `phoebe stop` on the host takes the container down, and with it the
// listener a paired device reaches — so a device that could do that could
// never start it again. What a device can do is the thing the bootstrapper
// itself can: drain every pipeline and keep it drained, exactly as a
// reconcile drains the fleet between engines, and bring it back on a start.
// The container stays up, the API answers, the report keeps moving; the
// agents stop working. That is what Stop means on a remote route, and the
// page says so beside the button.
//
// The hold is one file under `state/`, so a container that restarts under a
// stop comes back stopped: an operator who stopped the fleet from their phone
// should not find it running again because the host rebooted. The file is the
// stop; no file is running.
//
// The supervisor learns nothing new. Its discover is wrapped so a held fleet
// discovers no tenant at all, which the pipeline axis already reads as "every
// pipeline vanished" and drains, and a release discovers them again, which it
// reads as "every pipeline appeared" and spawns. A nudge wakes the poll so
// neither waits out the interval.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FleetStop, FleetVerbResponse } from "../src/contracts/remote-protocol.ts";
import type { FleetDiscoverInput } from "./supervise-fleet.ts";

/** Where the stop lives, under the data volume's `state/`. */
export function fleetStopPath(dataBase: string): string {
  return join(dataBase, "state", "fleet-stop.json");
}

export type FleetHold = {
  /** The stop in force, or null while the fleet runs. */
  current: () => FleetStop | null;
  stop: (by: string) => FleetVerbResponse;
  start: (by: string) => FleetVerbResponse;
  /** The hold moved. Returns the unsubscribe. */
  onChange: (listener: (stop: FleetStop | null) => void) => () => void;
  /** The supervisor's wake, handed over once; a stop or a start pulls it. */
  useNudge: (nudge: () => void) => void;
  /** A discover that finds nothing while the fleet is held. */
  gate: (discover: () => FleetDiscoverInput) => () => FleetDiscoverInput;
};

export function createFleetHold(opts: {
  dataBase: string;
  now?: () => number;
  log?: (line: string) => void;
}): FleetHold {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const path = fleetStopPath(opts.dataBase);
  const listeners = new Set<(stop: FleetStop | null) => void>();
  let nudge: (() => void) | null = null;
  let current: FleetStop | null = readStop(path);
  if (current !== null) {
    log(
      `[phoebe] boot: the fleet is stopped (by ${current.by}, since ${current.at}) — ` +
        `nothing spawns until a start.`,
    );
  }

  const moved = (): void => {
    for (const listener of listeners) listener(current);
    nudge?.();
  };

  return {
    current: () => current,
    stop(by) {
      if (current !== null) {
        return {
          outcome: "unchanged",
          detail: `already stopped by ${current.by} at ${current.at}`,
        };
      }
      const stop: FleetStop = { by, at: new Date(now()).toISOString() };
      try {
        writeStop(path, stop);
      } catch (error) {
        return { outcome: "refused", detail: `could not write ${path}: ${describe(error)}` };
      }
      current = stop;
      log(
        `[phoebe] boot: ${by} stopped the fleet — draining every pipeline; the container stays up.`,
      );
      moved();
      return { outcome: "stopped" };
    },
    start(by) {
      if (current === null) return { outcome: "unchanged", detail: "the fleet is running" };
      try {
        rmSync(path, { force: true });
      } catch (error) {
        return { outcome: "refused", detail: `could not remove ${path}: ${describe(error)}` };
      }
      current = null;
      log(`[phoebe] boot: ${by} started the fleet — spawning every pipeline.`);
      moved();
      return { outcome: "started" };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    useNudge(next) {
      nudge = next;
    },
    gate: (discover) => () => (current === null ? discover() : []),
  };
}

/** The file as it stands: a stop, or null for none or for one that will not parse. */
export function readStop(path: string): FleetStop | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { by, at } = parsed as Record<string, unknown>;
    if (typeof by !== "string" || typeof at !== "string") return null;
    return { by, at };
  } catch {
    return null;
  }
}

function writeStop(path: string, stop: FleetStop): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stop)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
