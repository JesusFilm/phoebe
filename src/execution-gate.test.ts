import { describe, expect, test } from "vite-plus/test";
import { CONTAINER_MARKER_PATH, executionDecision, isInsideContainer } from "./execution-gate.ts";

describe("executionDecision", () => {
  test("executes only inside the container", () => {
    expect(executionDecision({ dryRun: false, inContainer: true })).toBe("execute");
  });

  test("refuses outside the container", () => {
    expect(executionDecision({ dryRun: false, inContainer: false })).toBe("refuse");
  });

  test("dry-run never executes, even inside the container", () => {
    expect(executionDecision({ dryRun: true, inContainer: false })).toBe("dry-run");
    expect(executionDecision({ dryRun: true, inContainer: true })).toBe("dry-run");
  });
});

describe("isInsideContainer", () => {
  test("probes the container marker path", () => {
    const probed: string[] = [];
    expect(
      isInsideContainer((path) => {
        probed.push(path);
        return true;
      }),
    ).toBe(true);
    expect(probed).toEqual([CONTAINER_MARKER_PATH]);
    expect(isInsideContainer(() => false)).toBe(false);
  });
});
