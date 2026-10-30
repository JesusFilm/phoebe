// `remotes.json` (map #690): the file's round trip, a malformed one, and the
// record a window sees against the one the file holds.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createRemoteStore,
  freshRemote,
  readRemotesFile,
  recordOf,
  REMOTES_FILE,
} from "./remotes.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-remotes-"));
  dirs.push(dir);
  return dir;
}

const fresh = () =>
  freshRemote({
    deploymentId: "dep_A",
    url: "https://x.ts.net",
    name: "acme",
    label: "lap",
    arm: "host",
    protocol: 1,
    scopes: ["read"],
    expiresAt: "2026-11-15T00:00:00.000Z",
    sessionId: null,
    pairedAt: "2026-10-16T00:00:00.000Z",
  });

describe("the store", () => {
  test("put, get, patch, remove, through the file", () => {
    const path = join(tmp(), REMOTES_FILE);
    const store = createRemoteStore({ path });
    expect(store.list()).toEqual([]);
    store.put(fresh());
    expect(readRemotesFile(path).remotes).toHaveLength(1);
    expect(store.patch("dep_A", { lastHeardAt: "now" })?.lastHeardAt).toBe("now");
    expect(store.patch("dep_B", {})).toBeNull();
    expect(store.get("dep_A")?.lastHeardAt).toBe("now");
    store.put({ ...fresh(), label: "replaced" });
    expect(store.list().map((record) => record.label)).toEqual(["replaced"]);
    expect(store.remove("dep_A")).toBe(true);
    expect(store.remove("dep_A")).toBe(false);
  });

  test("a malformed or foreign file is nobody paired", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, REMOTES_FILE), "{ nope");
    expect(readRemotesFile(join(dir, REMOTES_FILE)).remotes).toEqual([]);
    writeFileSync(
      join(dir, REMOTES_FILE),
      JSON.stringify({ version: 1, remotes: [{ deploymentId: "x" }, fresh()] }),
    );
    expect(readRemotesFile(join(dir, REMOTES_FILE)).remotes).toHaveLength(1);
    expect(readFileSync(join(dir, REMOTES_FILE), "utf8")).toContain("dep_A");
  });

  test("the window's record carries the reading and not the bookkeeping", () => {
    const record = recordOf(
      { ...fresh(), notified: { dark: { state: "raised", at: "", since: "" } }, seeded: true },
      { reachability: "blocked", blocked: "expired" },
    );
    expect(record).toMatchObject({
      deploymentId: "dep_A",
      reachability: "blocked",
      blocked: "expired",
    });
    expect("notified" in record).toBe(false);
    expect("seeded" in record).toBe(false);
  });
});
