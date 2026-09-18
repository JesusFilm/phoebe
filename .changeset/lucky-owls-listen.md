---
"phoebe-agent": minor
---

The relay's view of a deployment stays truthful when networks misbehave. The
relay pings every twenty seconds and sends a visible heartbeat beside each ping;
a deployment it has not heard from for a minute is **dark**, clocked from the
later of the last heartbeat and the relay's own start, and before that minute is
up the word is "disconnected 12 s" — a fact with a duration rather than a fourth
state. A socket that answers neither ping nor message is terminated instead of
being reported as connected.

The deployment's side follows one retry rulebook: the first retry after a close
lands inside five seconds, the ceiling doubles to thirty and stays, every delay
is jittered, and there is no last attempt. `unlinked`, `bad-signature`,
`token-spent` and `replaced` each stop the link; `protocol` waits for an
operator to upgrade the relay. A minute with nothing inbound redials, which is
the only way a half-open socket is ever noticed.

Requests to a deployment are refused `undelivered` rather than queued — on
disconnect for anything in flight, and up front for a deployment the relay is
not holding. **Forget** on the relay deletes the link and turns the live
connection away; `phoebe relay leave` deletes the deployment key on the host.
Either half works without the other, and a re-paired deployment is a new record
with the old one left dark and marked "replaced?".
