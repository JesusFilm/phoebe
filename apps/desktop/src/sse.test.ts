// The framing, on its own: a chunk boundary in the middle of a line is the bug
// this parser exists to not have, and it is invisible in any test that feeds it
// one whole stream at a time.

import { describe, expect, test } from "vite-plus/test";
import { createSseReader, type SseFrame } from "./sse.ts";

/** Feed `chunks` through a reader and collect what comes out. */
function read(...chunks: string[]): SseFrame[] {
  const frames: SseFrame[] = [];
  const feed = createSseReader((frame) => frames.push(frame));
  for (const chunk of chunks) feed(chunk);
  return frames;
}

describe("reading an event stream", () => {
  test("a name and a payload become one frame", () => {
    expect(read('event: report\ndata: {"type":"report"}\n\n')).toEqual([
      { name: "report", data: '{"type":"report"}' },
    ]);
  });

  test("a frame split across chunks is still one frame", () => {
    expect(read("event: rep", "ort\ndata: {", '"type":"report"}\n', "\n")).toEqual([
      { name: "report", data: '{"type":"report"}' },
    ]);
  });

  test("two frames in one chunk are two frames", () => {
    expect(read("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n").map((frame) => frame.name)).toEqual([
      "a",
      "b",
    ]);
  });

  test("a comment is the heartbeat, and it is not an event", () => {
    expect(read(": watching\n\n: beat\n\n")).toEqual([]);
  });

  test("carriage returns belong to the framing, not to the payload", () => {
    expect(read("event: report\r\ndata: hello\r\n\r\n")).toEqual([
      { name: "report", data: "hello" },
    ]);
  });

  test("an unfinished frame waits rather than arriving half-read", () => {
    expect(read("event: report\ndata: hello\n")).toEqual([]);
  });

  test("a payload written across two data lines is rejoined", () => {
    expect(read("event: report\ndata: one\ndata: two\n\n")).toEqual([
      { name: "report", data: "one\ntwo" },
    ]);
  });
});
