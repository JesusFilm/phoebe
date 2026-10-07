import { MAX_LOG_LINES } from "phoebe-agent/contracts";
import { describe, expect, test } from "vite-plus/test";
import { appendLogLine, EMPTY_LOGS, logsEnded, logsSeeded } from "./logs.ts";

describe("the logs pane's view", () => {
  test("starts from what main held, and runs", () => {
    expect(logsSeeded(["a", "b"])).toEqual({ lines: ["a", "b"], ended: null });
  });

  test("a seed longer than the bound keeps its newest lines", () => {
    const many = Array.from({ length: MAX_LOG_LINES + 5 }, (_, i) => `line ${i}`);

    const view = logsSeeded(many);

    expect(view.lines).toHaveLength(MAX_LOG_LINES);
    expect(view.lines[0]).toBe("line 5");
  });

  test("appending past the bound drops the oldest line", () => {
    let view = EMPTY_LOGS;
    for (const line of ["one", "two", "three"]) view = appendLogLine(view, line, 2);

    expect(view.lines).toEqual(["two", "three"]);
  });

  test("an ending keeps the lines and records why", () => {
    const view = logsEnded(appendLogLine(EMPTY_LOGS, "last words"), "the container exited");

    expect(view).toEqual({ lines: ["last words"], ended: "the container exited" });
  });
});
