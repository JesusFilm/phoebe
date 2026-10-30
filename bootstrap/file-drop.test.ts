// The file drop (map #690): the watcher's owner check and ack, and the asker's
// wait, timeout and cleanup — on a real temp directory, with the clock faked.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { askDrop, watchDrop } from "./file-drop.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-drop-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A watcher with no real fs.watch and no timer: the test calls `scan`. */
function watcher(
  dir: string,
  ackDir: string,
  opts: {
    requireUid?: number;
    uidOf?: (name: string) => number;
    onFile: (content: string) => string;
    log?: string[];
  },
) {
  return watchDrop({
    dir,
    ackDir,
    ...(opts.requireUid !== undefined ? { requireUid: opts.requireUid } : {}),
    onFile: ({ content }) => opts.onFile(content),
    fs: {
      stat: (path) => ({ uid: opts.uidOf?.(path) ?? 0, isFile: () => true }),
      watch: () => null,
    },
    setInterval: () => ({ clear: () => {} }),
    log: (line) => opts.log?.push(line),
  });
}

describe("the watcher", () => {
  test("handles a file once, writes the ack, and skips temp names", () => {
    const dir = tmp();
    const ack = join(dir, "ack");
    const seen: string[] = [];
    const w = watcher(dir, ack, {
      onFile: (content) => {
        seen.push(content);
        return "ok 1";
      },
    });
    writeFileSync(join(dir, ".n1.tmp"), "half");
    writeFileSync(join(dir, "n1.json"), "{}");
    w.scan();
    w.scan();
    expect(seen).toEqual(["{}"]);
    expect(existsSync(join(ack, "n1"))).toBe(true);
    w.stop();
  });

  test("a file owned by the wrong uid is ignored and named", () => {
    const dir = tmp();
    const ack = join(dir, "ack");
    const seen: string[] = [];
    const log: string[] = [];
    const w = watcher(dir, ack, {
      requireUid: 0,
      uidOf: (path) => (path.endsWith("child.json") ? 10001 : 0),
      onFile: (content) => {
        seen.push(content);
        return "ok";
      },
      log,
    });
    writeFileSync(join(dir, "child.json"), "forged");
    writeFileSync(join(dir, "root.json"), "real");
    w.scan();
    expect(seen).toEqual(["real"]);
    expect(existsSync(join(ack, "child"))).toBe(false);
    expect(log.join("\n")).toMatch(/owned by uid 10001, not 0/);
    w.stop();
  });

  test("a handler that throws becomes a refused ack", () => {
    const dir = tmp();
    const ack = join(dir, "ack");
    const w = watcher(dir, ack, {
      onFile: () => {
        throw new Error("full");
      },
    });
    writeFileSync(join(dir, "n1.json"), "{}");
    w.scan();
    expect(readdirSync(ack)).toEqual(["n1"]);
    w.stop();
  });
});

describe("the asker", () => {
  test("writes by rename, reads the ack, and cleans both up", async () => {
    const dir = tmp();
    const ack = join(dir, "ack");
    mkdirSync(ack);
    const w = watcher(dir, ack, { onFile: () => "ok 2" });
    const answer = await askDrop("n1", "{}", {
      dir,
      ackDir: ack,
      waitMs: 1_000,
      sleep: async () => w.scan(),
    });
    expect(answer).toEqual({ kind: "ok", detail: "2" });
    expect(readdirSync(dir).filter((name) => name !== "ack")).toEqual([]);
    expect(readdirSync(ack)).toEqual([]);
    w.stop();
  });

  test("a refusal comes back with its reason", async () => {
    const dir = tmp();
    const ack = join(dir, "ack");
    const w = watcher(dir, ack, {
      onFile: () => {
        throw new Error("eight pending");
      },
    });
    const answer = await askDrop("n1", "{}", {
      dir,
      ackDir: ack,
      waitMs: 1_000,
      sleep: async () => w.scan(),
    });
    expect(answer).toEqual({ kind: "refused", detail: "eight pending" });
    w.stop();
  });

  test("no ack in time is `unanswered`, and the ask is withdrawn", async () => {
    const dir = tmp();
    const ack = join(dir, "ack");
    let clock = 0;
    const answer = await askDrop("n1", "{}", {
      dir,
      ackDir: ack,
      waitMs: 5_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(answer).toEqual({ kind: "unanswered" });
    expect(readdirSync(dir)).toEqual([]);
  });
});
