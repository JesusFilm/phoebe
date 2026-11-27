// The sender half of OTLP forwarding (#993): each unit record an engine child
// reports becomes one POST to the collector the environment names
// (bootstrap/otlp.ts has the switch and the mapping).
//
// Only the bootstrapper sends, and only records that land while it runs: there
// is no backfill, and nothing is queued on disk. #73 made the container
// log-stateless, and a spool of undelivered traces would be the first log it
// kept. So delivery is best-effort with one retry:
//
//   - 429, 502, 503 and 504 are retried once, after `Retry-After` when the
//     collector sends one. So is a dropped connection.
//   - Anything else is dropped: a 400 will be a 400 again, and a partial success
//     must not be retried, by the OTLP spec.
//
// What happened is counted, and the counts ride in the deployment report's
// bootstrapper section as `telemetry`, so a console can say sends are failing
// without anyone reading the container's output.
//
// Nothing here may throw into the supervisor, and no send is awaited by it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TelemetryReport } from "../src/contracts/deployment.ts";
import type { UnitRecord } from "../src/contracts/unit-record.ts";
import { displayUrl, unitTraceRequest, type OtlpTarget } from "./otlp.ts";

/** How long one request may take before it counts as a dropped connection. */
export const OTLP_REQUEST_TIMEOUT_MS = 10_000;

/** The wait before the retry when the collector names none. */
export const OTLP_RETRY_DEFAULT_MS = 1_000;

/** The longest `Retry-After` honoured; a longer one is cut to this. */
export const OTLP_RETRY_MAX_MS = 30_000;

/** The statuses worth one retry, by the OTLP spec. */
const RETRYABLE = new Set([429, 502, 503, 504]);

export type TelemetryForwarderDeps = {
  target: OtlpTarget;
  /** Read per send: the id is minted onto the volume before the first record can land. */
  deploymentId: () => string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The counters moved. The deployment report's cue to publish. */
  onChange?: () => void;
};

export type TelemetryForwarder = {
  /** Send one record's trace. Returns at once; the send runs on its own. */
  forward: (record: UnitRecord) => void;
  /** The engine a launch materialized, whose `package.json` names `service.version`. */
  useEngine: (entry: string) => void;
  report: () => TelemetryReport;
  /** Every send in flight, settled. For tests and a clean shutdown. */
  idle: () => Promise<void>;
};

/**
 * The version in the `package.json` at the root of the engine checkout whose
 * CLI is `entry` (`<root>/src/cli.ts`), or `unknown` when it cannot be read.
 */
export function engineVersionAt(entry: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"),
    ) as Record<string, unknown>;
    return typeof pkg["version"] === "string" ? pkg["version"] : "unknown";
  } catch {
    return "unknown";
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date, capped. */
export function retryAfterMs(header: string | null, now: Date): number {
  if (header === null) return OTLP_RETRY_DEFAULT_MS;
  const trimmed = header.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return OTLP_RETRY_DEFAULT_MS;
    ms = at - now.getTime();
  }
  return Math.min(OTLP_RETRY_MAX_MS, Math.max(0, ms));
}

/** How one attempt ended. */
type Attempt =
  | { kind: "sent" }
  | { kind: "retry"; error: string; waitMs: number }
  | { kind: "dropped"; error: string };

/** The rejected-span count of a partial success, or 0 for a whole one. */
function rejectedSpans(body: string): { rejected: number; message: string } {
  try {
    const parsed = JSON.parse(body) as {
      partialSuccess?: { rejectedSpans?: string | number; errorMessage?: string };
    };
    const rejected = Number(parsed.partialSuccess?.rejectedSpans ?? 0);
    return {
      rejected: Number.isFinite(rejected) ? rejected : 0,
      message: parsed.partialSuccess?.errorMessage ?? "",
    };
  } catch {
    // An empty or non-JSON 200 is a whole success: there is nothing rejected to read.
    return { rejected: 0, message: "" };
  }
}

/** A fetch failure's cause, by code when it has one. Never the request: its headers hold the credential. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `no answer within ${OTLP_REQUEST_TIMEOUT_MS / 1000}s`;
    }
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    if (typeof cause?.code === "string") return `connection failed (${cause.code})`;
    if (typeof cause?.message === "string") return `connection failed (${cause.message})`;
    return `connection failed (${error.message})`;
  }
  return `connection failed (${String(error)})`;
}

export function createTelemetryForwarder(deps: TelemetryForwarderDeps): TelemetryForwarder {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => new Date());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const where = displayUrl(deps.target.url);
  let engineVersion = "unknown";
  const counters: TelemetryReport = { sent: 0, dropped: 0, lastError: null, lastSentAt: null };
  const inFlight = new Set<Promise<void>>();

  const changed = (): void => {
    try {
      deps.onChange?.();
    } catch {
      // The report is the supervisor's business; a send is not where it fails.
    }
  };

  const attempt = async (body: string): Promise<Attempt> => {
    let response: Response;
    try {
      response = await fetchFn(deps.target.url, {
        method: "POST",
        headers: { ...deps.target.headers, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(OTLP_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: "retry", error: describeFailure(error), waitMs: OTLP_RETRY_DEFAULT_MS };
    }
    let text = "";
    try {
      text = await response.text();
    } catch {
      // A body that will not read leaves the status to decide.
    }
    if (response.ok) {
      const { rejected, message } = rejectedSpans(text);
      if (rejected > 0) {
        return {
          kind: "dropped",
          error: `${where} rejected ${rejected} span(s)${message === "" ? "" : `: ${message}`}`,
        };
      }
      return { kind: "sent" };
    }
    const error = `${where} answered HTTP ${response.status}`;
    if (RETRYABLE.has(response.status)) {
      return {
        kind: "retry",
        error,
        waitMs: retryAfterMs(response.headers.get("retry-after"), now()),
      };
    }
    return { kind: "dropped", error };
  };

  const deliver = async (record: UnitRecord): Promise<void> => {
    const request = unitTraceRequest(record, {
      deploymentId: deps.deploymentId(),
      engineVersion,
      target: deps.target,
      recordedAt: now(),
    });
    if (request === null) {
      counters.dropped += 1;
      counters.lastError = `a ${record.unit.kind} record had no readable start time`;
      changed();
      return;
    }
    const body = JSON.stringify(request);
    let outcome = await attempt(body);
    if (outcome.kind === "retry") {
      await sleep(outcome.waitMs);
      outcome = await attempt(body);
    }
    if (outcome.kind === "sent") {
      counters.sent += 1;
      counters.lastError = null;
      counters.lastSentAt = now().toISOString();
    } else {
      counters.dropped += 1;
      counters.lastError = outcome.error;
    }
    changed();
  };

  return {
    forward(record) {
      const send = deliver(record)
        .catch((error: unknown) => {
          counters.dropped += 1;
          counters.lastError = describeFailure(error);
          changed();
        })
        .finally(() => inFlight.delete(send));
      inFlight.add(send);
    },
    useEngine(entry) {
      engineVersion = engineVersionAt(entry);
    },
    report: () => ({ ...counters }),
    idle: async () => {
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
}
