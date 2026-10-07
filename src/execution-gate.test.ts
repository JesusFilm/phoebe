import { describe, expect, test } from "vite-plus/test";
import {
  bootIsMainProcess,
  CONTAINER_MARKER_PATH,
  executionDecision,
  isInsideContainer,
  pidOneCmdline,
} from "./execution-gate.ts";

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

describe("the bootstrapper liveness probe", () => {
  test("PID 1's cmdline reads back with its NULs as spaces", () => {
    const probed: string[] = [];
    expect(
      pidOneCmdline((path) => {
        probed.push(path);
        return "/usr/bin/tini\0--\0phoebe\0boot\0";
      }),
    ).toBe("/usr/bin/tini -- phoebe boot ");
    expect(probed).toEqual(["/proc/1/cmdline"]);
  });

  test("an unreadable /proc/1/cmdline is empty, never a throw", () => {
    expect(
      pidOneCmdline(() => {
        throw new Error("EACCES");
      }),
    ).toBe("");
  });

  test("boot is the main process only when PID 1 says so", () => {
    expect(bootIsMainProcess("/usr/bin/tini -- phoebe boot ")).toBe(true);
    expect(bootIsMainProcess("/bin/sh ")).toBe(false);
    expect(bootIsMainProcess("")).toBe(false);
  });
});
