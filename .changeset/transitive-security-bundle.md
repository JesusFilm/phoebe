---
"phoebe-agent": minor
---

`dependency-security` now files a manager's transitive fixes as one issue, "Security fixes for transitive packages", in place of one issue per package. The `dependencies` kind makes lockfile fixes only on it. A row the lockfile cannot bring to its fixed version is dropped with a new `(needs override)` tag and filed again as its own issue, where a parent bump or an override is allowed. Direct dependencies and criticals keep one issue per package. Set `transitive: "individual"` to keep the old shape. If you override `prompts/dependencies-prompt.md`, copy the new lockfile-only paragraph and the `(needs override)` tag into your copy, or the bundle's rows will be fixed with overrides.
