# AGENTS.md

You are working in **`JesusFilm/phoebe`** — the public engine for Phoebe, a
software factory: labelled tickets in, pull requests out, nobody watching. This
file orients any agent that lands here.

## What this repo is

One npm package, **`phoebe-agent`**, published as a thin **bootstrapper**
(`bootstrap/`) around the **engine** (`src/`). Consumers do not vendor this
source: they install the package, keep one config file plus prompt overrides, and
run the container files that `phoebe init` scaffolds for them. In the container
`phoebe boot` is the long-lived main process — it checks the engine out at the
git ref the consumer's `engine` config field names, runs it, and relaunches it
when that ref or the config moves.

The repo is a pnpm workspace ([`pnpm-workspace.yaml`](pnpm-workspace.yaml)). The
package stays at the root and is the only thing that publishes; [`apps/`](apps)
holds the apps that ship beside it, starting with
[`apps/console`](apps/console), the console the companion opens. Each app is private and
rides the root version, so `apps/*` never adds a package to npm — it adds
packages the root `ready` gate lints, type-checks, tests, and builds.

`JesusFilm/youtube-studio` incubated Phoebe. Design decisions are recorded on this
repository's own tracker and under `docs/research/`.

## Toolchain

Dev tooling runs through the **`vp`** (Vite+) CLI — `vp check`, `vp test`,
`vp run ready`. Consumers never see `vp`; it is this repo's dev toolchain only.

## Skills

The skills under [`.agents/skills/`](.agents/skills) are vendored, not authored
here, with one exception: `skills-lock.json` pins each vendored skill to an
upstream ref and a content hash, and `.claude/skills` is a symlink onto that
folder. Never edit a vendored `SKILL.md` in place — the edit fails the integrity
check (`vp run verify-skills`, part of `vp run ready`; see
[`scripts/verify-skills.ts`](scripts/verify-skills.ts)) and the next bump
overwrites it. Repo-local rules about how the vendored
skills behave belong in this file instead. That is what the next section is.

The exception is [`handle-pr-review`](.agents/skills/handle-pr-review/SKILL.md),
which is authored here and absent from `skills-lock.json`. Edit it in place.

## User-facing prose runs through unslop

[`unslop`](.agents/skills/unslop/SKILL.md) strips the tells that mark writing as
machine-made. Its frontmatter sets `disable-model-invocation: true`, so it never
loads on its own, but in this repo it always applies: any skill that hands a person
something to read runs the text through unslop before showing or committing it.
That covers review reports, diagnoses, specs and ticket bodies, research write-ups,
handoffs, teaching prose, changesets, commit messages, PR and issue bodies, and
plain chat replies. Read the skill, scan the draft against its numbered rules, and
rewrite. It is a pass over the draft, not
a box to tick once the draft looks fine.

Three things it does not touch:

- Code, tests, config, and lockfiles.
- Documents written for agents rather than people, and documents whose shape a
  format spec fixes — this file, any `SKILL.md`,
  [`GLOSSARY.md`](GLOSSARY.md) (see
  [`GLOSSARY-FORMAT.md`](.agents/skills/domain-modeling/GLOSSARY-FORMAT.md)) and ADRs
  (see [`ADR-FORMAT.md`](.agents/skills/domain-modeling/ADR-FORMAT.md)). A rewrite
  there breaks the machine reading it. Unslop the prose inside the structure if you
  like, but leave the structure alone.
- Quoted material — log output, error text, upstream wording, anything you are
  reproducing rather than writing.

## Every PR carries a changeset

The `changeset` CI check fails any PR that touches `phoebe-agent` without a
Markdown file under `.changeset/` — write one before pushing. A PR that changes
nothing a consumer would notice (docs, CI, tests, a `devDependencies` or tooling
bump) takes the `skip-changeset` label instead; apply it yourself with
`gh pr edit <n> --add-label skip-changeset` rather than asking a maintainer. On
a Renovate PR the split is by dependency type: a runtime `dependencies` bump
gets a `patch` changeset whose summary is the PR title, anything else gets the
label. Format, and why empty changesets don't pass:
[`docs/releasing.md`](docs/releasing.md).

## Gitleaks and fake secrets

The `Scan for exposed secrets` check
([`.github/workflows/gitleaks.yml`](.github/workflows/gitleaks.yml)) runs the
pinned Gitleaks CLI over every commit a PR adds. Test fixtures shaped like
credentials trip it: a `ghp_…` token, a PEM header, a JWT, a long base64 string.
CI publishes only a count, never the finding, so to see what it flagged, install
the same version the workflow pins and run it over your own commits with values
redacted:

    gitleaks git . --log-opts="origin/main..HEAD" --redact=100 --report-format=json --report-path=<outside the repo>

- **A fake you invented for a test:** put a `gitleaks:allow` comment on the
  line the report names, the line holding the value (`// gitleaks:allow` in
  TypeScript). Do not add a `.gitleaksignore` entry for new code. Its
  fingerprints carry the commit SHA, a squash merge changes that SHA, and the
  scan on `main` then fails after the merge.
- **Anything that could be real** — copied from an environment, a log, a config,
  or anything you did not invent: stop. Do not allow-list it, do not push again,
  and do not put the value in a PR, issue, or comment. Tell a maintainer the
  check found a possible credential so they can rotate it. Deleting it in a
  later commit does not help: the scan covers every commit, and history keeps
  the value.
- **`.gitleaksignore`** lists findings that were already in history when the
  check landed, each reviewed and confirmed to be a fixture. Append to it only
  for a finding in a commit already on `main`, only after confirming the value
  is fake, using the commit-scoped `Fingerprint` from the report.
- **Bumping the pinned Gitleaks version:** change the download URL, the SHA-256
  (from the release's `gitleaks_<version>_checksums.txt`), and the `Version:` line
  in the summary together. First run a full-history scan
  (`--log-opts="--remotes=origin --tags"`) with the new version, since new rules
  can flag old fixtures. Those findings go through `.gitleaksignore` as above.

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
