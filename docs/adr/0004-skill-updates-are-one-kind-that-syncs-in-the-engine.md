# Skill updates are one kind that syncs in the engine

Vendored skills drifted from upstream until someone bumped them by hand: #125,
#639 and #875 were each a person running the `skills` CLI, reading the diff and
writing the PR. The grilling session behind #877 (2026-11-16) settled two
places where the fix departs from the dependency feature
([ADR 0003](0003-dependency-updates-are-three-kinds-over-one-candidate-contract.md)).

**One kind, not a detector and a worker.** `skill-updates` finds a newer ref,
syncs it, runs an agent pass and opens the PR itself. The dependency feature
files an issue first because a person may decide something between filing and
working it: drop a bump, regroup, wait. A skill bump has nothing to decide
there. Its review is reading the diff, and the PR is where that diff lives. An
issue in front of it would say the same thing twice, and a veto would need two
records instead of one. The PR is the record: one open PR per source, on a
stable branch, and closing it unmerged vetoes the `source@ref` its marker names.

**The engine syncs; it does not shell out to the `skills` CLI.** `skills update`
re-fetches the ref already in the lock, so a lock on `v1.3.2` stays on
`v1.3.2`. It has no source filter and no exclude flag, it says nothing about
skills added upstream for GitHub sources, and it calls skills.sh on every run.
The engine instead runs `git ls-remote` for the target, shallow-fetches it with
the container's own git credentials, copies each locked skill's folder over the
vendored copy, and rewrites the lock entry with the hash module the `ready`
gate already uses (#876). That keeps the lock format and hash recipe ours to
check: a lock whose `version` is not 2 is refused rather than half-written.

## Consequences

- The kind owns a copy of the lock's rules: where vendored skills sit
  (`.agents/skills/<name>/` beside the lock) and how a moved skill is found
  again (by folder name). If the CLI changes either, this kind and
  `verify-skills` both need the change, and the lock `version` is expected to
  move with it.
- The kind never merges. Vendored skills are instructions every agent in the
  repository follows, so a compromised upstream would be a way into the
  factory. The agent pass flags lines that read like prompt injection and the
  PR opens as a draft when it does, but a person reads every bump either way.
