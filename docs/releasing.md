# Releasing

**Who this is for:** a maintainer cutting a release of `phoebe-agent`. It answers
what to do per PR, what CI does on merge, and what to bump afterwards.

`phoebe-agent` is released with [Changesets](https://github.com/changesets/changesets)
and published to npm with trusted publishing over OIDC. No long-lived
`NPM_TOKEN` lives in the repo or in CI, and npm attaches publish provenance
automatically.

## The everyday flow

1. **Describe the change.** In any PR that changes published behaviour, add a
   changeset:

   ```sh
   pnpm changeset
   ```

   Pick the bump (`patch` / `minor` / `major`) and write a one-line summary. This
   drops a Markdown file under `.changeset/`; commit it with your PR.

   The [`changeset`](../.github/workflows/changeset.yml) workflow enforces this
   on every PR: it runs `changeset status` against the base branch and fails the
   check if the package changed with no pending changeset. Docs-only, CI-only,
   or test-only PRs still don't need one. A maintainer labels those
   `skip-changeset` and the gate skips itself, and applying the label re-runs it.
   An _empty_ changeset does **not** get past the gate, despite what the CLI's
   error text suggests: it releases no package, so `changeset status` keeps
   failing. The "chore: version packages" PR is exempt by branch name, since
   consuming the pending changesets is its whole job.

2. **Merge to `main`.** On push to `main`, the [`release`](../.github/workflows/release.yml)
   workflow sees the pending changeset(s) and opens (or updates) a
   **"chore: version packages"** PR. That PR bumps `version` in `package.json`,
   folds the changesets into `CHANGELOG.md`, and deletes the consumed changeset
   files.

3. **Merge the version PR.** That is the release trigger. On that merge the
   workflow finds no pending changesets, runs the `release` script
   (`changeset publish`, since the package ships raw `.ts` with no build step),
   publishes the new version to npm, and pushes the matching `phoebe-agent@x.y.z`
   git tag.

So publishing always waits on a human merging the version PR. Nothing reaches npm
straight from a feature branch.

## After the release: the pinned tags in the docs

Three places carry a concrete engine tag that readers copy verbatim, and all
three go stale the moment a release lands:

- the Quickstart in [`README.md`](../README.md#quickstart)
- the "Configuration at a glance" block in [`README.md`](../README.md#configuration-at-a-glance)
- the config block in [`ai-install.md`](ai-install.md)

Bump all three to the tag you just published. The rule for which sites are
concrete: an example a reader can copy and run has to carry a real tag, so those
three do. Everywhere else the docs are explaining a mechanism rather than handing
over a command, so they use the `vX.Y.Z` placeholder on purpose and need no
touching.

## How trusted publishing was set up

Already done, recorded here so nobody repeats it. A trusted publisher can only be
attached to a package that already exists on npm, so the first publish could not
come from CI. The package name was seeded once by hand with a `0.0.0` placeholder,
purely so `phoebe-agent` existed for the trusted-publisher form to attach to, and
every release since has flowed through the workflow.

The publisher registered on npm's **Settings → Publishing access → Trusted
publishers** page is:

- **Repository:** `JesusFilm/phoebe`
- **Workflow filename:** `release.yml` (filename only, not the full path)
- **Environment:** blank (this workflow uses none)

Two flags that trip people up if this ever has to be redone: `phoebe-agent` is
unscoped, so it is public by default and needs no `--access`, and `--provenance`
fails outside CI because it needs an OIDC token. CI attaches provenance on every
real release regardless.

## Requirements baked into the workflow

- **`id-token: write`** permission. This mints the OIDC token npm exchanges for auth.
- **npm 11.5.1 or newer.** Trusted publishing and automatic provenance both need
  it, and the workflow runs `npm install -g npm@11` because the pinned Node ships
  an older npm. `changeset publish` shells out to `npm publish` rather than
  `pnpm publish`, so this global npm is the one that authenticates. That also
  sidesteps the pnpm 11.x OIDC regression
  ([pnpm/pnpm#11513](https://github.com/pnpm/pnpm/issues/11513)).
- **No `NPM_TOKEN`.** Absent on purpose. Auth is OIDC only.
