---
"phoebe-agent": minor
---

A deployment in the console now has a **config** tab: every effective-config leaf
in one filterable table, so an operator can answer "what is this set to, and
why".

Filter by a path or a value — "what is `model` set to" and "who set it to
`opus`" are the two questions that bring anyone here — and the chips beside the
filter count the leaves each source won, so clicking `overlay` narrows the table
to what env decides. Every row carries its source chip; the env name or file path
behind it is in the row's disclosure, on hover or expanded, because which source
won is what an operator scans for and the name behind it is what they read once
they have found the row. A value that lost sits under the value that beat it, so
"why isn't my file value taking effect" is answered where it is asked. Deprecated
aliases sit above the table rather than row by row, and the fingerprint of the
config file heads the tab: it is the text a later edit checks itself against.

`phoebe-agent/contracts` gains the effective-config shape the table reads —
`TenantEffectiveConfig` and the leaf under it, `ConfigReport` as section 5 of the
deployment report, and `EFFECTIVE_CONFIG_VERSION`. The bootstrapper does not fill
that section in yet; until it does, the tab says the deployment's settings are
unknown from here, which is not the same as having none.
