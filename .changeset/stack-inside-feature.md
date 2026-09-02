---
"phoebe-agent": minor
---

Stack inside a feature, wait across its boundary (#383): base resolution now reads the feature membership of the blocker as well as the issue. Two members of one feature stack as before, with the stack floored on the feature branch instead of the default branch, and the member's resolution carries its feature. A dependency that crosses the boundary — a member blocked by an outsider, or an outsider blocked by a member — is skipped until the blocker's work reaches the branch the dependent is built on; the idle log names it. When the Stacks API cannot express the stack, a member's PR keeps its base rather than being retargeted onto the default branch, which would take the work off the feature branch; the ⛓️ banner names the branch an early merge would pollute. The stale-stack sweep retargets a member back onto its feature branch for the same reason.
