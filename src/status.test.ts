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
  RelayReport,
  TenantFacts,
} from "./contracts/deployment.ts";
import type { DoctorSection } from "./contracts/doctor.ts";
import type { CommandResult, CommandRunner } from "./deployment-compose.ts";
import { COMPOSE_REL_PATH } from "./deployment-compose.ts";
import {
  deploymentBlockMessage,
  formatBootstrapperLine,
  formatDoctorLine,
  formatProcessLine,
  formatRelayLine,
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
  relay?: RelayReport;
  doctor?: DoctorSection;
  bootstrapper?: Partial<DeploymentReport["bootstrapper"]>;
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
      updatedAt: MINUTES_AGO(2),
    },
    config: fields.config ?? {
      version: 1,
      root: { path: "/deployment/phoebe.config.ts", fingerprint: "sha256:root" },
      tenants: [],
      omitted: 0,
      updatedAt: MINUTES_AGO(2),
    },
    updatedAt: MINUTES_AGO(2),
    ...(fields.relay !== undefined ? { relay: fields.relay } : {}),
    doctor: fields.doctor ?? { report: null, at: null, trigger: null, updatedAt: MINUTES_AGO(2) },
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

describe("the relay line", () => {
  test("no section and an unconfigured one both print nothing", () => {
    expect(formatRelayLine(undefined, NOW)).toBeNull();
    expect(
      formatRelayLine(
        {
          configured: false,
          name: null,
          keyFingerprint: null,
          state: "unpaired",
          since: MINUTES_AGO(5),
        },
        NOW,
      ),
    ).toBeNull();
  });

  test("a configured relay is one line of facts", () => {
    const line = formatRelayLine(
      {
        configured: true,
        name: "relay.example",
        keyFingerprint: "SHA256:abc",
        state: "reconnecting",
        since: MINUTES_AGO(3),
        nextRetryAt: new Date(NOW + 30_000).toISOString(),
        lastClose: { code: 1006, at: MINUTES_AGO(3) },
      },
      NOW,
    );
    expect(line).toContain("relay.example");
    expect(line).toContain("reconnecting 3m");
    expect(line).toContain("next retry in 30s");
    expect(line).toContain("last close 1006");
    expect(line).toContain("SHA256:abc");
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
              { unit: { kind: "issues", id: "12" }, startedAt: MINUTES_AGO(5), runBudgetMs: null },
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
  test("priority order: bootstrapper, relay, fleet, doctor", () => {
    const text = view({
      report: report({
        cells: [cell({ pipeline: "work" })],
        children: [child({ id: "/etc/phoebe/children/widget#work" })],
        relay: {
          configured: true,
          name: "relay.example",
          keyFingerprint: null,
          state: "connected",
          since: MINUTES_AGO(120),
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
      "[phoebe] relay",
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
    expect(printed.config.root.fingerprint).toBe("sha256:abc123");
    expect(printed.config.tenants[0]!.fields).toEqual({
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
