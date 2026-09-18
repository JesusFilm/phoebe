// The report store on the relay volume: one file per deployment, the latest
// only, and a fingerprint that is checked before it names anything.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { createReports, REPORTS_DIRNAME } from "./reports.ts";

/** A fingerprint's shape: 32 characters of base64url, as `fingerprintOf` makes them. */
const ACME = "a".repeat(32);
const WIDGET = "b".repeat(32);

const AT = new Date("2026-09-18T10:00:00.000Z");
const LATER = new Date("2026-09-18T10:00:30.000Z");

describe("the report store", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-reports-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a saved report comes back with its schema and its arrival time", () => {
    const reports = createReports(dataDir);

    reports.save(ACME, { schema: 1, report: { fleet: { cells: [] } } }, AT);

    expect(reports.find(ACME)).toEqual({
      fingerprint: ACME,
      schema: 1,
      receivedAt: AT.toISOString(),
      report: { fleet: { cells: [] } },
    });
  });

  test("the file is named after the fingerprint, under `reports/`", () => {
    const reports = createReports(dataDir);

    reports.save(ACME, { schema: 1, report: {} }, AT);

    expect(readdirSync(join(dataDir, REPORTS_DIRNAME))).toEqual([`${ACME}.json`]);
  });

  test("the next report replaces the last: there is no history here", () => {
    const reports = createReports(dataDir);

    reports.save(ACME, { schema: 1, report: { generation: 1 } }, AT);
    reports.save(ACME, { schema: 1, report: { generation: 2 } }, LATER);

    expect(readdirSync(join(dataDir, REPORTS_DIRNAME))).toHaveLength(1);
    expect(reports.find(ACME)).toMatchObject({
      receivedAt: LATER.toISOString(),
      report: { generation: 2 },
    });
  });

  test("two deployments are two files, and neither reads the other's", () => {
    const reports = createReports(dataDir);

    reports.save(ACME, { schema: 1, report: { name: "acme" } }, AT);
    reports.save(WIDGET, { schema: 1, report: { name: "widget" } }, AT);

    expect(reports.find(ACME)?.report).toEqual({ name: "acme" });
    expect(reports.find(WIDGET)?.report).toEqual({ name: "widget" });
  });

  test("a deployment that has never reported has no report", () => {
    expect(createReports(dataDir).find(ACME)).toBeNull();
  });

  test("a report outlives the process that took it — that is why it is a file", () => {
    createReports(dataDir).save(ACME, { schema: 1, report: { fleet: "as it was" } }, AT);

    // A second store over the same volume is what a restarted relay is.
    expect(createReports(dataDir).find(ACME)?.report).toEqual({ fleet: "as it was" });
  });

  test("forgetting a deployment takes its report with it", () => {
    const reports = createReports(dataDir);
    reports.save(ACME, { schema: 1, report: {} }, AT);

    reports.forget(ACME);

    expect(reports.find(ACME)).toBeNull();
    expect(readdirSync(join(dataDir, REPORTS_DIRNAME))).toEqual([]);
  });

  test("forgetting a deployment that never reported is not an error", () => {
    expect(() => createReports(dataDir).forget(ACME)).not.toThrow();
  });

  test("an unreadable file reads as no report at all, never as half of one", () => {
    const reports = createReports(dataDir);
    reports.save(ACME, { schema: 1, report: {} }, AT);
    writeFileSync(join(dataDir, REPORTS_DIRNAME, `${ACME}.json`), "{ half a repo");

    expect(reports.find(ACME)).toBeNull();
  });

  describe("the fingerprint names a file, so it is checked first", () => {
    test.each([
      ["a traversal", "../../etc/passwd"],
      ["a nested path", "acme/widget"],
      ["one character too many", "a".repeat(33)],
      ["one too few", "a".repeat(31)],
      ["a character base64url has no use for", `${"a".repeat(31)}.`],
      ["nothing at all", ""],
    ])("%s is not a fingerprint and writes nothing", (_what, candidate) => {
      const reports = createReports(dataDir);

      expect(reports.save(candidate, { schema: 1, report: {} }, AT)).toBeNull();
      expect(reports.find(candidate)).toBeNull();
      expect(readdirSync(dataDir)).toEqual([]);
    });
  });

  test("a report is written whole, through a rename, never in place", () => {
    const reports = createReports(dataDir);
    reports.save(ACME, { schema: 1, report: { cells: [1, 2, 3] } }, AT);

    const onDisk = JSON.parse(
      readFileSync(join(dataDir, REPORTS_DIRNAME, `${ACME}.json`), "utf8"),
    ) as { report: unknown };

    // No temp file left behind: the write landed by rename, and the directory
    // holds exactly the one report.
    expect(readdirSync(join(dataDir, REPORTS_DIRNAME))).toEqual([`${ACME}.json`]);
    expect(onDisk.report).toEqual({ cells: [1, 2, 3] });
  });
});
