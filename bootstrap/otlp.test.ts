// Unit records as OTLP spans (#993): the switch the environment throws, and the
// one trace each record maps onto.

import { describe, expect, test } from "vite-plus/test";
import type { AgentRunRecord, UnitRecord } from "../src/contracts/unit-record.ts";
import {
  OTLP_SCHEMA_URL,
  otelEnvKeys,
  parseKeyValueList,
  resolveOtlpTarget,
  spanIdOf,
  traceIdOf,
  unitTraceRequest,
  type OtlpAttribute,
  type OtlpSpan,
  type OtlpValue,
  type TraceContext,
} from "./otlp.ts";

function agentRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    startedAt: "2026-11-20T10:00:05.000Z",
    durationMs: 60_000,
    exitCode: 0,
    promptSha: "a".repeat(64),
    costBasis: "api",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheWriteTokens: 200,
    reasoningTokens: 30,
    costUsd: 0.42,
    turns: 7,
    providerDurationMs: 59_000,
    stopReason: "end_turn",
    reportedModels: ["claude-opus-5-5", "claude-haiku-5-5"],
    usageComplete: true,
    toolCalls: { Bash: 3, Edit: 2 },
    ...overrides,
  };
}

function unitRecord(overrides: Partial<UnitRecord> = {}): UnitRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    unit: { kind: "issues", id: "42" },
    outcome: "completed",
    quarantined: false,
    detail: "Fix the flaky login test (secret issue title)",
    startedAt: "2026-11-20T10:00:00.000Z",
    settledAt: "2026-11-20T10:05:00.000Z",
    durationMs: 300_000,
    runBudgetMs: 3_600_000,
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    branch: "phoebe/issue-42-secret-branch-name",
    headSha: "b".repeat(40),
    prNumber: 77,
    engineCommit: "c".repeat(40),
    agentRuns: [agentRun()],
    ...overrides,
  };
}

const context: TraceContext = {
  deploymentId: "dep_0123456789ABCDEFGHJKMNPQRS",
  engineVersion: "0.19.0",
  target: { serviceName: null, resourceAttributes: {} },
  recordedAt: new Date("2026-11-20T11:00:00.000Z"),
};

function spansOf(record: UnitRecord, ctx: TraceContext = context): OtlpSpan[] {
  const request = unitTraceRequest(record, ctx);
  expect(request).not.toBeNull();
  return request!.resourceSpans[0]!.scopeSpans[0]!.spans;
}

/** Attributes as a plain map, values unwrapped, so an assertion reads like the spec. */
function attrs(list: OtlpAttribute[]): Record<string, unknown> {
  const unwrap = (value: OtlpValue): unknown => {
    if ("stringValue" in value) return value.stringValue;
    if ("boolValue" in value) return value.boolValue;
    if ("intValue" in value) return value.intValue;
    if ("doubleValue" in value) return value.doubleValue;
    return value.arrayValue.values.map(unwrap);
  };
  return Object.fromEntries(list.map((attribute) => [attribute.key, unwrap(attribute.value)]));
}

describe("resolveOtlpTarget", () => {
  test("no endpoint, or an empty one the compose file passed through, is off", () => {
    expect(resolveOtlpTarget({})).toBeNull();
    expect(
      resolveOtlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "", OTEL_EXPORTER_OTLP_HEADERS: "a=b" }),
    ).toBeNull();
  });

  test("the general endpoint is a base URL that v1/traces is appended to", () => {
    expect(resolveOtlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" })?.url).toBe(
      "http://c:4318/v1/traces",
    );
    expect(resolveOtlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/otlp/" })?.url).toBe(
      "http://c:4318/otlp/v1/traces",
    );
  });

  test("the traces endpoint is used as given, over the general one", () => {
    const target = resolveOtlpTarget({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://ingest.example.com/traces",
    });
    expect(target?.url).toBe("https://ingest.example.com/traces");
    expect(target?.from).toBe("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  });

  test("headers, service name and resource attributes come from the standard variables", () => {
    const target = resolveOtlpTarget({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20abc, x-team = factory",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod,service.name=from-attrs",
      OTEL_SERVICE_NAME: "phoebe-prod",
    });
    expect(target?.headers).toEqual({ authorization: "Bearer abc", "x-team": "factory" });
    expect(target?.resourceAttributes).toEqual({
      "deployment.environment": "prod",
      "service.name": "from-attrs",
    });
    expect(target?.serviceName).toBe("phoebe-prod");
    expect(target?.unsupportedProtocol).toBeNull();
  });

  test("grpc and http/protobuf are unsupported; http/json is not flagged", () => {
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" };
    expect(
      resolveOtlpTarget({ ...base, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })?.unsupportedProtocol,
    ).toBe("grpc");
    expect(
      resolveOtlpTarget({ ...base, OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf" })
        ?.unsupportedProtocol,
    ).toBe("http/protobuf");
    expect(
      resolveOtlpTarget({ ...base, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" })?.unsupportedProtocol,
    ).toBeNull();
  });

  test("otelEnvKeys names every OTEL_* key and nothing else", () => {
    expect(
      otelEnvKeys({
        OTEL_EXPORTER_OTLP_HEADERS: "a=b",
        OTEL_SERVICE_NAME: "",
        PATH: "/bin",
        XOTEL_: "x",
      }),
    ).toEqual(["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_SERVICE_NAME"]);
  });

  test("a malformed pair is skipped, not fatal", () => {
    expect(parseKeyValueList("novalue,=x,a=1,b=%E0%A4%A")).toEqual({ a: "1", b: "%E0%A4%A" });
  });
});

describe("unitTraceRequest", () => {
  test("one trace: a unit root span and one invoke_agent child per run", () => {
    const record = unitRecord({
      agentRuns: [agentRun(), agentRun({ startedAt: "2026-11-20T10:02:00.000Z" })],
    });
    const spans = spansOf(record);
    expect(spans).toHaveLength(3);
    const [root, first, second] = spans as [OtlpSpan, OtlpSpan, OtlpSpan];
    const traceId = traceIdOf(context.deploymentId, record);
    expect(spans.every((span) => span.traceId === traceId)).toBe(true);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    expect(root.name).toBe("unit issues");
    expect(root.kind).toBe(1);
    expect(root.parentSpanId).toBeUndefined();
    expect(root.spanId).toBe(spanIdOf(traceId, 0));
    expect(root.startTimeUnixNano).toBe("1795168800000000000");
    expect(root.endTimeUnixNano).toBe("1795169100000000000");
    expect(root.status.code).toBe(0);

    expect(first.name).toBe("invoke_agent issues");
    expect(first.kind).toBe(3);
    expect(first.parentSpanId).toBe(root.spanId);
    expect(first.spanId).toBe(spanIdOf(traceId, 1));
    expect(second.spanId).toBe(spanIdOf(traceId, 2));
    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(first.startTimeUnixNano).toBe("1795168805000000000");
    expect(first.endTimeUnixNano).toBe("1795168865000000000");
  });

  test("the same record twice gives the same trace and span IDs", () => {
    const later = { ...context, recordedAt: new Date("2026-11-21T00:00:00.000Z") };
    const ids = (ctx: TraceContext) =>
      spansOf(unitRecord(), ctx).map((span) => [span.traceId, span.spanId]);
    expect(ids(later)).toEqual(ids(context));
  });

  test("a different deployment, cell, unit or start is a different trace", () => {
    const base = traceIdOf(context.deploymentId, unitRecord());
    expect(traceIdOf("dep_ZZZZZZZZZZZZZZZZZZZZZZZZZZ", unitRecord())).not.toBe(base);
    expect(traceIdOf(context.deploymentId, unitRecord({ pipeline: "observer" }))).not.toBe(base);
    expect(
      traceIdOf(context.deploymentId, unitRecord({ unit: { kind: "issues", id: "43" } })),
    ).not.toBe(base);
    expect(
      traceIdOf(context.deploymentId, unitRecord({ startedAt: "2026-11-20T10:00:00.001Z" })),
    ).not.toBe(base);
  });

  test("the unit span carries its phoebe.* facts and the configured provider and model", () => {
    const [root] = spansOf(unitRecord());
    expect(attrs(root!.attributes)).toEqual({
      "phoebe.tenant": "acme/widget",
      "phoebe.pipeline": "work",
      "phoebe.kind": "issues",
      "phoebe.unit": "42",
      "phoebe.outcome": "completed",
      "phoebe.quarantined": false,
      "phoebe.run_budget_ms": "3600000",
      "phoebe.effort": "high",
      "phoebe.pr_number": "77",
      "phoebe.head_sha": "b".repeat(40),
      "phoebe.engine_commit": "c".repeat(40),
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-opus-5-5",
    });
  });

  test("an agent run span carries the GenAI attributes and phoebe.agent_run.*", () => {
    const [, run] = spansOf(unitRecord());
    expect(attrs(run!.attributes)).toEqual({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "issues",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-opus-5-5",
      // Uncached, cache reads and cache writes, as the convention counts input.
      "gen_ai.usage.input_tokens": "1300",
      "gen_ai.usage.output_tokens": "50",
      "gen_ai.usage.cache_read.input_tokens": "1000",
      "gen_ai.usage.cache_write.input_tokens": "200",
      "gen_ai.usage.reasoning.output_tokens": "30",
      "phoebe.agent_run.cost_usd": 0.42,
      "phoebe.agent_run.cost_basis": "api",
      "phoebe.agent_run.turns": "7",
      "phoebe.agent_run.stop_reason": "end_turn",
      "phoebe.agent_run.usage_complete": true,
      "phoebe.agent_run.exit_code": "0",
      "phoebe.agent_run.prompt_sha": "a".repeat(64),
      "phoebe.agent_run.reported_models": ["claude-opus-5-5", "claude-haiku-5-5"],
      "phoebe.agent_run.tool_calls": "5",
    });
    expect(run!.status.code).toBe(0);
  });

  test("a null count is left out, never sent as 0; a zero cache count is left out too", () => {
    const [, run] = spansOf(
      unitRecord({
        agentRuns: [
          agentRun({
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: 0,
            cacheWriteTokens: null,
            reasoningTokens: null,
            costUsd: null,
            costBasis: null,
            turns: null,
            stopReason: null,
          }),
        ],
      }),
    );
    const keys = Object.keys(attrs(run!.attributes));
    for (const key of [
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.cache_read.input_tokens",
      "gen_ai.usage.cache_write.input_tokens",
      "gen_ai.usage.reasoning.output_tokens",
      "phoebe.agent_run.cost_usd",
      "phoebe.agent_run.cost_basis",
      "phoebe.agent_run.turns",
      "phoebe.agent_run.stop_reason",
    ]) {
      expect(keys).not.toContain(key);
    }
    expect(keys).not.toContain("gen_ai.conversation.id");
  });

  test.each(["codex", "cursor"] as const)("%s maps to its GenAI provider name", (provider) => {
    const [root, run] = spansOf(unitRecord({ provider }));
    const expected = provider === "codex" ? "openai" : "cursor";
    expect(attrs(root!.attributes)["gen_ai.provider.name"]).toBe(expected);
    expect(attrs(run!.attributes)["gen_ai.provider.name"]).toBe(expected);
  });

  test.each(["failed", "timed-out"] as const)(
    "a %s unit is ERROR, with the outcome as error.type",
    (outcome) => {
      const [root] = spansOf(unitRecord({ outcome }));
      expect(root!.status.code).toBe(2);
      expect(attrs(root!.attributes)["error.type"]).toBe(outcome);
    },
  );

  test("an abandoned unit is ERROR and runs to the moment its record arrived", () => {
    const [root] = spansOf(
      unitRecord({ outcome: "abandoned", settledAt: null, durationMs: null, agentRuns: [] }),
    );
    expect(root!.status.code).toBe(2);
    expect(attrs(root!.attributes)["error.type"]).toBe("abandoned");
    expect(root!.endTimeUnixNano).toBe("1795172400000000000");
  });

  test("a run that exited non-zero or never exited is ERROR", () => {
    const spans = spansOf(
      unitRecord({ agentRuns: [agentRun({ exitCode: 1 }), agentRun({ exitCode: null })] }),
    );
    expect(spans[1]!.status.code).toBe(2);
    expect(attrs(spans[1]!.attributes)["error.type"]).toBe("1");
    expect(spans[2]!.status.code).toBe(2);
    expect(attrs(spans[2]!.attributes)["error.type"]).toBe("no_exit");
    expect(Object.keys(attrs(spans[2]!.attributes))).not.toContain("phoebe.agent_run.exit_code");
  });

  test("detail and branch never appear in the payload", () => {
    const record = unitRecord({ outcome: "failed" });
    const body = JSON.stringify(unitTraceRequest(record, context));
    expect(body).not.toContain(record.detail!);
    expect(body).not.toContain(record.branch!);
    expect(body).not.toContain("secret");
  });

  test("resource and scope: service identity, the env's overrides, and the pinned schema", () => {
    const request = unitTraceRequest(unitRecord(), {
      ...context,
      target: {
        serviceName: "phoebe-prod",
        resourceAttributes: { "deployment.environment": "prod" },
      },
    })!;
    const resource = request.resourceSpans[0]!;
    expect(attrs(resource.resource.attributes)).toEqual({
      "service.name": "phoebe-prod",
      "service.version": "0.19.0",
      "service.instance.id": context.deploymentId,
      "deployment.environment": "prod",
    });
    expect(resource.scopeSpans[0]!.scope).toEqual({ name: "phoebe-agent", version: "0.19.0" });
    expect(resource.scopeSpans[0]!.schemaUrl).toBe(OTLP_SCHEMA_URL);
    expect(OTLP_SCHEMA_URL).toBe("https://opentelemetry.io/schemas/semconv-genai-dev/0.1.0-dev");

    const plain = unitTraceRequest(unitRecord(), context)!;
    expect(attrs(plain.resourceSpans[0]!.resource.attributes)["service.name"]).toBe("phoebe");
  });

  test("a record whose start does not parse has no trace", () => {
    expect(unitTraceRequest(unitRecord({ startedAt: "not a time" }), context)).toBeNull();
  });
});
