// #17: verification is Phoebe's real producer for WorkOutcomeEvent.verification
// — reading and validating the agent-written report, independent of the agent.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { readVerificationReport, removeVerificationReport } from "./verification.ts";

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
