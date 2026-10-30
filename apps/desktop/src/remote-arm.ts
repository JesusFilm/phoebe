// The remote arm, in main (map #690): the records, the bearers, one supervisor
// per record, the alert rule over each, and the handful of requests the window
// asks main to make with the bearer added. Everything Electron is a parameter
// — `userData`, `safeStorage`, the broadcast — so the whole arm runs under
// test with a fake fetch and a temp directory.
//
// **The bearer never crosses the bridge.** `pair` answers the record; `request`
// adds the bearer in here; nothing on the window's side ever holds one.
//
// **Pair reads the descriptor before it spends a code**, so a wrong link costs
// nothing, and the four failures a person can hit each map to one line of
// wording in the console: nothing answered (`unreachable`, or `tailscale-off`
// when this machine's Tailscale is down), something that is not a Phoebe
// deployment (`not-phoebe`), a code the deployment did not accept
// (`code-rejected`), a deployment newer than this companion (`protocol`).
//
// **Keyed on `deploymentId`** (#699): a pair whose descriptor names a held id
// replaces that record's bearer and keeps its label, last report and notified
// map — "pair again" — and restarts its supervisor.

import { hostname } from "node:os";
import { join } from "node:path";
import type {
  PairResult,
  RemoteAlertEvent,
  RemoteLogLine,
  RemoteLogsEnded,
  RemotePassthrough,
  RemoteRecord,
  RemoteReportEvent,
  RemoteResponse,
  RevokeOutcome,
  SessionRow,
  StoredReport,
} from "phoebe-agent/contracts";
import { DESCRIPTOR_PATH, REMOTE_PROTOCOL, REMOTE_ROUTES } from "phoebe-agent/contracts";
import { ALERT_DARK_AFTER_MS } from "../../../src/contracts/alerts.ts";
import { ESTABLISH_TIMEOUT_MS } from "../../console/src/reachability.ts";
import type { CompanionAlerts } from "./alerting.ts";
import { BridgeRefusal } from "./channels.ts";
import { createRemoteLogs, type RemoteLogs } from "./remote-logs.ts";
import {
  createRemoteSupervisor,
  type RemoteSupervisor,
  type SupervisorReading,
} from "./remote-supervisor.ts";
import {
  createRemoteStore,
  freshRemote,
  recordOf,
  REMOTES_FILE,
  type RemoteStore,
  type StoredRemote,
} from "./remotes.ts";
import { createBearerVault, type BearerVault, type SafeStorageLike } from "./vault.ts";

/** How long this machine's Tailscale answer is believed before it is asked again. */
export const TAILSCALE_CHECK_TTL_MS = 60_000;

export type TailscaleCheck = { running: boolean; detail: string } | null;

export type RemoteArmDeps = {
  userDataDir: string;
  safeStorage: SafeStorageLike;
  fetchFn: typeof fetch;
  alerts: CompanionAlerts;
  /** The channels main broadcasts on. The two log channels are optional for a test that follows none. */
  emit: {
    changed: (records: RemoteRecord[]) => void;
    report: (event: RemoteReportEvent) => void;
    alert: (event: RemoteAlertEvent) => void;
    logLine?: (line: RemoteLogLine) => void;
    logsEnded?: (end: RemoteLogsEnded) => void;
  };
  /** `tailscale status` on this machine, uncached; null when there is no CLI. */
  tailscaleStatus?: () => Promise<TailscaleCheck>;
  /** What the pair body says this device runs. */
  os?: string;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
  /** Injected so a test never opens the real files. */
  store?: RemoteStore;
  vault?: BearerVault;
};

export type RemoteArm = {
  list: () => RemoteRecord[];
  pair: (input: { url: string; code: string; label: string }) => Promise<PairResult>;
  request: (deploymentId: string, passthrough: RemotePassthrough) => Promise<RemoteResponse>;
  signOut: (deploymentId: string) => Promise<void>;
  forget: (deploymentId: string) => Promise<void>;
  sessions: (deploymentId: string) => Promise<SessionRow[]>;
  revoke: (deploymentId: string, sessionId: string) => Promise<RevokeOutcome>;
  tailscale: () => Promise<TailscaleCheck>;
  /** Follow one remote's output over `GET /api/logs` (remote-logs.ts), the bearer added here. */
  followLogs: (deploymentId: string) => Promise<string[]>;
  stopLogs: (deploymentId: string) => void;
  /** Start every record's supervisor. */
  start: () => void;
  /** Network back, machine awake, window focused. */
  poke: () => void;
  stop: () => void;
};

type Live = {
  supervisor: RemoteSupervisor;
  reading: SupervisorReading;
  /** The dark clock: re-evaluates the alert rule once the five-minute mark passes. */
  darkTimer: unknown;
};

/** Trim a URL down to `https://host[:port]`. */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.origin;
}

export function createRemoteArm(deps: RemoteArmDeps): RemoteArm {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const store = deps.store ?? createRemoteStore({ path: join(deps.userDataDir, REMOTES_FILE) });
  const vault =
    deps.vault ??
    createBearerVault({ safeStorage: deps.safeStorage, userDataDir: deps.userDataDir });
  const live = new Map<string, Live>();
  let tailscaleCached: { at: number; answer: TailscaleCheck } | null = null;
  const logs: RemoteLogs = createRemoteLogs({
    fetchFn: deps.fetchFn,
    onLine: (line) => deps.emit.logLine?.(line),
    onEnded: (end) => deps.emit.logsEnded?.(end),
    log,
  });

  const readingOf = (deploymentId: string): SupervisorReading =>
    live.get(deploymentId)?.reading ?? { reachability: "dark", descriptor: null };

  const list = (): RemoteRecord[] =>
    store.list().map((stored) => recordOf(stored, readingOf(stored.deploymentId)));

  const emitChanged = (): void => deps.emit.changed(list());

  /** Run the rule over one record and persist what it hands back. */
  const evaluate = (deploymentId: string): void => {
    const stored = store.get(deploymentId);
    const entry = live.get(deploymentId);
    if (stored === null || entry === undefined) return;
    const outcome = deps.alerts.remote({
      deploymentId,
      name: stored.name,
      reachability: entry.reading.reachability,
      lastHeardAt: stored.lastHeardAt,
      maybeReplaced: entry.reading.blocked === "replaced",
      report: stored.lastReport,
      notified: stored.notified,
      seeded: stored.seeded,
    });
    store.patch(deploymentId, { notified: outcome.notified, seeded: outcome.seeded });
    for (const alert of outcome.alerts) deps.emit.alert(alert);
    // A remote that is not connected is on its way to the five-minute mark; the
    // rule has to be asked again when it gets there, since nothing else fires.
    clearDark(entry);
    if (entry.reading.reachability !== "connected" && entry.reading.reachability !== "blocked") {
      const heard = stored.lastHeardAt === null ? null : Date.parse(stored.lastHeardAt);
      if (heard !== null && Number.isFinite(heard)) {
        const left = heard + ALERT_DARK_AFTER_MS - now();
        if (left > 0) {
          entry.darkTimer = setTimer(() => {
            entry.darkTimer = null;
            evaluate(deploymentId);
          }, left + 1);
        }
      }
    }
  };

  const clearDark = (entry: Live): void => {
    if (entry.darkTimer !== null) clearTimer(entry.darkTimer);
    entry.darkTimer = null;
  };

  const emitReport = (deploymentId: string): void => {
    const stored = store.get(deploymentId);
    if (stored === null) return;
    deps.emit.report({
      type: "remote",
      deploymentId,
      at: new Date(now()).toISOString(),
      record: recordOf(stored, readingOf(deploymentId)),
    });
  };

  const supervise = (stored: StoredRemote): void => {
    retire(stored.deploymentId);
    const entry: Live = {
      reading: { reachability: "dark", descriptor: null },
      darkTimer: null,
      supervisor: createRemoteSupervisor({
        url: stored.url,
        stored: { deploymentId: stored.deploymentId },
        bearer: () => vault.read(stored.deploymentId),
        lastHeardAt: stored.lastHeardAt,
        fetchFn: deps.fetchFn,
        now,
        ...(deps.random !== undefined ? { random: deps.random } : {}),
        ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),
        ...(deps.clearTimer !== undefined ? { clearTimer: deps.clearTimer } : {}),
        log,
        onHeard: (at, report) => {
          const fields: Partial<StoredRemote> = { lastHeardAt: at };
          if (report !== null) {
            fields.lastReport = report;
            const name = nameOf(report);
            if (name !== null) fields.name = name;
          }
          store.patch(stored.deploymentId, fields);
          if (report !== null) {
            emitReport(stored.deploymentId);
            evaluate(stored.deploymentId);
          }
        },
        onReading: (reading) => {
          entry.reading = reading;
          if (reading.descriptor !== null) {
            store.patch(stored.deploymentId, { protocol: reading.descriptor.protocol });
          }
          emitReport(stored.deploymentId);
          evaluate(stored.deploymentId);
        },
      }),
    };
    live.set(stored.deploymentId, entry);
    entry.supervisor.start();
  };

  const retire = (deploymentId: string): void => {
    // A record going, or being paired again, takes its log stream with it:
    // the next follow opens on the new bearer.
    logs.stop(deploymentId);
    const entry = live.get(deploymentId);
    if (entry === undefined) return;
    clearDark(entry);
    entry.supervisor.stop();
    live.delete(deploymentId);
  };

  /** One request with the bearer, or a transport refusal. */
  const call = async (
    stored: StoredRemote,
    passthrough: RemotePassthrough,
    timeoutMs = ESTABLISH_TIMEOUT_MS,
  ): Promise<RemoteResponse> => {
    const bearer = vault.read(stored.deploymentId) ?? "";
    let response: Response;
    try {
      response = await deps.fetchFn(`${stored.url}${passthrough.path}`, {
        method: passthrough.method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: "application/json",
          ...(passthrough.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(passthrough.body === undefined ? {} : { body: JSON.stringify(passthrough.body) }),
      });
    } catch (error) {
      throw new BridgeRefusal({
        code: "undelivered",
        message: `${stored.url} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return { status: response.status, body: await bodyOf(response) };
  };

  const held = (deploymentId: string): StoredRemote => {
    const stored = store.get(deploymentId);
    if (stored === null) {
      throw new BridgeRefusal({
        code: "refused",
        message: `${deploymentId} is not a remote the companion holds`,
      });
    }
    return stored;
  };

  const tailscale = async (): Promise<TailscaleCheck> => {
    if (tailscaleCached !== null && now() - tailscaleCached.at < TAILSCALE_CHECK_TTL_MS) {
      return tailscaleCached.answer;
    }
    const answer = deps.tailscaleStatus === undefined ? null : await deps.tailscaleStatus();
    tailscaleCached = { at: now(), answer };
    return answer;
  };

  return {
    list,
    tailscale,

    async pair(input) {
      const url = originOf(input.url);
      if (url === null) {
        return {
          outcome: "unreachable",
          detail: `${input.url} is not an address a deployment answers on.`,
        };
      }
      // The descriptor first, before a code is spent.
      let seen: Response;
      try {
        seen = await deps.fetchFn(`${url}${DESCRIPTOR_PATH}`, {
          signal: AbortSignal.timeout(ESTABLISH_TIMEOUT_MS),
          headers: { accept: "application/json" },
        });
      } catch (error) {
        const check = await tailscale();
        if (check !== null && !check.running) {
          return {
            outcome: "tailscale-off",
            detail: `Tailscale is ${check.detail} on this machine.`,
          };
        }
        return {
          outcome: "unreachable",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (seen.status !== 200) {
        return {
          outcome: "not-phoebe",
          detail: `${url} answered ${seen.status}, not with a Phoebe descriptor.`,
        };
      }
      const descriptor = (await bodyOf(seen)) as Record<string, unknown> | null;
      if (
        descriptor === null ||
        typeof descriptor["deploymentId"] !== "string" ||
        typeof descriptor["protocol"] !== "number" ||
        typeof descriptor["name"] !== "string"
      ) {
        return { outcome: "not-phoebe", detail: `${url} answers, but not as a Phoebe deployment.` };
      }
      if (descriptor["protocol"] > REMOTE_PROTOCOL) {
        return {
          outcome: "protocol",
          detail: `${url} speaks protocol ${descriptor["protocol"]}; this companion knows ${REMOTE_PROTOCOL}.`,
        };
      }
      const existing = store.get(descriptor["deploymentId"]);
      const label = input.label.trim() === "" ? hostname() : input.label.trim();
      let paired: Response;
      try {
        paired = await deps.fetchFn(`${url}${REMOTE_ROUTES.pair}`, {
          method: "POST",
          signal: AbortSignal.timeout(ESTABLISH_TIMEOUT_MS),
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            code: input.code,
            client: { label, deviceType: "desktop", os: deps.os ?? osLabel() },
          }),
        });
      } catch (error) {
        return {
          outcome: "unreachable",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      const body = (await bodyOf(paired)) as Record<string, unknown> | null;
      if (paired.status === 400 || paired.status === 429) {
        return {
          outcome: "code-rejected",
          detail:
            paired.status === 429
              ? "too many attempts; wait a minute"
              : "the code was not accepted",
        };
      }
      if (
        paired.status !== 200 ||
        body === null ||
        typeof body["token"] !== "string" ||
        typeof body["expiresAt"] !== "string" ||
        !Array.isArray(body["scopes"])
      ) {
        return {
          outcome: "unreachable",
          detail: `${url} answered the pair with ${paired.status}.`,
        };
      }
      const deploymentId = descriptor["deploymentId"];
      if (existing !== null) {
        // Pair again replaces this device's session, so the old one must not
        // outlive it on the deployment: a device that paired again to give up
        // operate would otherwise still hold it there. Best effort, with the
        // bearer the vault still holds; the deployment expires it on its own
        // when this does not land.
        retire(deploymentId);
        try {
          await call(existing, { method: "DELETE", path: REMOTE_ROUTES.session });
        } catch {
          // Unreachable now: the new session is what counts from here.
        }
      }
      vault.write(deploymentId, body["token"]);
      const record: StoredRemote =
        existing === null
          ? freshRemote({
              deploymentId,
              url,
              name: descriptor["name"],
              label,
              arm: descriptor["arm"] === "sidecar" ? "sidecar" : "host",
              protocol: descriptor["protocol"],
              scopes: body["scopes"] as StoredRemote["scopes"],
              expiresAt: body["expiresAt"],
              sessionId: null,
              pairedAt: new Date(now()).toISOString(),
            })
          : {
              // Pair again: the bearer moved, the label, the last report and the
              // notified map stay (#699).
              ...existing,
              url,
              name: descriptor["name"],
              arm: descriptor["arm"] === "sidecar" ? "sidecar" : "host",
              protocol: descriptor["protocol"],
              scopes: body["scopes"] as StoredRemote["scopes"],
              expiresAt: body["expiresAt"],
              sessionId: null,
              pairedAt: new Date(now()).toISOString(),
            };
      store.put(record);
      // This session's id, for the devices list's own-row mark. Best effort.
      try {
        const self = await call(record, { method: "GET", path: REMOTE_ROUTES.session });
        const id = (self.body as { id?: unknown } | null)?.id;
        if (self.status === 200 && typeof id === "string")
          store.patch(deploymentId, { sessionId: id });
      } catch {
        // The supervisor will say what is wrong; the id is a nicety.
      }
      log(`[phoebe] paired with ${record.name} at ${url}${existing === null ? "" : " (again)"}.`);
      supervise(store.get(deploymentId)!);
      emitChanged();
      return {
        outcome: "paired",
        record: recordOf(store.get(deploymentId)!, readingOf(deploymentId)),
      };
    },

    async request(deploymentId, passthrough) {
      return call(held(deploymentId), passthrough);
    },

    async signOut(deploymentId) {
      const stored = held(deploymentId);
      retire(deploymentId);
      try {
        await call(stored, { method: "DELETE", path: REMOTE_ROUTES.session });
      } catch {
        // A deployment that cannot be reached is signed out of on this side
        // regardless; its row goes, and the session expires on its own.
      }
      vault.clear(deploymentId);
      store.remove(deploymentId);
      deps.alerts.forgetRemote(deploymentId);
      emitChanged();
    },

    async forget(deploymentId) {
      retire(deploymentId);
      vault.clear(deploymentId);
      store.remove(deploymentId);
      deps.alerts.forgetRemote(deploymentId);
      emitChanged();
    },

    async sessions(deploymentId) {
      const answer = await call(held(deploymentId), {
        method: "GET",
        path: REMOTE_ROUTES.sessions,
      });
      if (answer.status === 403) {
        throw new BridgeRefusal({
          code: "refused",
          message: "needs operate: this device paired with read only",
        });
      }
      if (answer.status !== 200) {
        throw new BridgeRefusal({
          code: "unknown",
          message: `the deployment answered ${answer.status}`,
        });
      }
      const rows = (answer.body as { sessions?: unknown } | null)?.sessions;
      return Array.isArray(rows) ? (rows as SessionRow[]) : [];
    },

    async revoke(deploymentId, sessionId) {
      const answer = await call(held(deploymentId), {
        method: "DELETE",
        path: `${REMOTE_ROUTES.sessions}/${encodeURIComponent(sessionId)}`,
      });
      if (answer.status === 204) return { outcome: "revoked" };
      if (answer.status === 409) return { outcome: "revoke-self" };
      if (answer.status === 404) return { outcome: "not-found" };
      if (answer.status === 403) return { outcome: "needs-operate" };
      return { outcome: "failed", detail: `the deployment answered ${answer.status}` };
    },

    followLogs(deploymentId) {
      const stored = held(deploymentId);
      return logs.follow(deploymentId, { url: stored.url, bearer: vault.read(deploymentId) });
    },

    stopLogs(deploymentId) {
      logs.stop(deploymentId);
    },

    start() {
      for (const stored of store.list()) supervise(stored);
    },

    poke() {
      for (const entry of live.values()) entry.supervisor.poke();
    },

    stop() {
      // Deleting from a Map mid-iteration is defined; the walk carries on.
      for (const deploymentId of live.keys()) retire(deploymentId);
      logs.stopAll();
    },
  };
}

/** The body as JSON, or null when it is not. */
async function bodyOf(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** The deployment's name off a report, when the report carries one. */
function nameOf(report: StoredReport): string | null {
  const identity = (report.report as { identity?: { name?: unknown } } | null)?.identity;
  return typeof identity?.name === "string" ? identity.name : null;
}

/** `macOS`, `Windows`, `Linux`, for the devices list. */
export function osLabel(platform: string = process.platform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return "Linux";
}
