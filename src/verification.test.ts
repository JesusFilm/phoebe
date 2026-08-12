// #17: verification is Phoebe's real producer for WorkOutcomeEvent.verification
// — reading and validating the agent-written report, independent of the agent.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  diffVerification,
  readVerificationReport,
  removeVerificationReport,
  resolveVerification,
  runEngineVerification,
  type VerificationResult,
} from "./verification.ts";

const dirs: string[] = [];

function reportPath(content: string | object): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-verification-test-"));
  dirs.push(dir);
  const path = join(dir, "report.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("readVerificationReport", () => {
  test("returns undefined when the file does not exist", () => {
    expect(readVerificationReport("/nonexistent/report.json")).toBeUndefined();
  });

  test("returns undefined on invalid JSON", () => {
    expect(readVerificationReport(reportPath("not json"))).toBeUndefined();
  });

  test("returns undefined when the top level is not an array", () => {
    expect(
      readVerificationReport(reportPath({ command: "npm run ready", exitCode: 0 })),
    ).toBeUndefined();
  });

  test("returns undefined for an empty array", () => {
    expect(readVerificationReport(reportPath([]))).toBeUndefined();
  });

  test("returns undefined when an entry is missing a required field", () => {
    expect(readVerificationReport(reportPath([{ command: "npm run ready" }]))).toBeUndefined();
  });

  test("returns undefined when exitCode is not an integer", () => {
    expect(
      readVerificationReport(reportPath([{ command: "npm run ready", exitCode: 0.5 }])),
    ).toBeUndefined();
  });

  test("rejects the whole report when any single entry is malformed", () => {
    expect(
      readVerificationReport(
        reportPath([{ command: "npm run ready", exitCode: 0 }, { command: "npm test" }]),
      ),
    ).toBeUndefined();
  });

  test("maps a zero exit code to passed, with no output in the summary", () => {
    const result = readVerificationReport(
      reportPath([{ command: "npm run ready", exitCode: 0, output: "all green\n" }]),
    );
    expect(result).toEqual([
      { command: "npm run ready", status: "passed", summary: "npm run ready passed." },
    ]);
  });

  test("maps a nonzero exit code to failed, with the output tail in the summary", () => {
    const result = readVerificationReport(
      reportPath([
        { command: "npm run ready", exitCode: 1, output: "1 test failed: expected 2 got 3\n" },
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result?.[0]?.status).toBe("failed");
    expect(result?.[0]?.summary).toContain("npm run ready exited 1.");
    expect(result?.[0]?.summary).toContain("1 test failed: expected 2 got 3");
  });

  test("treats a missing output field as empty, without crashing", () => {
    const result = readVerificationReport(reportPath([{ command: "npm run ready", exitCode: 1 }]));
    expect(result).toEqual([
      { command: "npm run ready", status: "failed", summary: "npm run ready exited 1.\n" },
    ]);
  });

  test("truncates a long failure to the tail, not the head", () => {
    const head = "A".repeat(3_000);
    const tailText = "THE ACTUAL ERROR IS HERE";
    const result = readVerificationReport(
      reportPath([{ command: "npm run ready", exitCode: 1, output: `${head}${tailText}` }]),
    );
    const summary = result?.[0]?.summary ?? "";
    expect(summary).toContain(tailText);
    expect(summary.length).toBeLessThan(head.length);
    expect(summary).not.toContain(head);
  });

  test("reports multiple commands in one file", () => {
    const result = readVerificationReport(
      reportPath([
        { command: "npm run check", exitCode: 0 },
        { command: "npm test", exitCode: 1, output: "boom" },
      ]),
    );
    expect(result).toEqual([
      { command: "npm run check", status: "passed", summary: "npm run check passed." },
      { command: "npm test", status: "failed", summary: "npm test exited 1.\nboom" },
    ]);
  });

  test("caps the number of reported commands", () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({ command: `cmd-${i}`, exitCode: 0 }));
    const result = readVerificationReport(reportPath(entries));
    expect(result).toHaveLength(10);
  });
});

describe("removeVerificationReport", () => {
  test("removes an existing report file", () => {
    const path = reportPath([{ command: "npm run ready", exitCode: 0 }]);
    removeVerificationReport(path);
    expect(readVerificationReport(path)).toBeUndefined();
  });

  test("does not throw when the file does not exist", () => {
    expect(() => removeVerificationReport("/nonexistent/report.json")).not.toThrow();
  });
});

describe("runEngineVerification", () => {
  test("maps a passing command to passed, with no output in the summary", () => {
    const result = runEngineVerification(["npm run check"], "/repo", () => ({
      exitCode: 0,
      output: "all good\n",
    }));
    expect(result).toEqual([
      { command: "npm run check", status: "passed", summary: "npm run check passed." },
    ]);
  });

  test("maps a failing command to failed, with the output tail in the summary", () => {
    const result = runEngineVerification(["npm test"], "/repo", () => ({
      exitCode: 1,
      output: "1 test failed: expected 2 got 3\n",
    }));
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("failed");
    expect(result[0]?.summary).toContain("npm test exited 1.");
    expect(result[0]?.summary).toContain("1 test failed: expected 2 got 3");
  });

  test("runs every configured command, in order, against the given cwd", () => {
    const calls: Array<{ command: string; cwd: string }> = [];
    const result = runEngineVerification(["npm run check", "npm test"], "/repo", (command, cwd) => {
      calls.push({ command, cwd });
      return { exitCode: 0, output: "" };
    });
    expect(calls).toEqual([
      { command: "npm run check", cwd: "/repo" },
      { command: "npm test", cwd: "/repo" },
    ]);
    expect(result.map((r) => r.command)).toEqual(["npm run check", "npm test"]);
  });

  test("a timeout (nonzero exitCode) is a result, not a thrown error", () => {
    const result = runEngineVerification(["npm test"], "/repo", () => ({
      exitCode: 124,
      output: "killed by SIGTERM (timeout).",
    }));
    expect(result[0]?.status).toBe("failed");
  });
});

const PASSED = (command: string): VerificationResult => ({
  command,
  status: "passed",
  summary: `${command} passed.`,
});
const FAILED = (command: string): VerificationResult => ({
  command,
  status: "failed",
  summary: `${command} exited 1.`,
});

describe("diffVerification", () => {
  test("returns no disagreements when the agent report matches the engine run exactly", () => {
    const agentReported = [PASSED("npm run check"), PASSED("npm test")];
    const engineRun = [PASSED("npm run check"), PASSED("npm test")];
    expect(diffVerification(agentReported, engineRun)).toEqual([]);
  });

  test("matches by command, not position", () => {
    const agentReported = [PASSED("npm test"), PASSED("npm run check")];
    const engineRun = [PASSED("npm run check"), PASSED("npm test")];
    expect(diffVerification(agentReported, engineRun)).toEqual([]);
  });

  test("flags a status mismatch on the same command", () => {
    const agentReported = [PASSED("npm test")];
    const engineRun = [FAILED("npm test")];
    const disagreements = diffVerification(agentReported, engineRun);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]).toContain("npm test");
    expect(disagreements[0]).toContain("agent reported passed");
    expect(disagreements[0]).toContain("engine observed failed");
  });

  test("flags a command the agent never mentioned", () => {
    const disagreements = diffVerification([], [PASSED("npm test")]);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]).toContain("agent reported nothing");
  });

  test("treats an undefined agent report the same as an empty one", () => {
    const disagreements = diffVerification(undefined, [PASSED("npm test")]);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]).toContain("agent reported nothing");
  });

  test("does not flag an agent-only command the engine didn't run", () => {
    const agentReported = [PASSED("npm run lint"), PASSED("npm test")];
    const engineRun = [PASSED("npm test")];
    expect(diffVerification(agentReported, engineRun)).toEqual([]);
  });
});

describe("resolveVerification", () => {
  test("agent mode returns the agent's report as-is and never runs the engine", () => {
    const agentReported = [PASSED("npm test")];
    let engineCalled = false;
    const result = resolveVerification({
      verifyMode: "agent",
      agentReported,
      runEngine: () => {
        engineCalled = true;
        return [FAILED("npm test")];
      },
      onDisagreement: () => {
        throw new Error("should not be called in agent mode");
      },
    });
    expect(result).toBe(agentReported);
    expect(engineCalled).toBe(false);
  });

  test("engine mode returns the engine's run and ignores the agent's report entirely", () => {
    const result = resolveVerification({
      verifyMode: "engine",
      agentReported: [PASSED("npm test")],
      runEngine: () => [FAILED("npm test")],
      onDisagreement: () => {
        throw new Error("engine mode never compares — a mismatch is not even computed");
      },
    });
    expect(result).toEqual([FAILED("npm test")]);
  });

  test("both mode returns the engine's run and does not call onDisagreement when they agree", () => {
    let disagreementCalled = false;
    const result = resolveVerification({
      verifyMode: "both",
      agentReported: [PASSED("npm test")],
      runEngine: () => [PASSED("npm test")],
      onDisagreement: () => {
        disagreementCalled = true;
      },
    });
    expect(result).toEqual([PASSED("npm test")]);
    expect(disagreementCalled).toBe(false);
  });

  test("both mode returns the engine's run and calls onDisagreement when they diverge", () => {
    let reported: readonly string[] | undefined;
    const result = resolveVerification({
      verifyMode: "both",
      agentReported: [PASSED("npm test")],
      runEngine: () => [FAILED("npm test")],
      onDisagreement: (disagreements) => {
        reported = disagreements;
      },
    });
    expect(result).toEqual([FAILED("npm test")]);
    expect(reported).toHaveLength(1);
    expect(reported?.[0]).toContain("npm test");
  });
});
