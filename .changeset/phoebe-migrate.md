---
"phoebe-agent": minor
---

New verb `phoebe migrate`, and `phoebe upgrade` runs migrations for you (#177).
A **deployment migration** is a small, idempotent, engine-owned reshaping of
the files a deployment carries — a prompt file the engine now expects, a work
kind that should be in `workOrder` — so that moving to a newer engine no longer
depends on an operator reading the changelog and editing by hand.

- `phoebe migrate` walks the deployment (solo root, or workspace root plus
  every tenant), applies each registered migration that detects as applicable,
  and prints per-directory verdicts (`migrated` · `up-to-date` · `manual` ·
  `failed` · `reverted` · `skipped` · `invalid`) with the paths it wrote so
  you can review and commit them. Writes are staged and flushed only after a
  migration succeeds, create-if-absent files are written no-clobber, and a
  failure mid-flush or in post-apply validation reverts what was written.
  Dirty tenant trees are skipped, not overwritten.
- `phoebe migrate --check` previews the walk with every write suppressed and
  exits 1 when anything is pending, for scripted pipelines.
- `phoebe migrate --json` (with or without `--check`) emits a stable,
  additive-only envelope — documented in `docs/upgrading.md`.
- `phoebe upgrade` now materialises the **target** checkout and runs _its_
  `migrate` before flipping `engine.ref`, so new code migrates old artifacts and
  a failed migration aborts the upgrade with the pin untouched. `upgrade
--check` is unchanged.

**What changes for existing deployments.** `phoebe upgrade` may now leave
uncommitted, reviewable edits in your deployment repos (a scaffolded prompt
file, a `workOrder` entry) — review and commit them; nothing is pushed for you.
A migration that fails aborts the upgrade with `engine.ref` untouched. This
runs only for `engine.source: "github"` deployments: a `source: "local"`
deployment does not go through the materialise-and-migrate step and must run
`phoebe migrate` by hand after moving its checkout.

Two migrations ship in this release: scaffold a missing
`prompts/research-prompt.md`, and append `"research"` to `workOrder` where it
is absent. Both are no-ops on a deployment that already has them.

Config edits are made by a parser-based substrate (a vendored `@babel/parser`
bundle, MIT) that splices only the bytes it changes and refuses — rather than
guesses — on config shapes it cannot edit safely (spread, shorthand,
computed keys, non-literal values, and so on); a refusal reports `manual` with
the reason. `docs/migrations.md` covers writing migrations, the supported
config forms, and the closed refusal set.
