---
"phoebe-agent": patch
---

The slot broker's cross-tenant fairness rule now says what the code does (#458). #421 described it as round-robin over tenants; what ships is oldest-waiter-first, which matches rotation only while each tenant has at most one waiter queued. Rolling top-up ends that assumption, since one pipeline can queue several units in a single pass, and a tenant holding the two oldest waiters is then served for both before a tenant that asked later.

That stands as the rule, with no rotation cursor added. A queue position is earned by asking early, `priority` never reaches past its own tenant, and the pipeline at the back of a long queue is moved by the slot floor, which grants a pipeline holding no slot at all one over the cap however long the queue is. Scheduling behaviour is unchanged; `pipelines.md`, `configuration.md`, `operating.md`, `workspace.md` and the broker's own module doc now state the rule, and two broker tests pin it.
