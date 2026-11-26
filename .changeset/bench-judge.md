---
"phoebe-agent": minor
---

`phoebe bench run` can now judge each trial against the PR that actually merged. Add `"judge": { "provider": "claude", "model": "<model>" }` to the bench config. After each trial that made commits, one judge run reads the issue, the merged PR's diff and the trial's patch in a scratch directory with no repository and no GitHub credential. It answers `better`, `equivalent`, `worse` or `wrong` with a short rationale. Each trial line gets a `judgement` with the verdict and the judge's usage, kept out of the contender's `agentRuns`. The report adds a count per verdict for each contender, and a line for the judge's own tokens and cost, which never appear in a contender's cost columns. Without `judge`, nothing changes. A judge whose provider key is unset stops the run before any trial starts.
