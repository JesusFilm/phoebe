// `phoebe status` (#533): the text view in its fixed priority order, the facts
// it states instead of inventing a state, `--check`'s one list of findings, and
// the host arm's thin exec — all against a report built in memory and an
// injected command runner, so no container and no Docker in the test loop.

import { describe, expect, test } from "vite-plus/test";
import type {
  ChildLiveness,
  ConfigReport,
  DeploymentReport,
  FleetCell,
  TenantFacts,
} from "./contracts/deployment.ts";
import type { RemoteReport } from "./contracts/remote-protocol.ts";
import type { DoctorSection } from "./contracts/doctor.ts";
import type { HistorySummary, HistoryWindow } from "./contracts/unit-record.ts";
import { emptyHistoryWindow } from "./unit-history.ts";
import type { CommandResult, CommandRunner } from "./deployment-compose.ts";
import { COMPOSE_REL_PATH } from "./deployment-compose.ts";
import {
  deploymentBlockMessage,
  formatBootstrapperLine,
  formatDoctorLine,
  formatHistoryLine,
  formatHistoryWindow,
  formatProcessLine,
  formatRemoteLine,
  formatStateLine,
  formatStatusReport,
  LIST_DEPRECATION_NOTICE,
  NO_REPORT_MESSAGE,
  parseStatusArgs,
  readReportFile,
  runStatusCli,
  statusExecArgv,
  statusFindings,
} from "./status.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const MINUTES_AGO = (n: number): string => new Date(NOW - n * 60_000).toISOString();

function tenant(fields: Partial<TenantFacts> = {}): TenantFacts {
  return {
    id: "/etc/phoebe/children/widget",
    slug: "acme/widget",
    path: "children/widget",
    held: false,
    reason: null,
    configValid: true,
    envPresent: true,
    retainedData: true,
    arm: "pat",
    ...fields,
  };
}

function cell(fields: Partial<FleetCell> & { pipeline: string }): FleetCell {
  const owner = fields.tenant ?? tenant();
  return {
    id: `${owner.id}#${fields.pipeline}`,
    tenant: owner,
    source: "enumerated",
    disabled: false,
    concurrency: 2,
    state: "idle",
    wedged: { wedged: false },
    snapshot: null,
    ...fields,
  };
}

function child(fields: Partial<ChildLiveness> & { id: string }): ChildLiveness {
  return {
    state: "running",
    since: MINUTES_AGO(180),
    restarts: 0,
    crashLooping: false,
    lastExit: null,
    lastPassAt: MINUTES_AGO(1),
    ...fields,
  };
}

function report(fields: {
  config?: ConfigReport;
  cells?: FleetCell[];
  tenants?: TenantFacts[];
  children?: ChildLiveness[];
  remote?: RemoteReport;
  doctor?: DoctorSection;
  bootstrapper?: Partial<DeploymentReport["bootstrapper"]>;
  history?: HistorySummary;
}): DeploymentReport {
  const cells = fields.cells ?? [];
  return {
    schema: 1,
    identity: { name: "acme", arm: "workspace" },
    bootstrapper: {
      engineRef: "main",
      engineSha: "a1b2c3d4e5f6",
      quarantinedSha: null,
      crashLoop: { lastGoodSha: null, failingSha: null, failureCount: 0 },
      reconcile: { phase: "idle", since: MINUTES_AGO(600) },
      children: fields.children ?? [],
      slots: { capacity: 4, inUse: 1, waiting: 0, overGranted: 0, floorBudget: 2 },
      updatedAt: MINUTES_AGO(2),
      ...fields.bootstrapper,
    },
    fleet: {
      tenants: fields.tenants ?? (cells.length > 0 ? [cells[0]!.tenant] : []),
      cells,
      ...(fields.history !== undefined ? { history: fields.history } : {}),
      updatedAt: MINUTES_AGO(2),
    },
    config: fields.config ?? {
      version: 1,
      root: { path: "/deployment/phoebe.config.ts", fingerprint: "sha256:root" },
      tenants: [],
      omitted: 0,
      updatedAt: MINUTES_AGO(2),
    },
    remote: fields.remote ?? {
      configured: false,
      arm: null,
      url: null,
      sessions: { active: 0, expired: 0 },
      tampered: false,
      updatedAt: MINUTES_AGO(2),
    },
    doctor: fields.doctor ?? { report: null, at: null, trigger: null, updatedAt: MINUTES_AGO(2) },
    updatedAt: MINUTES_AGO(2),
  };
}

function doctorSection(fields: Partial<DoctorSection> = {}): DoctorSection {
  return {
    report: {
      checks: [
        { id: "supervisor", state: "ok", detail: "phoebe boot is the container's main process" },
        { id: "engine-pin", state: "warn", detail: "3 releases behind" },
      ],
      tenants: [{ path: "children/widget", slug: "acme/widget", checks: [] }],
      ok: true,
    },
    at: MINUTES_AGO(240),
    trigger: "schedule",
    updatedAt: MINUTES_AGO(240),
    ...fields,
  };
}

function historyWindow(fields: Partial<HistoryWindow> = {}): HistoryWindow {
  return { ...emptyHistoryWindow(), ...fields };
}

function history(last24h: Partial<HistoryWindow> = {}): HistorySummary {
  return {
    asOf: MINUTES_AGO(5),
    last24h: historyWindow(last24h),
    last7d: historyWindow({ units: 140 }),
  };
}

/** Thirty-one units in a day, four of them not completed, on both kinds of cost. */
const BUSY_DAY: Partial<HistoryWindow> = {
  units: 31,
  outcomes: { completed: 27, unproductive: 0, failed: 3, "timed-out": 1, abandoned: 0 },
  costUsd: { api: 8.2, subscriptionEstimate: 4.1 },
};

function view(overrides: Partial<Parameters<typeof formatStatusReport>[0]> = {}) {
  return formatStatusReport({
    report: report({}),
    now: NOW,
    bootAlive: true,
    section: "all",
    verbose: false,
    ...overrides,
  });
}

describe("parseStatusArgs", () => {
  test("the four flags, and an unknown one named against the verb typed", () => {
    expect(parseStatusArgs([])).toEqual({
      help: false,
      json: false,
      verbose: false,
      check: false,
    });
    expect(parseStatusArgs(["--json", "--check", "--verbose"])).toEqual({
      help: false,
      json: true,
      verbose: true,
      check: true,
    });
    expect(() => parseStatusArgs(["--jsonn"])).toThrow(/`phoebe status`/);
    expect(() => parseStatusArgs(["--jsonn"], "list")).toThrow(/`phoebe list`/);
  });
});

describe("readReportFile", () => {
  test("keeps the bytes beside the parsed report", () => {
    const raw = `${JSON.stringify(report({}), null, 2)}\n`;
    const file = readReportFile("/data/repos/state/deployment.json", () => raw);
    expect(file?.raw).toBe(raw);
    expect(file?.report.identity.name).toBe("acme");
  });

  test("an unreadable file is no report, a corrupt one is a fault", () => {
    expect(
      readReportFile("/nope", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    expect(() => readReportFile("/bad", () => "{ not json")).toThrow();
  });
});

describe("the bootstrapper line", () => {
  test("engine ref → running sha, the slot cap, and the report's age", () => {
    const line = formatBootstrapperLine(report({}), { now: NOW, withReportAge: true });
    expect(line).toBe("[phoebe] bootstrapper  engine main → a1b2c3d  slots 1/4  report 2m ago");
  });

  test("a quarantined launch says which commit it is running away from", () => {
    const line = formatBootstrapperLine(
      report({ bootstrapper: { quarantinedSha: "dddeeefff000" } }),
      { now: NOW, withReportAge: false },
    );
    expect(line).toContain("quarantined (avoiding dddeeef)");
  });

  test("a crash-loop that has not yet quarantined shows the count instead", () => {
    const line = formatBootstrapperLine(
      report({
        bootstrapper: {
          crashLoop: { lastGoodSha: null, failingSha: "9876543210", failureCount: 2 },
        },
      }),
      { now: NOW, withReportAge: false },
    );
    expect(line).toContain("crash-loop (9876543 ×2)");
  });

  test("a relaunch in progress names its axis", () => {
    const line = formatBootstrapperLine(
      report({
        bootstrapper: { reconcile: { phase: "reconciling", reason: "ref", since: MINUTES_AGO(1) } },
      }),
      { now: NOW, withReportAge: false },
    );
    expect(line).toContain("reconciling (ref)");
  });
});

describe("the remote line", () => {
  test("no section and an unconfigured one both print nothing", () => {
    expect(formatRemoteLine(undefined, NOW)).toBeNull();
    expect(
      formatRemoteLine(
        {
          configured: false,
          arm: null,
          url: null,
          sessions: { active: 0, expired: 0 },
          tampered: false,
          updatedAt: MINUTES_AGO(5),
        },
        NOW,
      ),
    ).toBeNull();
  });

  test("a configured remote is one line of facts", () => {
    const line = formatRemoteLine(
      {
        configured: true,
        arm: "sidecar",
        url: "https://phoebe.tail1234.ts.net",
        sessions: { active: 2, expired: 1 },
        tampered: false,
        updatedAt: MINUTES_AGO(3),
      },
      NOW,
    );
    expect(line).toContain("sidecar arm");
    expect(line).toContain("https://phoebe.tail1234.ts.net");
    expect(line).toContain("2 devices paired (1 expired)");
    expect(line).toContain("updated 3m ago");
    expect(line).not.toContain("tampered");
  });

  test("a host arm with no URL yet says so, and a tampered file is named", () => {
    const line = formatRemoteLine(
      {
        configured: true,
        arm: "host",
        url: null,
        sessions: { active: 1, expired: 0 },
        tampered: true,
        updatedAt: MINUTES_AGO(3),
      },
      NOW,
    )!;
    expect(line).toContain("no tailnet URL yet");
    expect(line).toContain("1 device paired");
    expect(line).toContain("tampered");
  });
});

describe("the two lines per pipeline", () => {
  test("the process line is the bootstrapper's: state, age, restarts, crash-loop", () => {
    expect(formatProcessLine(child({ id: "a" }), NOW)).toBe("running 3h");
    expect(
      formatProcessLine(child({ id: "a", state: "draining", since: MINUTES_AGO(1) }), NOW),
    ).toBe("draining 1m");
    expect(
      formatProcessLine(
        child({
          id: "a",
          state: "exited",
          since: MINUTES_AGO(2),
          restarts: 3,
          crashLooping: true,
          lastExit: { code: 1, signal: null, at: MINUTES_AGO(2) },
        }),
        NOW,
      ),
    ).toBe("exited (code 1) 2m ago, 3 restarts, crash-looping");
    expect(
      formatProcessLine(
        child({
          id: "a",
          state: "exited",
          since: MINUTES_AGO(2),
          lastExit: { code: null, signal: "SIGTERM", at: MINUTES_AGO(2) },
        }),
        NOW,
      ),
    ).toBe("exited on SIGTERM 2m ago");
  });

  test("a cell no child answers for is not supervised, not idle", () => {
    expect(formatProcessLine(undefined, NOW)).toBe("not supervised");
  });

  test("the state line renders the report's own derivation, k/N and refs included", () => {
    expect(
      formatStateLine(
        cell({
          pipeline: "work",
          state: "working",
          snapshot: {
            tenant: "acme/widget",
            pipeline: "work",
            currentUnits: [
              {
                unit: { kind: "issues", id: "12" },
                startedAt: MINUTES_AGO(5),
                runBudgetMs: null,
                provider: null,
                model: null,
                effort: null,
              },
            ],
            waitingForSlot: false,
            lastError: null,
            lastTimeoutAt: null,
            updatedAt: MINUTES_AGO(5),
          },
        }),
      ),
    ).toBe("working 1/2 issues 12");
    expect(formatStateLine(cell({ pipeline: "work", state: "waiting for slot" }))).toBe(
      "waiting for slot",
    );
  });

  test("a wedged verdict names its clause; the pass clock appears only as that silence", () => {
    expect(
      formatStateLine(cell({ pipeline: "work", wedged: { wedged: true, reason: "unit-overdue" } })),
    ).toContain("wedged? unit past its budget");
    const noPass = formatStateLine(
      cell({
        pipeline: "work",
        wedged: { wedged: true, reason: "no-pass", noPassForMs: 17 * 60_000 },
      }),
    );
    expect(noPass).toContain("wedged? no pass for 17m");
  });
});

describe("the text view", () => {
  test("priority order: bootstrapper, remote, fleet, doctor", () => {
    const text = view({
      report: report({
        cells: [cell({ pipeline: "work" })],
        children: [child({ id: "/etc/phoebe/children/widget#work" })],
        remote: {
          configured: true,
          arm: "sidecar",
          url: "https://phoebe.tail1234.ts.net",
          sessions: { active: 0, expired: 0 },
          tampered: false,
          updatedAt: MINUTES_AGO(120),
        },
        doctor: doctorSection(),
      }),
    });
    const order = text
      .split("\n")
      .filter((line) => line.startsWith("[phoebe] "))
      .map((line) => line.split(/\s{2,}/)[0]);
    expect(order).toEqual([
      "[phoebe] bootstrapper",
      "[phoebe] remote",
      "[phoebe] fleet",
      "[phoebe] doctor",
    ]);
  });

  test("a tenant's row, then two lines per pipeline beneath it", () => {
    const text = view({
      report: report({
        cells: [
          cell({ pipeline: "work", state: "idle" }),
          cell({ pipeline: "intake", source: "stale" }),
        ],
        children: [child({ id: "/etc/phoebe/children/widget#work" })],
      }),
    });
    expect(text).toContain("  children/widget  (acme/widget)");
    expect(text).toContain("✓ config  ✓ env  ✓ data  arm: pat");
    expect(text).toContain("        work    running 3h");
    expect(text).toContain("        intake  not supervised  (stale)");
    // The state line sits directly under its process line, in the same column.
    const lines = text.split("\n");
    const process = lines.findIndex((line) => line.includes("running 3h"));
    expect(lines[process + 1]).toBe("                idle");
  });

  test("a held tenant shows its reason where its columns would be", () => {
    const text = view({
      report: report({
        tenants: [
          tenant({ held: true, reason: "missing repoSlug in phoebe.config.ts", slug: null }),
        ],
        cells: [],
      }),
    });
    expect(text).toContain("held — missing repoSlug in phoebe.config.ts");
  });

  test("doctor is one line: counts and age, a run in flight, or never run", () => {
    expect(formatDoctorLine(undefined, NOW)).toContain("never run");
    expect(formatDoctorLine(doctorSection(), NOW)).toContain("0 fail, 1 warn — 4h ago (schedule)");
    expect(
      formatDoctorLine(
        doctorSection({ running: { since: MINUTES_AGO(2), trigger: "request" } }),
        NOW,
      ),
    ).toContain("running 2m (request)");
    expect(
      formatDoctorLine(
        doctorSection({ lastAttempt: { at: MINUTES_AGO(60), outcome: "timed-out" } }),
        NOW,
      ),
    ).toContain("last attempt timed-out 1h ago");
  });

  test("--verbose inlines doctor's table under its line", () => {
    const text = view({
      report: report({ doctor: doctorSection() }),
      verbose: true,
      doctorTable: (doctor) => `doctor table for ${doctor.checks.length} checks`,
    });
    expect(text).toContain("  doctor table for 2 checks");
  });

  test("a bootstrapper that is not running is a header, not a state", () => {
    const text = view({ bootAlive: false });
    expect(text.split("\n")[0]).toBe("[phoebe] bootstrapper not running; last report 2m ago");
    // The age belongs to the header; the line below does not repeat it.
    expect(text.split("\n")[1]).not.toContain("report 2m ago");
    expect(text).not.toContain("dark");
  });

  test("the alias carries that header too — it is not the quieter read", () => {
    const text = view({ bootAlive: false, section: "fleet" });
    expect(text.split("\n")[0]).toBe("[phoebe] bootstrapper not running; last report 2m ago");
    expect(text).toContain("[phoebe] fleet");
  });

  test("`list` prints the fleet section and nothing else", () => {
    const text = view({
      report: report({ cells: [cell({ pipeline: "work" })], doctor: doctorSection() }),
      section: "fleet",
    });
    expect(text).toContain("[phoebe] fleet");
    expect(text).not.toContain("[phoebe] bootstrapper");
    expect(text).not.toContain("[phoebe] doctor");
  });
});

describe("the history line (#929)", () => {
  test("the day's units, the ones that did not complete, and spend apart from the estimate", () => {
    expect(formatHistoryLine(history(BUSY_DAY))).toBe(
      "[phoebe] history       24h  31 units, 3 failed, 1 timed out  $8.20 api + $4.10 est.",
    );
  });

  test("a cost only one basis reported is shown alone, never as a total", () => {
    expect(
      formatHistoryWindow(
        historyWindow({ units: 2, costUsd: { api: 0, subscriptionEstimate: 1 } }),
      ),
    ).toBe("2 units  $1.00 est.");
    expect(
      formatHistoryWindow(
        historyWindow({
          units: 1,
          outcomes: { completed: 0, unproductive: 0, failed: 0, "timed-out": 0, abandoned: 1 },
          costUsd: { api: 0.42, subscriptionEstimate: 0 },
        }),
      ),
    ).toBe("1 unit, 1 abandoned  $0.42 api");
  });

  test("an unproductive unit is counted with the ones that did not complete (#985)", () => {
    expect(
      formatHistoryWindow(
        historyWindow({
          units: 3,
          outcomes: { completed: 1, unproductive: 2, failed: 0, "timed-out": 0, abandoned: 0 },
          unitsWithoutCost: 3,
        }),
      ),
    ).toBe("3 units, 2 unproductive  tokens only");
  });

  test("units that reported no cost say tokens only, rather than costing nothing", () => {
    expect(formatHistoryWindow(historyWindow({ units: 3, unitsWithoutCost: 3 }))).toBe(
      "3 units  tokens only",
    );
    expect(formatHistoryWindow(historyWindow())).toBe("0 units");
  });

  test("sits under the fleet section, before doctor", () => {
    const text = view({
      report: report({ cells: [cell({ pipeline: "work" })], history: history(BUSY_DAY) }),
    });
    const order = text
      .split("\n")
      .filter((line) => line.startsWith("[phoebe] "))
      .map((line) => line.split(/\s{2,}/)[0]);
    expect(order).toEqual([
      "[phoebe] bootstrapper",
      "[phoebe] fleet",
      "[phoebe] history",
      "[phoebe] doctor",
    ]);
  });

  test("a report from before the summary prints no history line, not zeros", () => {
    expect(formatHistoryLine(undefined)).toBeNull();
    expect(view({ report: report({ cells: [cell({ pipeline: "work" })] }) })).not.toContain(
      "history",
    );
  });

  test("--verbose adds a history line under each pipeline that has one", () => {
    const report_ = report({
      cells: [
        cell({ pipeline: "work", history: history({ units: 2, unitsWithoutCost: 2 }) }),
        cell({ pipeline: "old", source: "stale" }),
      ],
      history: history(),
    });
    const verbose = view({ report: report_, verbose: true });
    expect(verbose).toContain("history 24h  2 units  tokens only");
    expect(verbose.match(/ history 24h/g)).toHaveLength(1);
    expect(view({ report: report_ })).not.toContain(" history 24h");
  });
});

describe("statusFindings — what --check exits 1 for", () => {
  test("a healthy deployment has none", () => {
    expect(
      statusFindings({ report: report({ cells: [cell({ pipeline: "work" })] }), bootAlive: true }),
    ).toEqual([]);
  });

  test("no report at all is the only finding there is", () => {
    expect(statusFindings({ report: null, bootAlive: false })).toEqual(["no deployment report"]);
  });

  test("wedged, crash-looping, doctor fail, held tenant, and no bootstrapper", () => {
    const findings = statusFindings({
      report: report({
        tenants: [tenant({ held: true, reason: "unreadable config" })],
        cells: [cell({ pipeline: "work", wedged: { wedged: true, reason: "unit-overdue" } })],
        children: [child({ id: "/etc/phoebe/children/widget#work", crashLooping: true })],
        doctor: doctorSection({
          report: {
            checks: [{ id: "repo", state: "fail", detail: "404" }],
            tenants: [],
            ok: false,
          },
        }),
      }),
      bootAlive: false,
    });
    expect(findings).toEqual([
      "bootstrapper not running",
      "wedged: /etc/phoebe/children/widget#work (unit-overdue)",
      "crash-looping: /etc/phoebe/children/widget#work",
      "doctor: failing check(s)",
      "held tenant: children/widget",
    ]);
  });

  test("history is never a finding, however many units failed or whatever they cost", () => {
    expect(
      statusFindings({
        report: report({
          cells: [cell({ pipeline: "work", history: history(BUSY_DAY) })],
          history: history(BUSY_DAY),
        }),
        bootAlive: true,
      }),
    ).toEqual([]);
  });

  test("a doctor warning and a stale pipeline directory are not findings", () => {
    expect(
      statusFindings({
        report: report({
          cells: [cell({ pipeline: "old", source: "stale" })],
          doctor: doctorSection(),
        }),
        bootAlive: true,
      }),
    ).toEqual([]);
  });
});

// --- the two arms ---------------------------------------------------------

function io(): {
  out: string[];
  err: string[];
  io: { stdout: (text: string) => void; stderr: (line: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (line) => err.push(line) } };
}

function scriptedRunner(
  script: Array<CommandResult | ((args: readonly string[]) => CommandResult)>,
): {
  runner: CommandRunner;
  calls: Array<{ args: readonly string[]; inheritStdio?: boolean }>;
} {
  const calls: Array<{ args: readonly string[]; inheritStdio?: boolean }> = [];
  let i = 0;
  const runner: CommandRunner = async (spec) => {
    calls.push({
      args: spec.args,
      ...(spec.inheritStdio !== undefined ? { inheritStdio: spec.inheritStdio } : {}),
    });
    const next = script[i++];
    if (next === undefined) throw new Error(`unexpected command: docker ${spec.args.join(" ")}`);
    return typeof next === "function" ? next(spec.args) : next;
  };
  return { runner, calls };
}

function psJson(state: string): CommandResult {
  return {
    code: 0,
    stdout: `${JSON.stringify({ Service: "phoebe", State: state })}\n`,
    stderr: "",
  };
}

function deploymentExists(path: string): boolean {
  return path.endsWith(COMPOSE_REL_PATH) || path.endsWith("phoebe.config.ts");
}

describe("the in-container arm", () => {
  const raw = `${JSON.stringify(report({ cells: [cell({ pipeline: "work" })] }), null, 2)}\n`;

  test("--json prints the file byte for byte", async () => {
    const lines = io();
    await runStatusCli(["--json"], "status", {
      inContainer: true,
      bootAlive: true,
      readReport: () => raw,
      now: NOW,
      io: lines.io,
    });
    expect(lines.out.join("")).toBe(raw);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("the config section rides in --json and stays out of the text view (#535)", async () => {
    const configured = report({
      cells: [cell({ pipeline: "work" })],
      config: {
        version: 1,
        root: { path: "/deployment/phoebe.config.ts", fingerprint: "sha256:abc123" },
        tenants: [
          {
            tenant: "acme/widget",
            error: null,
            fields: { repoSlug: { value: "acme/widget", source: "file", reader: "engine" } },
            env: { GH_TOKEN: { present: true, from: "tenantEnv" } },
            warnings: [],
          },
        ],
        omitted: 0,
        updatedAt: MINUTES_AGO(5),
      },
    });
    const file = `${JSON.stringify(configured, null, 2)}\n`;

    const json = io();
    await runStatusCli(["--json"], "status", {
      inContainer: true,
      bootAlive: true,
      readReport: () => file,
      now: NOW,
      io: json.io,
    });
    const printed = JSON.parse(json.out.join("")) as DeploymentReport;
    expect(printed.config!.root.fingerprint).toBe("sha256:abc123");
    expect(printed.config!.tenants[0]!.fields).toEqual({
      repoSlug: { value: "acme/widget", source: "file", reader: "engine" },
    });

    // The text view is the fleet, not the settings: `phoebe config` is the verb
    // for those, and a status screen that recited every leaf would bury the
    // question it exists to answer.
    const text = io();
    await runStatusCli([], "status", {
      inContainer: true,
      bootAlive: true,
      readReport: () => file,
      now: NOW,
      io: text.io,
    });
    const view = text.out.join("");
    expect(view).not.toContain("sha256:abc123");
    expect(view).not.toContain("repoSlug");
    expect(view).not.toContain("GH_TOKEN");
  });

  test("no report is stated as a fact, and --check exits 1 on it", async () => {
    const lines = io();
    await runStatusCli([], "status", {
      inContainer: true,
      bootAlive: true,
      readReport: () => {
        throw new Error("ENOENT");
      },
      now: NOW,
      io: lines.io,
    });
    expect(lines.out.join("")).toBe(`${NO_REPORT_MESSAGE}\n`);
    expect(process.exitCode ?? 0).toBe(0);

    await runStatusCli(["--check"], "status", {
      inContainer: true,
      bootAlive: true,
      readReport: () => {
        throw new Error("ENOENT");
      },
      now: NOW,
      io: io().io,
    });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("--json with no report fails loudly rather than printing half a model", async () => {
    await expect(
      runStatusCli(["--json"], "status", {
        inContainer: true,
        bootAlive: true,
        readReport: () => {
          throw new Error("ENOENT");
        },
        io: io().io,
      }),
    ).rejects.toThrow(/no deployment report/i);
  });

  test("--check names every finding on stderr and exits 1", async () => {
    const lines = io();
    await runStatusCli(["--check"], "status", {
      inContainer: true,
      bootAlive: false,
      readReport: () => raw,
      now: NOW,
      io: lines.io,
    });
    expect(lines.err.join("\n")).toContain("needs a look: bootstrapper not running");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("`list` prints the deprecation notice and the fleet section", async () => {
    const lines = io();
    await runStatusCli([], "list", {
      inContainer: true,
      bootAlive: true,
      readReport: () => raw,
      now: NOW,
      io: lines.io,
    });
    expect(lines.err).toEqual([LIST_DEPRECATION_NOTICE]);
    expect(lines.out.join("")).toContain("[phoebe] fleet");
    expect(lines.out.join("")).not.toContain("[phoebe] bootstrapper");
  });
});

describe("the host arm", () => {
  test("execs itself in the container with the flags rebuilt, and forwards the exit code", async () => {
    const script = scriptedRunner([psJson("running"), { code: 1, stdout: "", stderr: "" }]);
    const lines = io();
    await runStatusCli(["--check"], "status", {
      inContainer: false,
      cwd: "/deploy",
      dockerAvailable: true,
      exists: deploymentExists,
      runner: script.runner,
      deploymentCommands: undefined,
      io: lines.io,
    });
    expect(script.calls[1]?.args.slice(-6)).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "status",
      "--check",
    ]);
    expect(script.calls[1]?.inheritStdio).toBe(true);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("a stopped container is reported before any exec", async () => {
    const script = scriptedRunner([psJson("exited")]);
    const lines = io();
    await runStatusCli([], "status", {
      inContainer: false,
      cwd: "/deploy",
      dockerAvailable: true,
      exists: deploymentExists,
      runner: script.runner,
      io: lines.io,
    });
    expect(lines.out.join("")).toContain("container not running");
    expect(script.calls).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("the alias forwards its own verb, so the notice is printed once", () => {
    expect(
      statusExecArgv("list", { help: false, json: true, verbose: false, check: false }),
    ).toEqual(["exec", "-T", "phoebe", "phoebe", "list", "--json"]);
  });

  test("a deployment that drives its own runtime is told where to run this", async () => {
    await expect(
      runStatusCli([], "status", {
        inContainer: false,
        cwd: "/deploy",
        deploymentCommands: { startCommand: "up", stopCommand: "down" },
        io: io().io,
      }),
    ).rejects.toThrow(deploymentBlockMessage("status"));
  });
});
