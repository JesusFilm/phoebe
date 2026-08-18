---
"phoebe-agent": patch
---

A blocker issue closed as **completed** now satisfies the block (#219). Blocker
resolution used to ask only "is there a PR on `<branchPrefix>issue-<N>`?", so
work that landed outside the prefix — a human's `wheat/issue-497`, another
tool's branch — was indistinguishable from work nobody had started, and every
dependent issue was skipped forever. `resolveWorktreeBase` gains a third arm
after the open- and merged-PR arms: `CLOSED`/`COMPLETED` blocker → base
`origin/main`, unstacked. `NOT_PLANNED` deliberately does not count; an
abandoned blocker leaves the dependent on unbuilt ground.

The `gh issue view` behind it is lazy — it fires only when both PR lookups come
back empty, so every blocker with a Phoebe PR keeps the two calls per cycle it
costs today and only a blocker Phoebe cannot see pays a third. A failure on it
is caught the way `buildBlockerStates` already catches blocker-state failures
(warn, treat as unsatisfied, retry next cycle).

The idle line also names the blockers now — `3 ready-for-agent issue(s) but none
workable this cycle (waiting on blockers #497, #498)` — instead of a bare count
that read the same whether the wait was legitimate or a permanent stall.
