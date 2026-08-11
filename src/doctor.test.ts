// `phoebe doctor` verdict folding: which check states fail the report, and how
// the crash-loop record reads as a check — especially the quarantine case, the
// "silently running last-known-good" state doctor exists to surface.

import { describe, expect, test } from "vite-plus/test";
import { buildDoctorReport, crashLoopCheck, formatDoctorReport } from "./doctor.ts";

describe("buildDoctorReport", () => {
  test("warn and unknown do not fail the report; fail does", () => {
    const ok = buildDoctorReport(
      [
        { id: "cli", state: "warn", detail: "behind" },
        { id: "supervisor", state: "unknown", detail: "not in container" },
      ],
      [],
    );
    expect(ok.ok).toBe(true);

    const failing = buildDoctorReport([{ id: "config", state: "fail", detail: "missing" }], []);
    expect(failing.ok).toBe(false);
  });

  test("a failing tenant check fails the whole report", () => {
    const report = buildDoctorReport(
      [{ id: "config", state: "ok", detail: "loads" }],
      [
        {
          path: "core",
          slug: "acme/core",
          checks: [{ id: "token", state: "fail", detail: "no GH_TOKEN" }],
        },
      ],
    );
    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toMatch(/1 failing check/);
  });
});

describe("crashLoopCheck", () => {
  test("an active quarantine warns and names both commits", () => {
    const check = crashLoopCheck(
      { lastGoodSha: "g".repeat(40), failingSha: "b".repeat(40), failureCount: 3 },
      3,
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/quarantined/);
    expect(check.detail).toContain("b".repeat(12));
    expect(check.detail).toContain("g".repeat(12));
  });

  test("crashes below the threshold warn without claiming quarantine", () => {
    const check = crashLoopCheck(
      { lastGoodSha: null, failingSha: "b".repeat(40), failureCount: 1 },
      3,
    );
    expect(check.state).toBe("warn");
    expect(check.detail).not.toMatch(/quarantined/);
  });

  test("a clean record is ok", () => {
    expect(
      crashLoopCheck({ lastGoodSha: "g".repeat(40), failingSha: null, failureCount: 0 }).state,
    ).toBe("ok");
    expect(crashLoopCheck({ lastGoodSha: null, failingSha: null, failureCount: 0 }).state).toBe(
      "ok",
    );
  });
});
