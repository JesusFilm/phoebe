---
"phoebe-agent": minor
---

The relay tells you when something gets worse, and when it recovers. Five
conditions — `dark`, `wedged`, `crash-looping`, `doctor-fail`, `replaced` — each
with a raise and a matching clear, one message per edge, no digest. A deployment
nothing has ever connected on stays silent: that is setup in progress, not an
incident. Silence waits five minutes before it counts, so the fleet page says
"dark" at the sixty-second mark while the alert holds off long enough for a
container restart to finish, and a dark deployment's other conditions freeze
where they were rather than reporting recoveries out of a stale report.

`RELAY_ALERT_WEBHOOK` is the fifth environment variable and the only optional
one: set it and every edge is POSTed there as JSON with a `text` field a generic
incoming webhook renders unaided. Leave it out and there is no webhook, which is
not the same as no alerting — the relay evaluates every edge and keeps
`alerts.json` either way, because the events stream's `alert` event is the other
sink and it is not configurable. `phoebe relay serve` logs at start which of the
two you have.

`alerts.json` on the relay volume holds the last state actually notified per
(deployment, condition), written after the send attempt rather than after its
success. So a restart never wakes you about something you have already heard
about, a webhook outage does not come back as a storm, and forgetting a
deployment drops its entries without a parting clear. Delivery is one attempt
with a five-second cap; a failure is a warn naming the condition. The URL is
never logged.

A signed-in operator can POST `/api/alerts/test` to send one `{ kind: "test" }`
body to every sink, and `/api/deployments` now carries what the connection panel
needs: whether a webhook is configured, and the last alert per deployment.

The edge rule is a pure function in `phoebe-agent/contracts`, so the relay and
the desktop companion decide the same thing from the same facts rather than
agreeing by coincidence.
