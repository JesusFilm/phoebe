---
"phoebe-agent": minor
---

Add the `dependency-updates` catalog kind, the daily detector that files dependency tickets for the `dependencies` kind to work. Declare it with `path: "phoebe-agent/kinds/dependency-updates"`. Once per `every` window (a day by default) it runs the native, agent and Renovate sources at once, each under its own deadline, and builds from whatever finished. It drops ignored packages and releases still inside their maturity wait, groups the rest, and files one issue per bundle with the `dependencies` and `phoebe:dependencies` labels. A marker in each issue keeps the next scan from filing the same bundle twice, a closed issue vetoes its bundle until a version or an advisory moves, and new issues stop once five bundles are open. The GitHub client gains `listPrsMentioning` and `updateIssueBody`, search hits from `listIssuesMentioning` now carry their labels, and `ctx.agent.run` takes an optional `signal` that stops the agent before the run deadline does.
