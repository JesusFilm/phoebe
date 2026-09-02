---
"phoebe-agent": patch
---

Research record: how hatsu turns Slack into issues (docs/research/hatsu-slack-intake.md, issue #405). Read directly from JesusFilm/hatsu at a321d77: Socket Mode means no inbound ingress; push-to-wake, pull-to-read with events never trusted as content; two separately scoped Slack apps plus an app-level `connections:write` token; "runs constantly" is two systemd-supervised processes with only an optional 60 s silence sweep; dedup by re-derived state (no cursor, no seen-set) and idempotent effects; issue shaping is LLM work behind a ticket contract. Plus the Slack-platform limits any phoebe intake inherits (10 sockets/app, socket refreshes, 30k events/hour, HTTP's 3 s ack and disable-on-failure rules).
