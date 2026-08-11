---
"phoebe-agent": patch
---

Quarantine now has two working exits. The auto-un-stick sweep is wired into the
poll cycle: each cycle Phoebe checks every unit still labelled
`phoebe:quarantined` and removes the label when the unit's content has advanced
past the baseline its escalation comment recorded — a PR's head SHA, or a
fingerprint of the issue body. Issue baselines are that fingerprint rather than
`updatedAt`, which GitHub bumps on any comment, label, or reaction (including
Phoebe's own quarantine writes) and which would therefore have cleared every
quarantine on the first sweep. Both exits — the sweep and a hand-removed label —
now reset the timeout counter, so a released unit gets a fresh
`maxUnitTimeouts` allowance instead of re-quarantining on its next timeout. A
`phoebe:quarantined` label applied by a human is never auto-removed: the sweep
only acts on a quarantine of its own that is still in force, and ignores the
baseline of one it has already lifted.
