---
"phoebe-agent": minor
---

Units the engine cannot see now have a skip half (#424). A unit with no `github` target had nowhere to receive the `phoebe:quarantined` label, so the timeouts the engine already counted for it in memory were written and never read: nothing stopped a wedged unit being re-picked every pass, forever. The count now has a consumer.

**`ctx.quarantined`**, a sibling to `ctx.inFlight`: this kind's refs whose in-memory timeout count reached the threshold (`maxUnproductiveRuns`, K=3 by default). Filter it in `select` the way you filter `inFlight`. A kind that offers one anyway has the pick refused at admission and is not asked again that pass, so ignoring the set stalls that kind on its poison unit rather than spending a run budget on it every pass. Built-in kinds never appear in it — their units carry `github` and take the label path.

**`revision` on the unit shape**, optional: what "the content advanced" means for a unit the engine cannot see — a Slack thread's newest message `ts`, a row version, any string that changes when the unit does. The engine records it beside the count and forgets the count when a later pick of the same ref carries a different one, which is how a unit gets out of an in-memory quarantine. Set no `revision` and the count lives for the process's life. It is memory-only either way: a relaunch costs up to K run budgets on a genuinely wedged unit, and nothing under `state/` stops being re-derivable.

**A ref that gains a `github` target mid-count** drops its in-memory entry and starts the label path from zero — nothing is seeded from memory, so no comment claims timeouts an issue cannot show. The skip half for such a unit is the kind's own label filter, as it already is for the built-ins.

**The idle report prints only when it changes** — the first idle pass after activity, and again whenever the skip set moves. A pipeline polling every few seconds was otherwise repeating one paragraph until it buried everything worth reading; a work row at 300 s prints what it always printed. The in-memory drop renders there like any other skip: `N <noun> skipped (quarantined in memory)`.
