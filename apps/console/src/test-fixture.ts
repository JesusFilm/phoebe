// Builders for the two things every test here needs: a relay row and a stored
// report. Shared by the test files rather than copied into each, so a change to
// the wire shape breaks in one place.
//
// Not reachable from main.tsx, so nothing here reaches the bundle.

import { DEPLOYMENT_SCHEMA, RELAY_EVENTS } from "phoebe-agent/contracts";
import type {
  ChildLiveness,
  CompanionEnvironment,
  DeploymentReport,
  DesktopBridge,
  FleetCell,
  InstallDirectoryFacts,
  LocalInstall,
  LocalReportEvent,
  RelayArmState,
  RelayDeploymentRow,
  RelayEvent,
  RelayStoredReport,
  TenantFacts,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";

export const NOW = new Date("2026-09-18T12:00:00.000Z");

/** `seconds` ago, as an ISO instant. */
export function ago(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

export function row(overrides: Partial<RelayDeploymentRow> = {}): RelayDeploymentRow {
  return {
    fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    name: "youtube-studio",
    firstSeen: ago(86_400),
    lastSeen: ago(12),
    pairedBy: "ada@example.test",
    state: "connected",
    connectedSince: ago(3600),
    disconnectedForSeconds: null,
    lastClose: null,
    maybeReplaced: false,
    ...overrides,
  };
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

export function report(overrides: Partial<DeploymentReport> = {}): DeploymentReport {
  return {
    schema: DEPLOYMENT_SCHEMA,
    identity: { name: "youtube-studio", arm: "solo" },
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
    updatedAt: ago(12),
    ...overrides,
  };
}

export function stored(
  body: unknown = report(),
  overrides: Partial<RelayStoredReport> = {},
): RelayStoredReport {
  return {
    fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
    ...overrides,
  };
}

/** The Docker check, on a machine where everything is where it should be. */
export function environment(overrides: Partial<CompanionEnvironment> = {}): CompanionEnvironment {
  return {
    companionVersion: "0.13.0",
    platform: "linux",
    docker: { present: true, composeVersion: "v2.29.7", daemonRunning: true },
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
  const relayState = answers.relay ?? { url: null, person: null, persisted: false };
  return {
    version: () => Promise.resolve("0.13.0"),
    environment: () => Promise.resolve(answers.environment ?? environment()),
    installs: {
      list: () => Promise.resolve(answers.installs ?? []),
      pick: () => Promise.resolve(answers.picked ?? null),
      add: () => Promise.resolve(answers.installs ?? []),
      remove: () => Promise.resolve([]),
      changes: () => () => undefined,
      reports: (onReport) => {
        for (const event of answers.reports ?? []) onReport(event);
        return () => undefined;
      },
      refresh: (dir) => {
        const event = (answers.reports ?? []).find((candidate) => candidate.install === dir);
        return event === undefined ? Promise.reject(notAnInstall(dir)) : Promise.resolve(event);
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
    preferences: {
      get: () => Promise.resolve({ notifications: true }),
      set: (preferences) => Promise.resolve(preferences),
    },
    relay: {
      state: () => Promise.resolve(relayState),
      request: ({ path }) => {
        if (answers.request === undefined) return Promise.reject(signedOut());
        return Promise.resolve(answers.request(path));
      },
      events: (onEvent) => {
        for (const event of answers.events ?? []) onEvent(event);
        return () => undefined;
      },
      signOut: () => Promise.resolve(),
    },
  };
}

/** What a test wants the bridge above to answer with. */
export type BridgeAnswers = {
  relay?: RelayArmState;
  environment?: CompanionEnvironment;
  installs?: LocalInstall[];
  picked?: string | null;
  run?: VerbRun | null;
  runId?: string;
  /** Collects every run the page asked for. */
  started?: VerbRunRequest[];
  request?: (path: string) => unknown;
  events?: RelayEvent[];
  /** What the local read loop has emitted, one event per install (#556). */
  reports?: LocalReportEvent[];
};

/** The directory facts main derives with no container involved (#527 §6). */
export function directory(overrides: Partial<InstallDirectoryFacts> = {}): InstallDirectoryFacts {
  return {
    configPath: "/repos/youtube-studio/phoebe.config.ts",
    configText: 'export default defineConfig({ repoSlug: "JesusFilm/youtube-studio" })\n',
    configFingerprint: "0f1e2d3c4b5a6978",
    envPresent: true,
    bootstrapperRunning: true,
    ...overrides,
  };
}

/** One read the loop finished, for whichever install the test is about. */
export function localReport(overrides: Partial<LocalReportEvent> = {}): LocalReportEvent {
  const facts = overrides.facts ?? install();
  return {
    type: RELAY_EVENTS.report,
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

/** What the preload throws when main refuses a call (#527 §16). */
export function signedOut(): Error {
  return Object.assign(new Error("the companion is not signed in to a relay"), {
    code: "signed-out",
  });
}

/** What main refuses a read of a folder it does not hold with (#527 §16). */
export function notAnInstall(dir: string): Error {
  return Object.assign(new Error(`${dir} is not a local install the companion knows`), {
    code: "refused",
  });
}
