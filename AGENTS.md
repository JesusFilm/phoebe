# AGENTS.md

You are working in **`JesusFilm/phoebe`** — the public engine for Phoebe, an AFK
coding agent. This file orients any agent that lands here.

## What this repo is

A single npm package, **`phoebe-agent`**, published as a thin **bootstrapper**
(`bootstrap/`) around the **engine** (`src/`). Consumers do not vendor this
source: they install the package, keep one config file plus prompt overrides, and
run the container files that `phoebe init` scaffolds for them. In the container
`phoebe boot` is the long-lived main process — it checks the engine out at the
git ref the consumer's `engine` config field names, runs it, and relaunches it
when that ref or the config moves.
`JesusFilm/youtube-studio` incubated Phoebe. Design decisions are recorded on this
repository's own tracker and under `docs/research/`.

## Toolchain

Dev tooling runs through the **`vp`** (Vite+) CLI — `vp check`, `vp test`,
`vp run ready`. Consumers never see `vp`; it is this repo's dev toolchain only.

## Skills

The skills under [`.agents/skills/`](.agents/skills) are vendored, not authored
here: `skills-lock.json` pins each one to an upstream ref and a content hash, and
`.claude/skills` is a symlink onto that folder. Never edit a `SKILL.md` in place —
the edit fails the integrity check and the next bump overwrites it. Repo-local
rules about how the skills behave belong in this file instead. That is what the
next section is.

## User-facing prose runs through unslop

[`unslop`](.agents/skills/unslop/SKILL.md) strips the tells that mark writing as
machine-made. Its own frontmatter says it "must always apply", and in this repo it
does: any skill that hands a person something to read runs the text through unslop
before showing or committing it. That covers review reports, diagnoses, specs and
ticket bodies, research write-ups, handoffs, teaching prose, changesets, commit
messages, PR and issue bodies, and plain chat replies. Read the skill and run its
four steps — scan, rewrite, add soul, self-audit. It is a pass over the draft, not
a box to tick once the draft looks fine.

Three things it does not touch:

- Code, tests, config, and lockfiles.
- Documents written for agents rather than people, and documents whose shape a
  format spec fixes — this file, any `SKILL.md`,
  [`CONTEXT.md`](CONTEXT.md) (see
  [`CONTEXT-FORMAT.md`](.agents/skills/domain-modeling/CONTEXT-FORMAT.md)) and ADRs
  (see [`ADR-FORMAT.md`](.agents/skills/domain-modeling/ADR-FORMAT.md)). A rewrite
  there breaks the machine reading it. Unslop the prose inside the structure if you
  like, but leave the structure alone.
- Quoted material — log output, error text, upstream wording, anything you are
  reproducing rather than writing.

## Installing Phoebe into a target repo

If you are here to install Phoebe into another repository, follow the deterministic
runbook: [`docs/ai-install.md`](docs/ai-install.md). It is written to be executed
top to bottom, with no `vp` assumed on the target side.

## Contributing from outside

This repo is public and Phoebe works it autonomously, so issue and PR authors
carry an advisory `vouch:*` label from `.github/VOUCHED.td`. It gates nothing —
the lever on Phoebe picking work up is still the `ready-for-agent` label, which
only a maintainer can apply. See [`docs/trust.md`](docs/trust.md) to add or
denounce a handle.

## Status

Published on npm as `phoebe-agent` and running against repositories inside and
outside JesusFilm, including this one. See the README for the doc map.
