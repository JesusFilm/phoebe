---
"phoebe-agent": minor
---

A deployment's report reaches the relay, and a console reads it.

A connected deployment pushes its whole `state/deployment.json` on connect and
again whenever any section of it moves — no deltas, nothing on a timer, and the
liveness between reports is the pong to the relay's twenty-second ping. A push
with no socket is dropped rather than queued, because the next connection opens
with the whole report anyway.

The relay writes each one to `reports/<fingerprint>.json` on its volume, latest
only, through the same atomic rename every other file on either volume uses. A
restarted relay reads them back, so it shows last-known plus **dark** instead of
a false **unseen**. **Forget** takes a deployment's report with its link.

The relay never reads a report. It lifts the `schema` integer out of the envelope
and stores the body opaque, so a console newer than its relay renders sections
the relay has never heard of, and a pipeline's state stays derived once — in the
deployment, by `src/pipeline-listing.ts` — rather than twice.

Three reads, all behind the session cookie: `GET /api/deployments` for the fleet,
`GET /api/deployments/<fingerprint>` for one deployment's row beside the last
report it pushed, and `GET /api/events`, one server-sent-events stream carrying
`report`, `connected`, `disconnected` and `dark` so pages update without polling.
A connection event's name is the word the row now carries, and each is said once
per change. The stream has no replay: every event has a read behind it that
answers the same question in full.
