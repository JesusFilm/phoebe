---
"phoebe-agent": minor
---

The console can now run doctor: one button on a deployment's doctor tab, one on
the fleet page for every deployment at once.

A press is answered within the moment, and the answer is about the ask rather
than about the deployment's health. **started** — nothing was running, so this
press is the run. **joined** — a run was already under way, or a reconcile had
parked one, and this press rides it, because doctor reads the same world twice
and a second run would spend a second tenant's API budget for the same answer.
**refused** — the deployment will not run one now and says why. **undelivered** —
the relay is not holding that connection, refused up front rather than queued.

What the run found arrives afterwards, the way every other fact about a
deployment does: the deployment's model moves its doctor section, pushes the
report, and the console's open stream carries it. So the checks on screen move on
their own, and no button sits spinning for the five minutes doctor is allowed.

A deployment the relay cannot reach has the button disabled with the reason
beside it — disconnected for twelve seconds, dark for two days, never booted —
because the relay already knows the press would come back undelivered. The
fleet-wide press is never disabled: the deployments it cannot reach are part of
the answer, each named with the word that came back.

The relay answers none of doctor's checks and gains no way to. It carries the ask
down a socket and repeats the receipt; every check reads files, env, a clone or
credentials that only the deployment has.
