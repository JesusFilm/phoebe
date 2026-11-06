---
"phoebe-agent": minor
---

Add the `dependencies` catalog kind, the implementer for dependency tickets. Declare it with `path: "phoebe-agent/kinds/dependencies-work"`. It works issues labelled `phoebe:dependencies` (the `label` option changes that) with its own prompt, `prompts/dependencies-prompt.md`. The agent applies the bumps the issue lists, fixes what they break, drops any package that still fails under a `## Dropped` heading, and opens the PR. The kind never adds the ready label, so it can run in its own pipeline beside `issues`. When the engine opens the PR, the body now ends with the issue's dependency marker.
