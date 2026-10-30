// The fleet hold (map #690): a stop is a file, a start removes it, the
// gate finds nothing while held, a restart under a stop comes back stopped,
// and each move nudges the loop and tells the listeners.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createFleetHold, fleetStopPath, readStop } from "./fleet-hold.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function base(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-hold-"));
  dirs.push(dir);
  return dir;
}

const T0 = Date.parse("2026-10-29T12:00:00.000Z");

describe("stop and start", () => {
  test("a stop writes the file, gates discovery to nothing, nudges and tells; a start undoes it", () => {
    const dataBase = base();
    const logged: string[] = [];
    const hold = createFleetHold({ dataBase, now: () => T0, log: (line) => logged.push(line) });
    let nudged = 0;
    hold.useNudge(() => (nudged += 1));
    const seen: unknown[] = [];
    hold.onChange((stop) => seen.push(stop));
    const discover = hold.gate(() => [{ tenant: { id: "t" } } as never]);

    expect(hold.current()).toBeNull();
    expect(discover()).toHaveLength(1);

    expect(hold.stop("device:Mike's phone")).toEqual({ outcome: "stopped" });
    expect(hold.current()).toEqual({ by: "device:Mike's phone", at: "2026-10-29T12:00:00.000Z" });
    expect(readStop(fleetStopPath(dataBase))).toEqual(hold.current());
    expect(discover()).toEqual([]);
    expect(nudged).toBe(1);
    expect(seen).toEqual([{ by: "device:Mike's phone", at: "2026-10-29T12:00:00.000Z" }]);
    expect(logged.at(-1)).toContain("stopped the fleet");

    expect(hold.stop("someone else")).toEqual({
      outcome: "unchanged",
      detail: "already stopped by device:Mike's phone at 2026-10-29T12:00:00.000Z",
    });
    expect(nudged).toBe(1);

    expect(hold.start("device:Mike's phone")).toEqual({ outcome: "started" });
    expect(hold.current()).toBeNull();
    expect(existsSync(fleetStopPath(dataBase))).toBe(false);
    expect(discover()).toHaveLength(1);
    expect(nudged).toBe(2);
    expect(seen.at(-1)).toBeNull();

    expect(hold.start("again")).toEqual({ outcome: "unchanged", detail: "the fleet is running" });
  });

  test("a container that restarts under a stop comes back stopped", () => {
    const dataBase = base();
    createFleetHold({ dataBase, now: () => T0 }).stop("mike@example.com");
    const logged: string[] = [];
    const again = createFleetHold({ dataBase, log: (line) => logged.push(line) });
    expect(again.current()).toEqual({ by: "mike@example.com", at: "2026-10-29T12:00:00.000Z" });
    expect(logged[0]).toContain("the fleet is stopped");
  });

  test("a file that will not parse is no stop", () => {
    const dataBase = base();
    const path = fleetStopPath(dataBase);
    createFleetHold({ dataBase }).stop("x");
    writeFileSync(path, "{not json");
    expect(readStop(path)).toBeNull();
    expect(createFleetHold({ dataBase }).current()).toBeNull();
    writeFileSync(path, JSON.stringify({ by: 1 }));
    expect(readStop(path)).toBeNull();
  });
});
