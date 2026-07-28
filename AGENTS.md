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
`JesusFilm/youtube-studio` is the reference consumer and where the design record
lives.

## Toolchain

Dev tooling runs through the **`vp`** (Vite+) CLI — `vp check`, `vp test`,
`vp run ready`. Consumers never see `vp`; it is this repo's dev toolchain only.

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

Early scaffold. The engine port, CLI packaging, `phoebe init`, CI, and the first
release land as tracked issues on this repo. See the README for the doc map.
