// Builders for what every test here needs: an install, a report, and a bridge
// to hand them over. Shared by the test files rather than copied into each, so a change to
// the wire shape breaks in one place.
//
// Not reachable from main.tsx, so nothing here reaches the bundle.

import { DEPLOYMENT_SCHEMA, EFFECTIVE_CONFIG_VERSION } from "phoebe-agent/contracts";
import type {
  ChildLiveness,
  CompanionEnvironment,
  CompanionUpdate,
  ConfigReport,
  DeploymentReport,
  DesktopBridge,
  DoctorCheck,
  DoctorSection,
  FleetCell,
  HarnessApplyOutcome,
  HarnessName,
  HarnessReport,
  HarnessUpdate,
  HarnessUpdateOutcome,
  InstallDirectoryFacts,
  InstallRepair,
  LocalAlertEvent,
  LocalInstall,
  LocalReportEvent,
  RepairOutcome,
  StoredReport,
  TenantEffectiveConfig,
  TenantFacts,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";

export const NOW = new Date("2026-09-18T12:00:00.000Z");

/** `seconds` ago, as an ISO instant. */
export function ago(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

export function tenant(overrides: Partial<TenantFacts> = {}): TenantFacts {
  return {
    id: "/etc/phoebe",
    slug: "JesusFilm/youtube-studio",
    path: "/etc/phoebe",
    held: false,
    reason: null,
    configValid: true,
    envPresent: true,
    retainedData: true,
    arm: "app",
    ...overrides,
  };
}

export function cell(overrides: Partial<FleetCell> = {}): FleetCell {
  return {
    id: "/etc/phoebe#work",
    tenant: tenant(),
    pipeline: "work",
    source: "enumerated",
    disabled: false,
    concurrency: 1,
    state: "working",
    wedged: { wedged: false },
    snapshot: null,
    ...overrides,
  };
}

export function child(overrides: Partial<ChildLiveness> = {}): ChildLiveness {
  return {
    id: "/etc/phoebe#work",
    state: "running",
    since: ago(3600),
    restarts: 0,
    crashLooping: false,
    lastExit: null,
    lastPassAt: ago(60),
    ...overrides,
  };
}

export function check(overrides: Partial<DoctorCheck> = {}): DoctorCheck {
  return { id: "cli", state: "ok", detail: "phoebe-agent 0.13.0", ...overrides };
}

export function doctor(overrides: Partial<DoctorSection> = {}): DoctorSection {
  return {
    report: {
      checks: [check(), check({ id: "engine" })],
      tenants: [{ path: "/etc/phoebe", slug: "JesusFilm/youtube-studio", checks: [check()] }],
      ok: true,
    },
    at: ago(3 * 3600),
    trigger: "schedule",
    updatedAt: ago(3 * 3600),
    ...overrides,
  };
}

/**
 * One tenant's effective config, with every source on the tree at once: a value
 * the file set, one a `PHOEBE_*` variable took off it, a deprecated alias, a
 * kind inheriting its pipeline's provider, a model derived from that provider,
 * a default nobody touched, and the `deployment` block that does not survive
 * JSON.
 */
export function effectiveConfig(
  overrides: Partial<TenantEffectiveConfig> = {},
): TenantEffectiveConfig {
  return {
    tenant: "JesusFilm/youtube-studio",
    // The solo arm: the deployment root *is* the tenant, so this row is about
    // the one file a console may edit (#503, #547).
    configPath: "/etc/phoebe/phoebe.config.ts",
    error: null,
    fields: {
      repoSlug: {
        value: "JesusFilm/youtube-studio",
        source: "file",
        via: "phoebe.config.ts",
        reader: "both",
      },
      engine: {
        value: "v0.13.0",
        source: "file",
        via: "phoebe.config.ts",
        reader: "bootstrapper",
      },
      deployment: {
        value: "a compose file and two mounts",
        source: "file",
        via: "phoebe.config.ts",
        reader: "bootstrapper",
        opaque: true,
      },
      pipelines: {
        work: {
          concurrency: {
            value: 2,
            source: "overlay",
            via: "PHOEBE_WORK_CONCURRENCY",
            from: "tenantEnv",
            reader: "engine",
            shadowed: [{ source: "file", via: "phoebe.config.ts", value: 1 }],
          },
          workOrder: {
            value: "oldest-first",
            source: "alias",
            via: "workOrder",
            reader: "engine",
          },
          kinds: {
            research: {
              provider: {
                value: "claude-code",
                source: "inherited",
                via: "pipelines.work.provider",
                reader: "engine",
              },
              model: {
                value: "opus",
                source: "derived",
                via: "defaultModels.claude-code",
                reader: "engine",
              },
              runBudgetMs: { value: null, source: "default", reader: "engine" },
            },
          },
        },
      },
    },
    env: { GH_TOKEN: { present: true, from: "tenantEnv" } },
    warnings: [
      {
        path: "pipelines.work.workOrder",
        message: "workOrder is the old name for order; both are read and the old one warns",
      },
    ],
    ...overrides,
  };
}

/** Section 5 of the report: the config file it came from, and a row per tenant. */
export function configReport(overrides: Partial<ConfigReport> = {}): ConfigReport {
  return {
    version: EFFECTIVE_CONFIG_VERSION,
    root: { path: "/etc/phoebe/phoebe.config.ts", fingerprint: "sha256:9f2c1b7e" },
    tenants: [effectiveConfig()],
    omitted: 0,
    updatedAt: ago(12),
    ...overrides,
  };
}

export function report(overrides: Partial<DeploymentReport> = {}): DeploymentReport {
  return {
    schema: DEPLOYMENT_SCHEMA,
    identity: { name: "youtube-studio", arm: "solo", host: "linux" },
    bootstrapper: {
      engineRef: "v0.13.0",
      engineSha: "dd6f67d",
      quarantinedSha: null,
      crashLoop: { lastGoodSha: "dd6f67d", failingSha: null, failureCount: 0 },
      reconcile: { phase: "idle", since: ago(3600) },
      children: [child()],
      slots: { capacity: 2, inUse: 1, waiting: 0, overGranted: 0, floorBudget: 0 },
      updatedAt: ago(12),
    },
    relay: {
      configured: true,
      state: "connected",
      nextRetryAt: null,
      lastClose: null,
      updatedAt: ago(12),
    },
    fleet: { tenants: [tenant()], cells: [cell()], updatedAt: ago(12) },
    config: configReport(),
    doctor: doctor(),
    updatedAt: ago(12),
    ...overrides,
  };
}

export function stored(
  body: unknown = report(),
  overrides: Partial<StoredReport> = {},
): StoredReport {
  return {
    schema: DEPLOYMENT_SCHEMA,
    receivedAt: ago(12),
    report: body,
    ...overrides,
  };
}

// ── the companion's side ──────────────────────────────────────────────────

/** One local install, with only the fields a test cares about spelled out. */
export function install(overrides: Partial<LocalInstall> = {}): LocalInstall {
  return {
    dir: "/repos/youtube-studio",
    name: "youtube-studio",
    addedAt: ago(3600),
    state: "running",
    containerVersion: "0.13.0",
    ...overrides,
  };
}

/** The Docker check, on a machine where everything is where it should be. */
export function environment(overrides: Partial<CompanionEnvironment> = {}): CompanionEnvironment {
  return {
    companionVersion: "0.13.0",
    platform: "linux",
    docker: { present: true, composeVersion: "v2.29.7", daemonRunning: true },
    wslDistros: [],
    ...overrides,
  };
}

/**
 * A desktop bridge that answers with whatever the test hands it and refuses
 * everything else. Written once here because both the surface test and the
 * render tests need a whole one — the contract has no optional members, which
 * is what stops a page from feature-detecting its way around a missing arm.
 */
export function bridge(answers: BridgeAnswers = {}): DesktopBridge {
  return {
    version: () => Promise.resolve("0.13.0"),
    environment: () => Promise.resolve(answers.environment ?? environment()),
    installs: {
      list: () => Promise.resolve(answers.installs ?? []),
      pick: () => Promise.resolve(answers.picked ?? null),
      add: () => Promise.resolve(answers.installs ?? []),
      remove: () => Promise.resolve([]),
      update: (dir, patch) =>
        Promise.resolve({ installs: answers.installs ?? [], dir: patch.dir ?? dir }),
      changes: () => () => undefined,
      reports: (onReport) => {
        for (const event of answers.reports ?? []) onReport(event);
        return () => undefined;
      },
      refresh: (dir) => {
        const event = (answers.reports ?? []).find((candidate) => candidate.install === dir);
        return event === undefined ? Promise.reject(notAnInstall(dir)) : Promise.resolve(event);
      },
      repair: (dir, repair) => {
        answers.repaired?.push({ dir, repair });
        return Promise.resolve(answers.repair ?? { fixed: true, detail: "fixed" });
      },
      alerts: (onAlert) => {
        for (const event of answers.alerts ?? []) onAlert(event);
        return () => undefined;
      },
    },
    harness: {
      check: (dir, opts) => {
        answers.harnessChecks?.push({ dir, lookUp: opts.lookUp });
        return answers.harness === undefined
          ? Promise.reject(notAnInstall(dir))
          : Promise.resolve(answers.harness);
      },
      remove: (dir, harness) => {
        answers.harnessRemovals?.push({ dir, harness });
        return Promise.resolve({ kind: "removed", harness, file: `${dir}/container/Dockerfile` });
      },
      apply: (dir, harness) => {
        answers.harnessApplies?.push({ dir, harness });
        return Promise.resolve(
          answers.harnessApply ?? { kind: "applied", harness, version: "0.0.0" },
        );
      },
      reports: () => () => undefined,
      update: (dir, update) => {
        answers.harnessUpdates?.push({ dir, update });
        return Promise.resolve(
          answers.harnessUpdate ?? {
            kind: "moved",
            harness: update.harness,
            from: null,
            to: update.version,
            file: `${dir}/container/Dockerfile`,
          },
        );
      },
    },
    runs: {
      start: (request) => {
        answers.started?.push(request);
        return Promise.resolve(answers.runId ?? "run-1");
      },
      current: () => Promise.resolve(answers.run ?? null),
      cancel: () => Promise.resolve(),
      lines: () => () => undefined,
      exits: () => () => undefined,
    },
    logs: {
      follow: () => Promise.resolve(answers.logs ?? []),
      stop: () => Promise.resolve(),
      lines: () => () => undefined,
      ended: () => () => undefined,
    },
    updates: {
      state: () => Promise.resolve(answers.update ?? { kind: "checking" }),
      download: () => {
        answers.updateCalls?.push("download");
        return Promise.resolve();
      },
      restart: () => {
        answers.updateCalls?.push("restart");
        return Promise.resolve();
      },
      changes: () => () => undefined,
    },
    preferences: {
      get: () =>
        Promise.resolve({ notifications: true, consoleTheme: "system", autoCheckUpdates: false }),
      set: (preferences) => Promise.resolve(preferences),
    },
  };
}

/** What a test wants the bridge above to answer with. */
export type BridgeAnswers = {
  /** What `logs.follow` hands a pane that opens: the lines held so far. */
  logs?: string[];
  environment?: CompanionEnvironment;
  installs?: LocalInstall[];
  /** What a harness check answers with; unset, the check is refused. */
  harness?: HarnessReport;
  harnessChecks?: { dir: string; lookUp: boolean }[];
  harnessUpdate?: HarnessUpdateOutcome;
  harnessUpdates?: { dir: string; update: HarnessUpdate }[];
  harnessApply?: HarnessApplyOutcome;
  harnessApplies?: { dir: string; harness: HarnessName }[];
  harnessRemovals?: { dir: string; harness: HarnessName }[];
  /** What a repair answers with, and where each one asked for is recorded. */
  repair?: RepairOutcome;
  repaired?: { dir: string; repair: InstallRepair }[];
  picked?: string | null;
  run?: VerbRun | null;
  runId?: string;
  /** Collects every run the page asked for. */
  started?: VerbRunRequest[];
  /** What the local read loop has emitted, one event per install (#556). */
  reports?: LocalReportEvent[];
  /** What main raised over a local install (#559). */
  alerts?: LocalAlertEvent[];
  /** Where the companion's own update stands (#525 §3). */
  update?: CompanionUpdate;
  /** Collects the update buttons the page pressed. */
  updateCalls?: string[];
};

/** The directory facts main derives with no container involved (#527 §6). */
export function directory(overrides: Partial<InstallDirectoryFacts> = {}): InstallDirectoryFacts {
  return {
    configPath: "/repos/youtube-studio/phoebe.config.ts",
    configText: 'export default defineConfig({ repoSlug: "JesusFilm/youtube-studio" })\n',
    configFingerprint: "sha256:0f1e2d3c4b5a6978",
    envPresent: true,
    bootstrapperRunning: true,
    ...overrides,
  };
}

/** One read the loop finished, for whichever install the test is about. */
export function localReport(overrides: Partial<LocalReportEvent> = {}): LocalReportEvent {
  const facts = overrides.facts ?? install();
  return {
    type: "report",
    install: facts.dir,
    at: ago(2),
    facts,
    directory: directory({ bootstrapperRunning: facts.state === "running" }),
    report:
      facts.state === "running"
        ? { schema: DEPLOYMENT_SCHEMA, receivedAt: ago(2), report: report() }
        : null,
    ...overrides,
  };
}

/** What main refuses a read of a folder it does not hold with (#527 §16). */
export function notAnInstall(dir: string): Error {
  return Object.assign(new Error(`${dir} is not a local install the companion knows`), {
    code: "refused",
  });
}
