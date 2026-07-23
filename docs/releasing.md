# releasing

`phoebe-agent` is released with [Changesets](https://github.com/changesets/changesets)
and published to npm with **trusted publishing (OIDC)** — no long-lived
`NPM_TOKEN` lives in the repo or in CI. Publish provenance is attached
automatically.

## The everyday flow

1. **Describe the change.** In any PR that changes published behaviour, add a
   changeset:

   ```sh
   pnpm changeset
   ```

   Pick the bump (`patch` / `minor` / `major`) and write a one-line summary. This
   drops a Markdown file under `.changeset/`; commit it with your PR. Docs-only or
   CI-only PRs don't need one.

2. **Merge to `main`.** On push to `main`, the [`release`](../.github/workflows/release.yml)
   workflow sees the pending changeset(s) and opens (or updates) a
   **"chore: version packages"** PR. That PR bumps `version` in `package.json`,
   folds the changesets into `CHANGELOG.md`, and deletes the consumed changeset
   files.

3. **Merge the version PR.** That is the release trigger. On that merge the
   workflow finds no pending changesets, runs the `release` script
   (`changeset publish` — the package ships raw `.ts`, there is no build step),
   publishes the new version to npm, and pushes the matching `phoebe-agent@x.y.z`
   git tag.

So publishing is always gated on a human merging the version PR — nothing reaches
npm straight from a feature branch.

## One-time npm setup (trusted publisher)

A trusted publisher can only be attached to a package that already exists on
npm, so the very first publish can't come from CI. Break the chicken-and-egg with
a one-time manual seed whose only job is to **register the package name** — the
real `0.1.0` is then published by CI through the normal changesets flow:

1. **Seed the package name once, manually,** from a maintainer machine with an npm
   account that has publish rights. This publishes whatever version is in
   `package.json` on your checkout (currently `0.0.0`) — the version doesn't
   matter; the point is only that `phoebe-agent` starts existing so the
   trusted-publisher form has something to attach to:

   ```sh
   npm publish
   ```

   `phoebe-agent` is unscoped, so it's public by default — no `--access` flag is
   needed (that flag is only required when first publishing a _scoped_ package as
   public). Don't pass `--provenance` either: provenance can only be generated
   inside a supported CI provider (it needs an OIDC token), so a local run fails
   with `Automatic provenance generation not supported for provider: null`.
   Provenance isn't lost — CI attaches it automatically on every real release.

2. **Add the trusted publisher.** On the package's **Settings → Publishing access
   → Trusted publishers** page on npmjs.com, add a GitHub Actions publisher:

   - **Repository:** `JesusFilm/phoebe`
   - **Workflow filename:** `release.yml` (filename only — not the full path)
   - **Environment:** leave blank (this workflow uses none)

3. **Let CI publish `0.1.0`.** Merge this PR, then merge the "version packages" PR
   the release workflow opens — that bumps `package.json` to `0.1.0` and publishes
   it tokenless via OIDC, with provenance, moving `latest` off the `0.0.0` seed.
   From here on the manual seed is never needed again; every release flows through
   the workflow.

> Optional tidy-up: `npm deprecate phoebe-agent@0.0.0 "placeholder — use >=0.1.0"`
> so the seed version isn't installed by accident.

## Requirements baked into the workflow

- **`id-token: write`** permission — mints the OIDC token npm exchanges for auth.
- **npm ≥ 11.5.1** — trusted publishing and automatic provenance need it; the
  workflow runs `npm install -g npm@latest` because the pinned Node ships an older
  npm. `changeset publish` shells out to `npm publish` (not `pnpm publish`), so
  this global npm is the one that authenticates — which also sidesteps the pnpm
  11.x OIDC regression ([pnpm/pnpm#11513](https://github.com/pnpm/pnpm/issues/11513)).
- **No `NPM_TOKEN`** — intentionally absent. Auth is OIDC-only.
