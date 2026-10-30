// The host arm's URL hand-off (map #690): the file on the volume, and the
// in-container command `phoebe start` execs to write it.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  isTailnetUrl,
  readRemoteUrl,
  remoteUrlPath,
  runRemoteUrlCli,
  writeRemoteUrl,
} from "./remote-url.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-remote-url-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the file", () => {
  test("round-trips under state/, and reads null before a write", () => {
    const base = tmp();
    expect(readRemoteUrl(base)).toBeNull();
    writeRemoteUrl(base, "https://beast.tail4f2c.ts.net");
    expect(remoteUrlPath(base)).toBe(join(base, "state", "remote-url"));
    expect(readFileSync(remoteUrlPath(base), "utf8")).toBe("https://beast.tail4f2c.ts.net\n");
    expect(readRemoteUrl(base)).toBe("https://beast.tail4f2c.ts.net");
  });
});

describe("what counts as a tailnet URL", () => {
  test("https with a host and an optional port, nothing else", () => {
    expect(isTailnetUrl("https://beast.tail4f2c.ts.net")).toBe(true);
    expect(isTailnetUrl("https://beast.tail4f2c.ts.net:8443")).toBe(true);
    expect(isTailnetUrl("http://beast.tail4f2c.ts.net")).toBe(false);
    expect(isTailnetUrl("https://beast.tail4f2c.ts.net/pair")).toBe(false);
    expect(isTailnetUrl("https://user:pw@beast.tail4f2c.ts.net")).toBe(false);
    expect(isTailnetUrl("not a url")).toBe(false);
  });
});

describe("phoebe remote-url", () => {
  test("refuses on the host, refuses a bad URL, writes a good one", async () => {
    await expect(runRemoteUrlCli(["https://x.ts.net"], { inContainer: false })).rejects.toThrow(
      /inside the container/,
    );
    await expect(runRemoteUrlCli(["http://x.ts.net"], { inContainer: true })).rejects.toThrow(
      /Usage/,
    );
    await expect(runRemoteUrlCli([], { inContainer: true })).rejects.toThrow(/Usage/);
    const written: string[] = [];
    await runRemoteUrlCli(["https://x.ts.net"], {
      inContainer: true,
      env: { PHOEBE_DATA_DIR: "/data" },
      write: (base, url) => written.push(`${base} ${url}`),
    });
    expect(written).toEqual(["/data https://x.ts.net"]);
  });
});
