---
"phoebe-agent": patch
---

A comment with no author is nobody's, not Phoebe's (#282). GitHub reports a
deleted account as a null comment author, and every login the engine read
coerced that to `""` — which is also what an unresolved Phoebe login used to be.
The two "missing"s were the same value, so a ghost's comment could compare equal
to "Phoebe posted this", and the timeout counter's reset-on-activity signal was
lost with it.

A missing author is now `null`, which is nobody's login and can never equal
anyone's, and there is no placeholder Phoebe login at all: `resolvePhoebeLogin`
resolves one wherever a comparison needs it, so `""` never reaches a comparison
from either side. The one place two nullable logins do meet — skipping a PR
author's own review comments — guards explicitly, so a ghost reviewer's comment
on a ghost-authored PR is still the review feedback it plainly is, rather than
being silently attributed to the PR's author and never worked.
