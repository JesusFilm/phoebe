# AGENTS.md

You are working in **`JesusFilm/phoebe`** — the public engine for Phoebe, an AFK
coding agent. This file orients any agent that lands here.

## What this repo is

A single npm package, **`phoebe-agent`**, published as a pinned CLI. Consumers do
not vendor this source; they install the package, keep one config file plus prompt
overrides, and run the container files that `phoebe init` scaffolds for them.
`JesusFilm/youtube-studio` is the reference consumer and where the design record
lives.

## Toolchain

Dev tooling runs through the **`vp`** (Vite+) CLI — `vp check`, `vp test`,
`vp run ready`. Consumers never see `vp`; it is this repo's dev toolchain only.

## Installing Phoebe into a target repo

If you are here to install Phoebe into another repository, follow the deterministic
runbook: [`docs/ai-install.md`](docs/ai-install.md). It is written to be executed
top to bottom, with no `vp` assumed on the target side.

## Status

Early scaffold. The engine port, CLI packaging, `phoebe init`, CI, and the first
release land as tracked issues on this repo. See the README for the doc map.
