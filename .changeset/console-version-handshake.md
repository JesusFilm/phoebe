---
"phoebe-agent": minor
---

A companion older or newer than the relay it points at now says so plainly.

The relay answers `GET /api/version` with `{ version, console }`, and asks for no
session first. `console` is a second integer beside the handshake's `protocol`.
`protocol` numbers the WebSocket a deployment dials; this one numbers the JSON API
and the event stream a console reads. They move independently, so a console-only
change never reads as a deployment incompatibility. The read is open because a
companion too new for a relay has to find that out before it has anywhere to put a
session.

The rule is the rail's rule, word for word: upgrade the relay first. The relay
serves every console protocol up to its own. A console above it renders the Relay
group as too old, links the relay upgrade doc, and makes no other call. A relay
ahead of a console is fine, which is what lets you move a relay without collecting
every companion on the same afternoon. The comparison has one implementation, in
`apps/console/src/relay-version.ts`. The relay publishes its integer and compares
nothing.

The local arm reports and never refuses. A local install's facts now carry the
`phoebe-agent` version its container is built from, the `ARG PHOEBE_AGENT_VERSION`
pin in `container/Dockerfile`. Reading the file rather than the container means a
stopped install still says which version it is stopped on, which is when an
operator tends to ask. The install tab states it beside the companion's own
version. A difference is a sentence, and every verb stays offered, `Check for
upgrades` included. Locking the buttons on a skew would lock away the verb that
fixes it.
