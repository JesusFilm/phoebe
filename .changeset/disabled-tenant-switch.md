---
"phoebe-agent": minor
---

New config field `disabled` (default `false`) — the human off-switch for a
tenant (#202). Set `disabled: true` in a repo's `phoebe.config.ts` and its
engine stops dispatching work at the top of the next poll: a run already in
flight finishes, nothing new starts, and any quarantined work units are
cleared so the tenant comes back clean when re-enabled. The child keeps
running (so re-enabling is a config edit, not a restart), and `phoebe list`
shows a `(disabled)` suffix (`disabled: boolean` in `--json`) while
`phoebe doctor` reports it as an informational `ok` check.
