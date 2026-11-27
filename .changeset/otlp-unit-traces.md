---
"phoebe-agent": minor
---

Phoebe can now forward unit records to your own OpenTelemetry collector as OTLP traces. To turn it on, set `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` in the deployment's `.env`, and put the collector's credential in `OTEL_EXPORTER_OTLP_HEADERS`. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are honoured. The scaffolded `container/compose.yml` passes all of them through. An existing deployment needs those lines added to its own compose file. There is no config field, and no agent ever gets an `OTEL_*` variable.

The bootstrapper sends one trace per new unit record, observer units included, over OTLP/HTTP JSON. It never sends bench trials or older records. Each trace has a `unit <kind>` root span and one `invoke_agent <kind>` span per agent run, with `gen_ai.*` and `phoebe.*` attributes. A unit's `detail` and `branch` are never sent. The `gen_ai.*` names follow semantic-conventions-genai v0.1.0, and the scope's schema URL is pinned to `https://opentelemetry.io/schemas/semconv-genai-dev/0.1.0-dev`.

A send that gets 429, 502, 503 or 504, or loses its connection, is retried once. Anything else is dropped, and nothing is queued on disk. The deployment report's `bootstrapper.telemetry` counts traces sent and dropped, with the last error and the time of the last send. The console shows a warning when sends keep failing. `phoebe doctor` has a new `telemetry` check that says whether forwarding is on and where it sends, and warns when `*_PROTOCOL` asks for `grpc` or `http/protobuf`, which Phoebe does not speak.

The engine's unit record IPC message now carries the record. A bootstrapper with an older engine forwards nothing.
