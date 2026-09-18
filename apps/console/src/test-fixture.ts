// Builders for the two things every test here needs: a relay row and a stored
// report. Shared by the test files rather than copied into each, so a change to
// the wire shape breaks in one place.
//
// Not reachable from main.tsx, so nothing here reaches the bundle.

import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts";
import type { RelayClient, SecretReceipt, SecretRequest } from "./relay-client.ts";
import type {
  ChildLiveness,
  SecretListing,
  SecretsSection,
  TenantSecrets,
  DeploymentReport,
  DoctorCheck,
  DoctorSection,
  FleetCell,
  RelayDeploymentRow,
  RelayStoredReport,
  StatusSnapshot,
  TenantFacts,
} from "phoebe-agent/contracts";

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

/**
 * A relay client for a component test: every method throws unless the test
 * overrode it, so a page that reached the relay without being asked to fails
 * loudly rather than silently resolving.
 */
export function stubClient(overrides: Partial<RelayClient> = {}): RelayClient {
  const unasked = (what: string) => () =>
    Promise.reject(new Error(`this test never calls ${what}`));
  return {
    me: unasked("me"),
    signOut: unasked("signOut"),
    deployments: unasked("deployments"),
    deployment: unasked("deployment"),
    setSecret: unasked("setSecret"),
    events: () => () => {},
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
    client: stubClient({
      setSecret: (request) => {
        sent.push(request);
        return Promise.resolve({ id: request.id, ...receipt });
      },
    }),
  };
}
