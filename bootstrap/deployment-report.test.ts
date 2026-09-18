// The deployment report's file half (#532): where it lives, when it is
// rewritten, and what each section's stamp means.
//
// The interesting behaviour is all in `stampReport`, which is the rule "rewritten
// on change" made precise: a pass clock that advances on its own is not a
// change, and a section that did not move keeps the stamp it had.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { DEPLOYMENT_SCHEMA, type DeploymentReport } from "../src/contracts/deployment.ts";
import {
  DEPLOYMENT_FILE,
  deploymentReportPath,
  stampReport,
  writeDeploymentReport,
  type DeploymentDraft,
} from "./deployment-report.ts";

function draft(overrides: Partial<DeploymentDraft> = {}): DeploymentDraft {
  return {
    identity: { name: "acme/widget", arm: "solo" },
    bootstrapper: {
      engineRef: "main",
      engineSha: "abc",
      quarantinedSha: null,
      crashLoop: { lastGoodSha: null, failingSha: null, failureCount: 0 },
      reconcile: { phase: "idle", since: "2026-01-01T00:00:00.000Z" },
      children: [
        {
          id: "t#work",
          state: "running",
          since: "2026-01-01T00:00:00.000Z",
          restarts: 0,
          crashLooping: false,
          lastExit: null,
          lastPassAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      slots: { capacity: 1, inUse: 0, waiting: 0, overGranted: 0, floorBudget: 1 },
    },
    relay: { configured: false, state: "unpaired", nextRetryAt: null, lastClose: null },
    fleet: { tenants: [], cells: [] },
    config: {
      version: 1,
      root: { path: "/deployment/phoebe.config.ts", fingerprint: "sha256:root" },
      tenants: [],
      omitted: 0,
    },
    ...overrides,
  };
}

describe("deploymentReportPath", () => {
  test("the report sits in the deployment-level state dir on the data volume", () => {
    expect(deploymentReportPath("/data/repos")).toBe(join("/data/repos", "state", DEPLOYMENT_FILE));
  });
});

describe("stampReport", () => {
  test("the relay section keeps its own stamp, like every other section", () => {
    const first = stampReport(draft(), null, "2026-05-05T00:00:00.000Z")!;
    const connected = stampReport(
      draft({
        relay: {
          configured: true,
          state: "connected",
          nextRetryAt: null,
          lastClose: null,
        },
      }),
      first,
      "2026-05-05T00:10:00.000Z",
    )!;
    expect(connected.relay.updatedAt).toBe("2026-05-05T00:10:00.000Z");
    expect(connected.bootstrapper.updatedAt).toBe("2026-05-05T00:00:00.000Z");
  });

  test("the first report is always written, and carries the schema", () => {
    const report = stampReport(draft(), null, "2026-05-05T00:00:00.000Z");
    expect(report).not.toBeNull();
    expect(report!.schema).toBe(DEPLOYMENT_SCHEMA);
    expect(report!.updatedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(report!.bootstrapper.updatedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(report!.fleet.updatedAt).toBe("2026-05-05T00:00:00.000Z");
  });

  test("an unchanged deployment is not rewritten", () => {
    const first = stampReport(draft(), null, "2026-05-05T00:00:00.000Z")!;
    expect(stampReport(draft(), first, "2026-05-05T00:10:00.000Z")).toBeNull();
  });

  test("a pass clock advancing on its own is not a change", () => {
    const first = stampReport(draft(), null, "2026-05-05T00:00:00.000Z")!;
    const moved = draft();
    moved.bootstrapper.children[0]!.lastPassAt = "2026-05-05T00:09:00.000Z";
    expect(stampReport(moved, first, "2026-05-05T00:10:00.000Z")).toBeNull();
  });

  test("but the newest pass clock rides along on the next report that is written", () => {
    const first = stampReport(draft(), null, "2026-05-05T00:00:00.000Z")!;
    const moved = draft();
    moved.bootstrapper.children[0]!.lastPassAt = "2026-05-05T00:09:00.000Z";
    moved.bootstrapper.slots.inUse = 1;
    const next = stampReport(moved, first, "2026-05-05T00:10:00.000Z")!;
    expect(next.bootstrapper.children[0]!.lastPassAt).toBe("2026-05-05T00:09:00.000Z");
  });

  test("a snapshot's own timestamp moving is the engine writing its file — that is news", () => {
    const withSnapshot = (updatedAt: string): DeploymentDraft =>
      draft({
        fleet: {
          tenants: [],
          cells: [
            {
              id: "t#work",
              tenant: {
                id: "/etc/phoebe",
                slug: "acme/widget",
                path: "/etc/phoebe",
                held: false,
                reason: null,
                configValid: true,
                envPresent: true,
                retainedData: true,
                arm: "pat",
              },
              pipeline: "work",
              source: "enumerated",
              disabled: false,
              concurrency: 1,
              state: "idle",
              wedged: { wedged: false },
              snapshot: {
                tenant: "acme/widget",
                pipeline: "work",
                currentUnits: [],
                waitingForSlot: true,
                lastError: null,
                lastTimeoutAt: null,
                updatedAt,
              },
            },
          ],
        },
      });
    const first = stampReport(
      withSnapshot("2026-05-05T00:00:00.000Z"),
      null,
      "2026-05-05T00:00:00.000Z",
    )!;
    const next = stampReport(
      withSnapshot("2026-05-05T00:05:00.000Z"),
      first,
      "2026-05-05T00:05:00.000Z",
    );
    expect(next).not.toBeNull();
    expect(next!.fleet.updatedAt).toBe("2026-05-05T00:05:00.000Z");
  });

  test("a section that did not move keeps its own stamp", () => {
    const first = stampReport(draft(), null, "2026-05-05T00:00:00.000Z")!;
    const moved = draft({
      fleet: {
        tenants: [],
        cells: [
          {
            id: "t#work",
            tenant: {
              id: "/etc/phoebe",
              slug: "acme/widget",
              path: "/etc/phoebe",
              held: false,
              reason: null,
              configValid: true,
              envPresent: true,
              retainedData: true,
              arm: "pat",
            },
            pipeline: "work",
            source: "enumerated",
            disabled: false,
            concurrency: 1,
            state: "idle",
            wedged: { wedged: false },
            snapshot: null,
          },
        ],
      },
    });
    const next = stampReport(moved, first, "2026-05-05T00:10:00.000Z")!;
    expect(next.fleet.updatedAt).toBe("2026-05-05T00:10:00.000Z");
    expect(next.bootstrapper.updatedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(next.updatedAt).toBe("2026-05-05T00:10:00.000Z");
  });
});

describe("writeDeploymentReport", () => {
  test("writes the report where a reader can parse it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
    const path = deploymentReportPath(dir);
    const report = stampReport(draft(), null, "2026-05-05T00:00:00.000Z")!;
    writeDeploymentReport(path, report);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DeploymentReport;
    expect(parsed).toEqual(report);
  });

  test("replacing an existing report leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
    const path = deploymentReportPath(dir);
    writeDeploymentReport(path, stampReport(draft(), null, "2026-05-05T00:00:00.000Z")!);
    const second = draft();
    second.bootstrapper.slots.inUse = 1;
    writeDeploymentReport(path, stampReport(second, null, "2026-05-05T00:01:00.000Z")!);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DeploymentReport;
    expect(parsed.bootstrapper.slots.inUse).toBe(1);
  });
});
