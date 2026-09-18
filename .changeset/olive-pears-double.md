---
"phoebe-agent": minor
---

Every host verb can now be called in-process: `init`, `start`, `stop`, `upgrade`,
`migrate`, `doctor`. Each one is a `run<Verb>(opts)` that takes its seams as
arguments, writes progress through an injected io rather than `process.stdout`,
and returns a typed outcome. The `run<Verb>Cli` wrappers keep argv parsing,
printing and exit codes, so nothing a terminal sees has changed. The outcome
types moved to `phoebe-agent/contracts` as a closed union, re-exported from the
modules that held them. `runUpgrade` no longer prompts for a target or sets an
exit code of its own. A refused half comes back as an outcome instead.
