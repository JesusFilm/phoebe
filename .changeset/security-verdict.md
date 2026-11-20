---
"phoebe-agent": minor
---

A `dependency-security` ticket that needs a manifest fix now ends in a verdict. Before it bumps a parent or adds an override, the `dependencies` kind checks whether the repository is exposed to the advisory. "Not affected" has to name the vulnerable function or input, the dependency that reaches the package, and why that path never sees attacker-controlled input or never runs outside a build. Phoebe then closes the issue as not planned when no advisory on it is critical, and leaves a critical parked for a maintainer. A dismissal has no expiry: it lifts on a new advisory or a reopen, and nothing re-checks it if your code changes. If you override `prompts/dependencies-prompt.md`, copy "The verdict" section into your copy to get this.
