// What `phoebe boot` does about the `remote` block (map #690) — the whole of
// it, so boot.ts gains a call rather than a policy.
//
// Two phases, because the report and the listener each need the other. The
// report's identity has to exist before the live model is built — it carries
// the deployment id now — and the listener has to report into that model once
// it does. So `prepareRemote` answers "who is this deployment" from the volume,
// and `start` opens the listener and the two drops and begins learning the URL.
//
// **How the deployment learns its URL.** On the sidecar arm it asks LocalAPI
// over the shared socket, on a timer until the node is Running and has a name,
// and again after any failure. On the host arm the container has no Tailscale
// of its own: `phoebe start` reconciled Serve on the host and wrote the URL
// into `state/remote-url` through an exec, and this reads that file.
//
// **The two drops.** The mint drop is root-only (mint-drop.ts): a file the
// bootstrapper reads only when uid 0 wrote it, carrying a code's hash into the
// pending map. The revoke drop is uid 10001's own, under `state/`: `phoebe
// sessions revoke` asks through it so the bootstrapper stays the one process
// that writes the sessions file, which is what keeps the tampered flag honest.
//
// No `remote` block: none of this runs beyond minting the deployment id, the
// report's remote section says `configured: false`, and the deployment is the
// deployment it was before this file existed.

import { statSync } from "node:fs";
import { join } from "node:path";
import { readRemoteLeniently, type ResolvedRemote } from "../src/config-schema.ts";
import type {
  DeploymentArm,
  DeploymentIdentity,
  HostPlatform,
} from "../src/contracts/deployment.ts";
import { REMOTE_PROTOCOL, type RemoteDescriptor } from "../src/contracts/remote-protocol.ts";
import { readRemoteUrl } from "../src/remote-url.ts";
import { readOrMintDeploymentId } from "./deployment-id.ts";
import { deploymentReportPath } from "./deployment-report.ts";
import type { DeploymentState } from "./deployment-state.ts";
import { watchDrop, type DropWatcher } from "./file-drop.ts";
import { MINT_DROP_DIR } from "./mint-drop.ts";
import { createPendingCodes, parsePendingCode, type PendingCodes } from "./pairing-codes.ts";
import { createRemoteApi, type ApiLogs, type RemoteApi, type RemoteVerbs } from "./remote-api.ts";
import { createSessions, type Sessions } from "./remote-sessions.ts";
import {
  localApiGet,
  readLocalApiStatus,
  tailnetUrlOf,
  type LocalApiGet,
} from "./tailscale-localapi.ts";

/** Where the bootstrapper acknowledges a mint, under its own `state/`. */
export function mintAckDir(dataBase: string): string {
  return join(dataBase, "state", "mint-ack");
}

/** Where `phoebe sessions revoke` asks, and where the answer lands. */
export function revokeDropDir(dataBase: string): string {
  return join(dataBase, "state", "sessions-revoke");
}
export function revokeAckDir(dataBase: string): string {
  return join(dataBase, "state", "sessions-revoke-ack");
}

/** How often the URL is asked for before the deployment has one. */
export const URL_POLL_MS = 10_000;
/** How often it is re-read once it has one, in case the node was renamed. */
export const URL_RECHECK_MS = 5 * 60_000;
/** How often the session counts are re-published, so expiry rolls through. */
export const COUNTS_REFRESH_MS = 60_000;

export type PrepareRemoteOptions = {
  rootConfig: unknown;
  dataBase: string;
  name: string;
  arm: DeploymentArm;
  host: HostPlatform;
  /** The bootstrapper's own version, for the descriptor. */
  version: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** Injected by the tests; production opens a real listener. */
  deps?: {
    api?: (verbs: RemoteVerbs, logs: ApiLogs | undefined) => RemoteApi;
    localApi?: LocalApiGet;
    readHostUrl?: () => string | null;
    setInterval?: (fn: () => void, ms: number) => { clear: () => void };
    sessions?: Sessions;
    pending?: PendingCodes;
    watchDrop?: typeof watchDrop;
    now?: () => number;
  };
};

export type PreparedRemote = {
  /** The report's identity section, with the deployment id. */
  identity: () => DeploymentIdentity;
  /** The resolved block, or undefined with none. */
  remote: ResolvedRemote | undefined;
  /**
   * Open the listener, the drops and the URL learner. A no-op with no block.
   * `logs` is the container's output for `GET /api/logs`, already redacted;
   * without it the route answers 404.
   */
  start: (deployment: DeploymentState, verbs: RemoteVerbs, logs?: ApiLogs) => Promise<void>;
  /** The report moved: wake every open stream. */
  push: () => void;
  /** Close everything; the deployment is going down. */
  stop: () => Promise<void>;
  /** The listener, once started; null before and with no block. */
  api: () => RemoteApi | null;
};

export function prepareRemote(options: PrepareRemoteOptions): PreparedRemote {
  const log = options.log ?? (() => {});
  const warn = options.warn ?? log;
  const now = options.deps?.now ?? Date.now;
  const setTimer = options.deps?.setInterval ?? defaultInterval;
  const deploymentId = readOrMintDeploymentId(options.dataBase);
  const remote = readRemoteLeniently(options.rootConfig);
  if (
    remote === undefined &&
    typeof options.rootConfig === "object" &&
    options.rootConfig !== null &&
    (options.rootConfig as { remote?: unknown }).remote !== undefined
  ) {
    warn(
      "[phoebe] boot: ignoring the `remote` block — it does not validate; nothing will listen. " +
        "`phoebe doctor` names the problem.",
    );
  }

  const listeners = new Set<() => void>();
  let api: RemoteApi | null = null;
  let url: string | null = null;
  let timers: { clear: () => void }[] = [];
  let watchers: DropWatcher[] = [];

  const descriptor = (): RemoteDescriptor => ({
    deploymentId,
    name: options.name,
    protocol: REMOTE_PROTOCOL,
    version: options.version,
    arm: remote?.arm ?? "host",
  });

  return {
    identity: () => ({ name: options.name, deploymentId, arm: options.arm, host: options.host }),
    remote,
    api: () => api,

    async start(deployment, verbs, logs) {
      if (remote === undefined) return;
      const store =
        options.deps?.sessions ??
        createSessions(options.dataBase, {
          onTampered: (path) => {
            warn(
              `[phoebe] boot: ${path} differs from what this bootstrapper last wrote — a session ` +
                `row was added or changed by another hand. The report says tampered; read the devices list.`,
            );
            publish();
          },
          onMalformed: (path) =>
            warn(`[phoebe] boot: ${path} will not parse — reading it as nobody paired.`),
        });
      const pending = options.deps?.pending ?? createPendingCodes();

      const publish = (): void => {
        deployment.noteRemote({
          configured: true,
          arm: remote.arm,
          url,
          sessions: store.counts(new Date(now())),
          tampered: store.tampered(),
          ...(api !== null
            ? {
                pairRejections: {
                  lastMinute: api.rejections().count,
                  refusing: api.rejections().exhausted,
                },
              }
            : {}),
        });
      };

      const build =
        options.deps?.api ??
        ((v: RemoteVerbs, output: ApiLogs | undefined) =>
          createRemoteApi({
            descriptor,
            sessions: store,
            pending,
            report: () => ({
              report: deployment.latest(),
              builtAt: reportBuiltAt(options.dataBase),
            }),
            onReport: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            ...(output === undefined ? {} : { logs: output }),
            verbs: v,
            now,
            log,
          }));
      api = build(verbs, logs);
      // Pairs and revokes move the counts; the API tells nobody, so the section
      // is re-published on a short clock rather than on each.
      publish();
      try {
        const { where } = await api.listen(
          remote.arm === "sidecar" ? { arm: "sidecar" } : { arm: "host" },
        );
        log(
          remote.arm === "host"
            ? `[phoebe] boot: deployment API listening on the container's ${where}, published on the host's 127.0.0.1:${remote.port} (host arm).`
            : `[phoebe] boot: deployment API listening on ${where} (sidecar arm).`,
        );
      } catch (error) {
        warn(
          `[phoebe] boot: the deployment API could not listen — ${describe(error)}. Nothing is reachable.`,
        );
      }

      // The mint drop (#695): root-only by the owner check.
      const watch = options.deps?.watchDrop ?? watchDrop;
      watchers.push(
        watch({
          dir: MINT_DROP_DIR,
          ackDir: mintAckDir(options.dataBase),
          requireUid: 0,
          log,
          onFile: ({ content }) => {
            const code = parsePendingCode(content);
            if (code === null) throw new Error("the drop file is not a pending code");
            if (!pending.add(code, now())) {
              throw new Error(
                `the deployment already holds ${pending.size(now())} pending codes — spend one, or wait five minutes`,
              );
            }
            log(
              `[phoebe] boot: a pairing code is pending (${code.scopes.join("+")}, until ${code.expiresAt}).`,
            );
            return "ok";
          },
        }),
      );
      // The revoke drop (#696): uid 10001's own, so the bootstrapper writes the store.
      watchers.push(
        watch({
          dir: revokeDropDir(options.dataBase),
          ackDir: revokeAckDir(options.dataBase),
          log,
          onFile: ({ content }) => {
            const ask = parseRevokeAsk(content);
            if (ask === null) throw new Error("the drop file is not a revoke request");
            let count: number;
            if (ask.all) count = store.revokeAll();
            else count = store.revoke(ask.id) ? 1 : 0;
            if (ask.all) api?.close().catch(() => {});
            else if (count > 0) api?.closeStreams(ask.id);
            log(`[phoebe] boot: ${count} session(s) revoked by phoebe sessions (shell).`);
            publish();
            return `ok ${count}`;
          },
        }),
      );

      // The URL.
      const learn = async (): Promise<void> => {
        let next: string | null = null;
        if (remote.arm === "sidecar") {
          const get = options.deps?.localApi ?? localApiGet();
          next = tailnetUrlOf(await readLocalApiStatus(get));
        } else {
          next = (options.deps?.readHostUrl ?? (() => readRemoteUrl(options.dataBase)))();
        }
        if (next !== url) {
          url = next;
          log(
            url === null
              ? "[phoebe] boot: the tailnet URL is not known yet."
              : `[phoebe] boot: reachable at ${url}.`,
          );
          publish();
        }
      };
      await learn();
      timers.push(setTimer(() => void learn(), URL_POLL_MS));
      timers.push(setTimer(publish, COUNTS_REFRESH_MS));
    },

    push() {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A dead stream drops its own listener on close.
        }
      }
    },

    async stop() {
      for (const timer of timers) timer.clear();
      timers = [];
      for (const watcher of watchers) watcher.stop();
      watchers = [];
      if (api !== null) await api.close();
      api = null;
    },
  };
}

/** The report file's mtime, which is what `builtAt` means. */
function reportBuiltAt(dataBase: string): string | null {
  try {
    return statSync(deploymentReportPath(dataBase)).mtime.toISOString();
  } catch {
    return null;
  }
}

/** `{ id }` or `{ all: true }`, as `phoebe sessions revoke` writes it. */
export function parseRevokeAsk(raw: string): { all: true } | { all: false; id: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["all"] === true) return { all: true };
  if (typeof record["id"] === "string" && record["id"].length > 0)
    return { all: false, id: record["id"] };
  return null;
}

function defaultInterval(fn: () => void, ms: number): { clear: () => void } {
  const handle = setInterval(fn, ms);
  handle.unref?.();
  return { clear: () => clearInterval(handle) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
