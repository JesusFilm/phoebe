// The output tap (map #690): the ring, the line cutting across chunk and
// character boundaries, a child's lines written whole to the real descriptor,
// and the process's own writes kept without being written twice.

import { PassThrough } from "node:stream";
import { describe, expect, test } from "vite-plus/test";
import { createOutputTap } from "./output-tap.ts";

function fakeStreams() {
  const out = new PassThrough();
  const err = new PassThrough();
  const written = { stdout: "", stderr: "" };
  out.on("data", (chunk: Buffer) => (written.stdout += chunk.toString("utf8")));
  err.on("data", (chunk: Buffer) => (written.stderr += chunk.toString("utf8")));
  return {
    streams: {
      stdout: out as unknown as NodeJS.WriteStream,
      stderr: err as unknown as NodeJS.WriteStream,
    },
    written,
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

describe("a child's source", () => {
  test("cuts chunks into lines, keeps them, and writes each whole line on to the real stream", async () => {
    const { streams, written, settle } = fakeStreams();
    const tap = createOutputTap({ streams, max: 10 });
    const seen: string[] = [];
    tap.onLine((line) => seen.push(line));
    const child = tap.source();
    child.write("stdout", "[acme:a/b:work] one\n[acme:a/b:wo");
    child.write("stdout", "rk] two\r\n");
    child.write("stderr", "boom");
    expect(tap.lines()).toEqual(["[acme:a/b:work] one", "[acme:a/b:work] two"]);
    child.end();
    await settle();
    expect(tap.lines()).toEqual(["[acme:a/b:work] one", "[acme:a/b:work] two", "boom"]);
    expect(seen).toEqual(tap.lines());
    expect(written.stdout).toBe("[acme:a/b:work] one\n[acme:a/b:work] two\n");
    expect(written.stderr).toBe("boom\n");
  });

  test("a multi-byte character split across chunks is one character", () => {
    const { streams } = fakeStreams();
    const tap = createOutputTap({ streams });
    const child = tap.source();
    const bytes = Buffer.from("héllo\n", "utf8");
    child.write("stdout", bytes.subarray(0, 2));
    child.write("stdout", bytes.subarray(2));
    expect(tap.lines()).toEqual(["héllo"]);
  });

  test("two children's partial lines never tear each other", () => {
    const { streams, written } = fakeStreams();
    const tap = createOutputTap({ streams });
    const a = tap.source();
    const b = tap.source();
    a.write("stdout", "a says: hel");
    b.write("stdout", "b says: whole\n");
    a.write("stdout", "lo\n");
    expect(tap.lines()).toEqual(["b says: whole", "a says: hello"]);
    expect(written.stdout).toBe("b says: whole\na says: hello\n");
  });

  test("the ring drops the oldest past the bound", () => {
    const { streams } = fakeStreams();
    const tap = createOutputTap({ streams, max: 3 });
    const child = tap.source();
    child.write("stdout", "1\n2\n3\n4\n5\n");
    expect(tap.lines()).toEqual(["3", "4", "5"]);
  });

  test("a partial line past the cap is taken as a line rather than held", () => {
    const { streams } = fakeStreams();
    const tap = createOutputTap({ streams, maxPartialBytes: 8 });
    const child = tap.source();
    child.write("stdout", "0123456789");
    expect(tap.lines()).toEqual(["0123456789"]);
  });
});

describe("the process's own writes", () => {
  test("are kept once installed and still reach the stream once", async () => {
    const { streams, written, settle } = fakeStreams();
    const tap = createOutputTap({ streams });
    const undo = tap.install();
    streams.stdout.write("[phoebe] boot: hello\n");
    streams.stderr.write("[phoebe] boot: warn");
    streams.stderr.write(" more\n");
    expect(tap.lines()).toEqual(["[phoebe] boot: hello", "[phoebe] boot: warn more"]);
    // A child's lines go through the real write, not the wrapper: once in the ring.
    tap.source().write("stdout", "[acme:a/b:work] child\n");
    expect(tap.lines()).toEqual([
      "[phoebe] boot: hello",
      "[phoebe] boot: warn more",
      "[acme:a/b:work] child",
    ]);
    undo();
    streams.stdout.write("after\n");
    await settle();
    expect(tap.lines()).toHaveLength(3);
    expect(written.stdout).toBe("[phoebe] boot: hello\n[acme:a/b:work] child\nafter\n");
    expect(written.stderr).toBe("[phoebe] boot: warn more\n");
  });
});
