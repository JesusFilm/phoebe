// Builders for the two things every test here needs: a relay row and a stored
// report. Shared by the test files rather than copied into each, so a change to
// the wire shape breaks in one place.
//
// Not reachable from main.tsx, so nothing here reaches the bundle.

import { DEPLOYMENT_SCHEMA, EFFECTIVE_CONFIG_VERSION } from "phoebe-agent/contracts";
import type {
  ChildLiveness,
  ConfigReport,
  DeploymentReport,
  DoctorCheck,
  DoctorSection,
  FleetCell,
  RelayDeploymentRow,
  RelayPerson,
  RelayStoredReport,
  SecretListing,
  SecretsSection,
  StatusSnapshot,
  TenantEffectiveConfig,
  TenantFacts,
  TenantSecrets,
} from "phoebe-agent/contracts";
import type { RelayClient, SecretReceipt, SecretRequest } from "./relay-client.ts";

export const NOW = new Date("2026-09-18T12:00:00.000Z");

/** `seconds` ago, as an ISO instant. */
export function ago(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

/**
 * A box key the browser can really import: 32 bytes of base64url, which is all
 * X25519 asks of a public key. A test that wants to open what the tab sealed
 * generates its own pair and overrides this.
 */
export const BOX_KEY = "cGhvZWJlIGNvbnNvbGUgYm94IGtleSBmaXh0dXJlISE";

export function row(overrides: Partial<RelayDeploymentRow> = {}): RelayDeploymentRow {
  return {
    fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    name: "youtube-studio",
    publicKey: "cGstZGVwbG95bWVudC1maXh0dXJlLTMyLWJ5dGVzISE",
    // A real X25519 key, because the secrets tab seals to it for real: the tests
    // that exercise a set open the envelope again with the matching private
    // half (secrets-render.test.tsx).
    boxKey: BOX_KEY,
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

/** A pipeline's `status.json`, with whatever it has in flight. */
export function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    tenant: "JesusFilm/youtube-studio",
    pipeline: "work",
    currentUnits: [
      { unit: { kind: "issues", id: "544" }, startedAt: ago(600), runBudgetMs: 5_400_000 },
    ],
    waitingForSlot: false,
    lastError: null,
    lastTimeoutAt: null,
    updatedAt: ago(12),
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

export function listing(overrides: Partial<SecretListing> = {}): SecretListing {
  return { key: "ANTHROPIC_API_KEY", present: false, source: "missing", ...overrides };
}

export function tenantSecrets(overrides: Partial<TenantSecrets> = {}): TenantSecrets {
  return {
    tenant: "JesusFilm/youtube-studio",
    path: "/etc/phoebe",
    error: null,
    keys: [listing()],
    ...overrides,
  };
}

export function secrets(overrides: Partial<SecretsSection> = {}): SecretsSection {
  return { tenants: [tenantSecrets()], updatedAt: ago(30), ...overrides };
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
    config: configReport(),
    doctor: doctor(),
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

export function person(overrides: Partial<RelayPerson> = {}): RelayPerson {
  return {
    email: "ada@example.test",
    addedBy: "grace@example.test",
    addedAt: ago(86_400),
    fromEnvironment: false,
    signedIn: true,
    self: false,
    ...overrides,
  };
}

/**
 * A relay client that answers nothing. Every page now takes the seam, and a
 * render test that only wants markup should not have to invent five methods to
 * get it — `overrides` is where a test that does care puts the one it reads.
 */
export function client(overrides: Partial<RelayClient> = {}): RelayClient {
  return {
    me: () => Promise.resolve({ sub: "s", email: "ada@example.test" }),
    signIn: () => Promise.resolve({ kind: "navigate", href: "/auth/google/start" }),
    watchSession: () => () => {},
    signOut: () => Promise.resolve(),
    deployments: () => Promise.resolve([]),
    deployment: () => Promise.reject(new Error("no such deployment")),
    runDoctor: () => Promise.resolve([]),
    setConfigField: () => Promise.resolve({ outcome: "written" }),
    setSecret: () => Promise.reject(new Error("nothing stubbed setSecret")),
    events: () => () => {},
    people: () => Promise.resolve([]),
    addPerson: () => Promise.reject(new Error("nothing stubbed addPerson")),
    removePerson: () => Promise.resolve({ sessionsEnded: 0 }),
    mintPairingToken: () => Promise.reject(new Error("nothing stubbed mintPairingToken")),
    ...overrides,
  };
}

/** A client whose `setSecret` answers with `outcome`, recording what it was sent. */
export function recordingClient(receipt: Partial<SecretReceipt> & { outcome: string }): {
  client: RelayClient;
  sent: SecretRequest[];
} {
  const sent: SecretRequest[] = [];
  return {
    sent,
    client: client({
      setSecret: (request) => {
        sent.push(request);
        return Promise.resolve({ id: request.id, ...receipt });
      },
    }),
  };
}
