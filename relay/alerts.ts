// Alerting on the relay: `alerts.json`, the edge sweep, and the webhook that
// carries an edge out of the process (#515, amended by #524 §1).
//
// The rule that decides what has changed is not here — it is a pure function in
// contracts (src/contracts/alerts.ts), shared with the companion. What is here
// is everything that rule cannot be: a file, a clock, and a POST.
//
// **The relay always evaluates.** An absent `RELAY_ALERT_WEBHOOK` means there
// is no webhook, not that there is no evaluation (#524 §1): the sweep runs, the
// edges are computed, and `alerts.json` moves either way, because the SSE
// `alert` event is the other sink and it is not configurable. A relay with no
// sinks at all still keeps its bookkeeping straight, so adding a webhook later
// does not replay everything that has happened since boot.
//
// **`alerts.json` is edge bookkeeping, never a log** (#515 §6). One entry per
// (deployment, condition), holding the last state actually notified. It is
// bounded by the fleet, it is never rendered as a history, and forgetting a
// deployment deletes its entries outright — which is also why forgetting sends
// no clear (#515 §5).
//
// **Written after the attempt, not after success** (#515 §12). One try, a five
// second cap, no retry queue, and a failure logged at warn naming the
// condition. Recording on success instead would turn a webhook outage into a
// storm of everything it missed the moment it came back, and the relay is not a
// pager with a spool — a lost alert is visible in this log and in the console's
// own state.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  alertEdges,
  alertMessage,
  alertTestMessage,
  type AlertBody,
  type AlertEdge,
  type ConnectionAlertFacts,
  type LastAlert,
  type NotifiedAlerts,
  type RelayAlertFacts,
  type ReportAlertFacts,
} from "../src/contracts/alerts.ts";

/** The file's name on the relay volume, beside `links.json`. */
export const ALERTS_FILENAME = "alerts.json";

/** How long one webhook POST gets before it is abandoned (#515 §12). */
export const ALERT_WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * The file's shape. An object keyed by fingerprint, so forgetting one
 * deployment is one `delete` and the whole file is one read.
 */
export type AlertsFile = { deployments: Record<string, NotifiedAlerts> };

export type AlertStore = {
  /** What was last notified for one deployment. `{}` for one never alerted on. */
  notified: (fingerprint: string) => NotifiedAlerts;
  /**
   * Record the attempt. Called after the sends, whether or not any of them
   * worked, which is the whole of #515 §12.
   */
  record: (fingerprint: string, edges: readonly AlertEdge[], at: Date) => void;
  /** The most recent attempt per deployment — the console's "last alert" line. */
  last: () => Record<string, LastAlert>;
  /** Drop everything held for a forgotten deployment. Sends nothing. */
  drop: (fingerprint: string) => void;
};

/** Open `alerts.json` on `dataDir`. Reads are lazy; writes are atomic. */
export function createAlertStore(dataDir: string): AlertStore {
  const path = join(dataDir, ALERTS_FILENAME);

  /** A missing, unreadable or malformed file is a relay that has notified nothing. */
  function read(): AlertsFile {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AlertsFile>;
      const { deployments } = parsed;
      if (typeof deployments !== "object" || deployments === null) return { deployments: {} };
      return { deployments: deployments as Record<string, NotifiedAlerts> };
    } catch {
      return { deployments: {} };
    }
  }

  /** Through a sibling temp file and `rename`, as `links.json` is written. */
  function write(file: AlertsFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${process.pid}.${ALERTS_FILENAME}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  return {
    notified: (fingerprint) => read().deployments[fingerprint] ?? {},

    record(fingerprint, edges, at) {
      if (edges.length === 0) return;
      const file = read();
      const entries = file.deployments[fingerprint] ?? {};
      for (const edge of edges) {
        entries[edge.key] = { state: edge.state, at: at.toISOString(), since: edge.since };
      }
      file.deployments[fingerprint] = entries;
      write(file);
    },

    last() {
      const latest: Record<string, LastAlert> = {};
      for (const [fingerprint, entries] of Object.entries(read().deployments)) {
        for (const [key, entry] of Object.entries(entries)) {
          const standing = latest[fingerprint];
          if (standing !== undefined && standing.at >= entry.at) continue;
          latest[fingerprint] = { ...splitKey(key), state: entry.state, at: entry.at };
        }
      }
      return latest;
    },

    drop(fingerprint) {
      const file = read();
      if (!(fingerprint in file.deployments)) return;
      delete file.deployments[fingerprint];
      write(file);
    },
  };
}

/**
 * `wedged:youtube-studio/sentry` back into its two halves. The store writes
 * these keys through `alertKeyOf`, so the split is the inverse of one
 * separator; an unrecognised key is read as a whole-deployment condition, which
 * is the harmless reading.
 */
function splitKey(key: string): { condition: LastAlert["condition"]; pipeline: string | null } {
  const colon = key.indexOf(":");
  if (colon === -1) return { condition: key as LastAlert["condition"], pipeline: null };
  return {
    condition: key.slice(0, colon) as LastAlert["condition"],
    pipeline: key.slice(colon + 1),
  };
}

/**
 * One place an alert goes. The webhook is one (`webhookSink`); the SSE stream
 * is the other, and it registers itself the same way (#524 §1). A sink that
 * throws or rejects is that sink's problem: the notifier catches it, logs it,
 * and goes on to the next one, because one broken sink must not swallow the
 * edge for the others.
 */
export type AlertSink = {
  /** What the log calls it when a send fails. */
  readonly name: string;
  send: (body: AlertBody) => Promise<void> | void;
};

export type AlertNotifierOptions = {
  store: AlertStore;
  /**
   * Where the relay holds each link right now, with the silence clock the dark
   * debounce reads (relay/connection.ts).
   */
  connections: (now: Date) => ConnectionAlertFacts[];
  /**
   * The last report the relay holds for one deployment, projected onto what the
   * rule reads. Absent while the relay stores no reports, and absent is not a
   * stub: it is the honest answer that leaves `wedged`, `crash-looping` and
   * `doctor-fail` silent rather than guessed (#542 lands the store).
   */
  report?: (fingerprint: string) => ReportAlertFacts | null;
  /** Every sink, in the order they are tried. May be empty (#524 §1). */
  sinks: readonly AlertSink[];
  /**
   * Is a webhook among them? Passed rather than inferred: the panel says
   * "webhook configured / not configured" (#515 §13) and the honest source for
   * that is the environment the relay read, not a guess at what a sink is.
   */
  webhook: boolean;
  /** The console's origin, for the `url` every body deep-links with. */
  consoleOrigin: string;
  /**
   * The dark debounce, passed through to the rule. A parameter only so a test
   * can watch five minutes pass in a few milliseconds.
   */
  darkAfterMs?: number;
  clock?: () => Date;
  warn?: (message: string) => void;
};

export type AlertNotifier = {
  /**
   * Evaluate every link's edges and send what moved. Safe to call as often as
   * anything happens: the ordinary pass finds nothing and writes nothing.
   */
  sweep: (now?: Date) => Promise<AlertEdge[]>;
  /** Post a `{ kind: "test" }` body to every sink (#515 §13). */
  test: (by: string, now?: Date) => Promise<{ sinks: number }>;
  /** A forgotten deployment's entries go, and no clear is sent (#515 §5). */
  forget: (fingerprint: string) => void;
  /** What the connection panel shows about alerting (#515 §13). */
  facts: () => RelayAlertFacts;
};

/**
 * Build the notifier. Nothing starts a timer here — the caller decides when to
 * sweep, and it needs to do so on its own clock as well as on connection
 * changes, because **nothing happens when a deployment goes dark**. Silence is
 * the event, and only a timer can observe it.
 */
export function createAlertNotifier(options: AlertNotifierOptions): AlertNotifier {
  const clock = options.clock ?? (() => new Date());
  const warn = options.warn ?? (() => {});
  const report = options.report ?? (() => null);

  /** Hand one body to every sink, and let no sink's failure reach the caller. */
  async function fanOut(body: AlertBody, what: string): Promise<void> {
    for (const sink of options.sinks) {
      try {
        await sink.send(body);
      } catch (error) {
        warn(`[phoebe:relay] ${sink.name} did not take ${what}: ${messageOf(error)}`);
      }
    }
  }

  return {
    async sweep(now = clock()) {
      const sent: AlertEdge[] = [];
      for (const connection of options.connections(now)) {
        const edges = alertEdges({
          facts: { ...connection, report: report(connection.fingerprint) },
          notified: options.store.notified(connection.fingerprint),
          now: now.toISOString(),
          ...(options.darkAfterMs !== undefined ? { darkAfterMs: options.darkAfterMs } : {}),
        });
        if (edges.length === 0) continue;
        for (const edge of edges) {
          const body = alertMessage({
            edge,
            deployment: { name: connection.name, fingerprint: connection.fingerprint },
            consoleOrigin: options.consoleOrigin,
          });
          await fanOut(body, `${edge.condition} ${edge.state} for ${connection.name}`);
          sent.push(edge);
        }
        // After the attempt, never after the success (#515 §12).
        options.store.record(connection.fingerprint, edges, clock());
      }
      return sent;
    },

    async test(by, now = clock()) {
      await fanOut(
        alertTestMessage({ by, at: now.toISOString(), consoleOrigin: options.consoleOrigin }),
        "the test alert",
      );
      return { sinks: options.sinks.length };
    },

    forget: (fingerprint) => options.store.drop(fingerprint),

    facts: () => ({ webhook: options.webhook, last: options.store.last() }),
  };
}

/** The POST, as a `fetch` this repo can hand a fake. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The generic webhook (#515 §2). One attempt, a five-second cap, no signing —
 * the URL is the secret, as every incoming-webhook product treats it — and a
 * non-2xx answer is a warn and nothing more.
 *
 * The URL never appears in a log line. An operator reading their own relay's
 * stderr over someone's shoulder should not be handing out the one credential
 * this feature has.
 */
export function webhookSink(
  url: string,
  deps: {
    fetchFn?: FetchLike;
    timeoutMs?: number;
  } = {},
): AlertSink {
  const fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? ALERT_WEBHOOK_TIMEOUT_MS;
  return {
    name: "the alert webhook",
    async send(body) {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`answered ${response.status}`);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
