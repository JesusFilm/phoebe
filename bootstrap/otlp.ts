// Unit records as OTLP spans (#993, decided in #979, conventions in #984).
//
// Two halves, both pure. **The switch**: forwarding is on when the
// bootstrapper's environment names a collector through the standard
// `OTEL_EXPORTER_OTLP_*` variables, and there is no config field. **The
// mapping**: one unit record becomes one OTLP/HTTP JSON trace request. The
// sender that posts it is bootstrap/telemetry-forwarder.ts; `phoebe doctor`
// reads the switch from here too, so the check and the sender cannot disagree
// about where traces go.
//
// The shape of a trace:
//
//   - A `unit {kind}` root span, kind INTERNAL, from `startedAt` to `settledAt`
//     (to the moment the record arrived, for an abandoned unit, which has no
//     settle time).
//   - One `invoke_agent {kind}` child span per agent run, kind CLIENT, the
//     GenAI convention for an agent outside the process.
//
// IDs are derived, never random: the trace ID hashes the deployment, the cell,
// the unit and its start, and each span ID hashes the trace ID and the span's
// index. Sending one record twice gives one trace twice, which a collector
// folds together, never two traces.
//
// What never leaves: `detail` and `branch`, which can hold free text and issue
// titles. Every attribute below is named one by one, so a field added to the
// record later is not sent until someone adds it here.
//
// Every `gen_ai.*` name is at Development status. The scope's schema URL pins
// the release they were read from; a rename ships in a release whose changeset
// lists it.

import { createHash } from "node:crypto";
import type { AgentRunRecord, UnitRecord } from "../src/contracts/unit-record.ts";

/** The instrumentation scope every span is sent under. */
export const OTLP_SCOPE_NAME = "phoebe-agent";

/** semantic-conventions-genai v0.1.0, the release every `gen_ai.*` name below is from. */
export const OTLP_SCHEMA_URL = "https://opentelemetry.io/schemas/semconv-genai-dev/0.1.0-dev";

/** `service.name` when neither `OTEL_SERVICE_NAME` nor the resource attributes set one. */
export const OTLP_DEFAULT_SERVICE_NAME = "phoebe";

/** The only `*_PROTOCOL` value Phoebe speaks. */
export const OTLP_SUPPORTED_PROTOCOL = "http/json";

/** Every variable the switch reads, in the order the compose file passes them. */
export const OTLP_ENV_NAMES = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;

/**
 * Every `OTEL_*` key set in `env`. A solo engine child inherits the
 * supervisor's env, and these are taken out of it: the headers hold the
 * collector's credential, and only the bootstrapper sends.
 */
export function otelEnvKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((key) => key.startsWith("OTEL_"));
}

/** Where traces go and how, as the environment says. */
export type OtlpTarget = {
  /** The full `/v1/traces` URL a request is posted to. */
  url: string;
  /** Which variable named it. */
  from: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" | "OTEL_EXPORTER_OTLP_ENDPOINT";
  /** From `OTEL_EXPORTER_OTLP_HEADERS`. Holds the collector's credential: never logged. */
  headers: Record<string, string>;
  /**
   * The `*_PROTOCOL` value, traces-specific over general, when it is one Phoebe
   * does not speak. Requests still go out as JSON — a collector's HTTP receiver
   * takes JSON and protobuf on the same port — and doctor says so.
   */
  unsupportedProtocol: string | null;
  /** `service.name`, after `OTEL_SERVICE_NAME` and the resource attributes. */
  serviceName: string | null;
  /** `OTEL_RESOURCE_ATTRIBUTES`, parsed. */
  resourceAttributes: Record<string, string>;
};

type Env = Record<string, string | undefined>;

function set(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? null : value;
}

/**
 * A `k1=v1,k2=v2` list, the format both `*_HEADERS` and
 * `OTEL_RESOURCE_ATTRIBUTES` use. Values are percent-decoded; a pair with no
 * `=` or an empty key is skipped rather than failing the whole list.
 */
export function parseKeyValueList(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null) return out;
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    if (key === "") continue;
    const value = pair.slice(at + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The collector the environment names, or null when forwarding is off. The
 * traces endpoint is used exactly as given; the general one is a base URL that
 * `v1/traces` is appended to, as the OTLP exporter spec says.
 */
export function resolveOtlpTarget(env: Env): OtlpTarget | null {
  const traces = set(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  const base = set(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  let url: string;
  let from: OtlpTarget["from"];
  if (traces !== null) {
    url = traces;
    from = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
  } else if (base !== null) {
    url = `${base.endsWith("/") ? base : `${base}/`}v1/traces`;
    from = "OTEL_EXPORTER_OTLP_ENDPOINT";
  } else {
    return null;
  }
  const protocol =
    set(env, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL") ?? set(env, "OTEL_EXPORTER_OTLP_PROTOCOL");
  const resourceAttributes = parseKeyValueList(set(env, "OTEL_RESOURCE_ATTRIBUTES"));
  return {
    url,
    from,
    headers: parseKeyValueList(set(env, "OTEL_EXPORTER_OTLP_HEADERS")),
    unsupportedProtocol:
      protocol !== null && protocol !== OTLP_SUPPORTED_PROTOCOL ? protocol : null,
    serviceName: set(env, "OTEL_SERVICE_NAME") ?? resourceAttributes["service.name"] ?? null,
    resourceAttributes,
  };
}

/**
 * A URL fit to print: scheme, host, port and path. Userinfo and the query go,
 * since either can carry a credential.
 */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "(not a URL)";
  }
}

// ---------------------------------------------------------------------------
// The mapping.

/** An OTLP `AnyValue`, as the JSON encoding spells it. */
export type OtlpValue =
  | { stringValue: string }
  | { boolValue: boolean }
  /** 64-bit, so a decimal string. */
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpValue[] } };

export type OtlpAttribute = { key: string; value: OtlpValue };

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  /** Absent on the root span. */
  parentSpanId?: string;
  name: string;
  /** INTERNAL is 1, CLIENT is 3. */
  kind: 1 | 3;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  /** UNSET is 0, ERROR is 2. Phoebe never sets OK. */
  status: { code: 0 | 2 };
};

/** One `/v1/traces` request body. */
export type OtlpTraceRequest = {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: {
      scope: { name: string; version: string };
      schemaUrl: string;
      spans: OtlpSpan[];
    }[];
  }[];
};

/** What the mapping needs beyond the record itself. */
export type TraceContext = {
  deploymentId: string;
  /** The engine's own version, `service.version` and the scope version. */
  engineVersion: string;
  target: Pick<OtlpTarget, "serviceName" | "resourceAttributes">;
  /** When the record arrived: the end of an abandoned unit's span. */
  recordedAt: Date;
};

/** The `gen_ai.provider.name` well-known value for each provider Phoebe drives. */
const PROVIDER_NAMES: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
};

/** A provider as the GenAI conventions name it; one Phoebe does not know passes through. */
export function genAiProvider(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The trace ID: the first 16 bytes of a SHA-256 over the deployment, the cell
 * (tenant and pipeline), the unit and its start, NUL-separated so no two
 * different tuples can join into the same input.
 */
export function traceIdOf(deploymentId: string, record: UnitRecord): string {
  return sha256(
    [
      deploymentId,
      record.tenant,
      record.pipeline,
      record.unit.kind,
      record.unit.id,
      record.startedAt,
    ].join("\u0000"),
  ).slice(0, 32);
}

/** A span ID: 8 bytes from the trace ID and an index. The root is 0, agent run `i` is `i + 1`. */
export function spanIdOf(traceId: string, index: number): string {
  return sha256(`${traceId}\u0000${index}`).slice(0, 16);
}

/** Unix nanoseconds as the decimal string OTLP/JSON wants. */
function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

/** Builds an attribute list and leaves out every null, so an unknown is never sent as a value. */
class Attributes {
  readonly list: OtlpAttribute[] = [];
  string(key: string, value: string | null): this {
    if (value !== null) this.list.push({ key, value: { stringValue: value } });
    return this;
  }
  int(key: string, value: number | null): this {
    if (value !== null && Number.isFinite(value)) {
      this.list.push({ key, value: { intValue: String(Math.trunc(value)) } });
    }
    return this;
  }
  double(key: string, value: number | null): this {
    if (value !== null && Number.isFinite(value)) {
      this.list.push({ key, value: { doubleValue: value } });
    }
    return this;
  }
  bool(key: string, value: boolean): this {
    this.list.push({ key, value: { boolValue: value } });
    return this;
  }
  strings(key: string, values: readonly string[]): this {
    if (values.length > 0) {
      const array = values.map((value) => ({ stringValue: value }));
      this.list.push({ key, value: { arrayValue: { values: array } } });
    }
    return this;
  }
}

/** The outcomes that put ERROR on the unit span. */
const ERROR_OUTCOMES = new Set(["failed", "timed-out", "abandoned"]);

function unitSpan(record: UnitRecord, traceId: string, startMs: number, endMs: number): OtlpSpan {
  const failed = ERROR_OUTCOMES.has(record.outcome);
  const attributes = new Attributes()
    .string("phoebe.tenant", record.tenant)
    .string("phoebe.pipeline", record.pipeline)
    .string("phoebe.kind", record.unit.kind)
    .string("phoebe.unit", record.unit.id)
    .string("phoebe.outcome", record.outcome)
    .bool("phoebe.quarantined", record.quarantined)
    .int("phoebe.run_budget_ms", record.runBudgetMs)
    .string("phoebe.effort", record.effort)
    .int("phoebe.pr_number", record.prNumber)
    .string("phoebe.head_sha", record.headSha)
    .string("phoebe.engine_commit", record.engineCommit)
    .string(
      "gen_ai.provider.name",
      record.provider === null ? null : genAiProvider(record.provider),
    )
    .string("gen_ai.request.model", record.model)
    .string("error.type", failed ? record.outcome : null);
  return {
    traceId,
    spanId: spanIdOf(traceId, 0),
    name: `unit ${record.unit.kind}`,
    kind: 1,
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(endMs),
    attributes: attributes.list,
    status: { code: failed ? 2 : 0 },
  };
}

/** Input tokens as the convention counts them: uncached, cache reads and cache writes together. */
function inputTokens(run: AgentRunRecord): number | null {
  if (run.inputTokens === null) return null;
  return run.inputTokens + (run.cacheReadTokens ?? 0) + (run.cacheWriteTokens ?? 0);
}

function nonZero(value: number | null): number | null {
  return value === null || value === 0 ? null : value;
}

function runSpan(
  record: UnitRecord,
  run: AgentRunRecord,
  index: number,
  traceId: string,
): OtlpSpan | null {
  const startMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startMs)) return null;
  // A run that never exited, or exited non-zero, is an error; its type is the
  // exit code, or `no_exit` when there was none to read.
  const errorType =
    run.exitCode === null ? "no_exit" : run.exitCode !== 0 ? String(run.exitCode) : null;
  const toolCalls = Object.values(run.toolCalls).reduce((sum, count) => sum + count, 0);
  const attributes = new Attributes()
    .string("gen_ai.operation.name", "invoke_agent")
    .string("gen_ai.agent.name", record.unit.kind)
    .string(
      "gen_ai.provider.name",
      record.provider === null ? null : genAiProvider(record.provider),
    )
    .string("gen_ai.request.model", record.model)
    .int("gen_ai.usage.input_tokens", inputTokens(run))
    .int("gen_ai.usage.output_tokens", run.outputTokens)
    .int("gen_ai.usage.cache_read.input_tokens", nonZero(run.cacheReadTokens))
    .int("gen_ai.usage.cache_write.input_tokens", nonZero(run.cacheWriteTokens))
    .int("gen_ai.usage.reasoning.output_tokens", run.reasoningTokens)
    .double("phoebe.agent_run.cost_usd", run.costUsd)
    .string("phoebe.agent_run.cost_basis", run.costBasis)
    .int("phoebe.agent_run.turns", run.turns)
    .string("phoebe.agent_run.stop_reason", run.stopReason)
    .bool("phoebe.agent_run.usage_complete", run.usageComplete)
    .int("phoebe.agent_run.exit_code", run.exitCode)
    .string("phoebe.agent_run.prompt_sha", run.promptSha)
    .strings("phoebe.agent_run.reported_models", run.reportedModels)
    .int("phoebe.agent_run.tool_calls", toolCalls)
    .string("error.type", errorType);
  return {
    traceId,
    spanId: spanIdOf(traceId, index + 1),
    parentSpanId: spanIdOf(traceId, 0),
    name: `invoke_agent ${record.unit.kind}`,
    kind: 3,
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(startMs + Math.max(0, run.durationMs)),
    attributes: attributes.list,
    status: { code: errorType === null ? 0 : 2 },
  };
}

/** The resource every span rides under, defaults first and the environment over them. */
function resourceAttributes(context: TraceContext): OtlpAttribute[] {
  const merged: Record<string, string> = {
    "service.name": OTLP_DEFAULT_SERVICE_NAME,
    "service.version": context.engineVersion,
    "service.instance.id": context.deploymentId,
    ...context.target.resourceAttributes,
  };
  if (context.target.serviceName !== null) merged["service.name"] = context.target.serviceName;
  return Object.entries(merged).map(([key, value]) => ({ key, value: { stringValue: value } }));
}

/**
 * One unit record as one `/v1/traces` request, or null when its start time does
 * not parse — there is no span to time without one.
 */
export function unitTraceRequest(
  record: UnitRecord,
  context: TraceContext,
): OtlpTraceRequest | null {
  const startMs = Date.parse(record.startedAt);
  if (!Number.isFinite(startMs)) return null;
  const settledMs = record.settledAt === null ? Number.NaN : Date.parse(record.settledAt);
  const endMs = Math.max(
    startMs,
    Number.isFinite(settledMs) ? settledMs : context.recordedAt.getTime(),
  );
  const traceId = traceIdOf(context.deploymentId, record);
  const spans: OtlpSpan[] = [unitSpan(record, traceId, startMs, endMs)];
  record.agentRuns.forEach((run, index) => {
    const span = runSpan(record, run, index, traceId);
    if (span !== null) spans.push(span);
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(context) },
        scopeSpans: [
          {
            scope: { name: OTLP_SCOPE_NAME, version: context.engineVersion },
            schemaUrl: OTLP_SCHEMA_URL,
            spans,
          },
        ],
      },
    ],
  };
}
