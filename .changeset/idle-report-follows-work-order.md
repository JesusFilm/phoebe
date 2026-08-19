---
"phoebe-agent": patch
---

The idle-cycle report now follows this tenant's `workOrder` (#282). Selection and
the report were two separate walks over the work kinds — the loop asking
`selectFirstWorkUnit`, and the reporter re-walking them in a hardcoded order of
its own — so on any `workOrder` other than the hardcoded one they could name
different kinds. An operator could be told "3 ready-for-agent issue(s) but none
workable" about a cycle whose first kind was `conflicts` and whose conflicting
PRs were never mentioned.

`selectFirstWorkUnit` now returns the unit it picked together with a record of
what each kind it walked passed over and why, and the report renders that record.
There is one walk, so the report can only describe the cycle that actually
happened. The lines themselves are unchanged; their order now matches
`workOrder`, and a kind the walk never reached is no longer reported on.
