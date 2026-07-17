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
   (`vp run build && changeset publish`), publishes the new version to npm, and
   pushes the matching `phoebe-agent@x.y.z` git tag.

So publishing is always gated on a human merging the version PR — nothing reaches
npm straight from a feature branch.

## One-time npm setup (trusted publisher)

Trusted publishing has to be configured once on npmjs.com before the first
publish can succeed. Because the package doesn't exist yet, this is a two-step
bootstrap:

1. **Seed `phoebe-agent@0.1.0` once, manually,** from a maintainer machine with
   an npm account that has publish rights, so the package name exists and the
   trusted-publisher form has something to attach to:

   ```sh
   vp run build
   npm publish --access public
   ```

   `--access public` is required for the first publish of an unscoped package.
   Do **not** pass `--provenance` here: provenance can only be generated inside a
   supported CI provider (it needs an OIDC token), so a local run fails with
   `Automatic provenance generation not supported for provider: null`. Provenance
   isn't lost — CI attaches it automatically on every release after this seed.

2. **Add the trusted publisher.** On the package's **Settings → Publishing access
   → Trusted publishers** page on npmjs.com, add a GitHub Actions publisher:

   - **Repository:** `JesusFilm/phoebe`
   - **Workflow filename:** `release.yml` (filename only — not the full path)
   - **Environment:** leave blank (this workflow uses none)

Once the trusted publisher is registered, every later release publishes tokenless
via OIDC from the `release` workflow — the manual publish above is never needed
again.

> If you prefer not to hand-publish `0.1.0`, you can instead create the package by
> publishing an empty placeholder, or publish `0.1.0` from CI after wiring a
> short-lived automation token — but the trusted-publisher path above is the
> supported one and leaves no token behind.

## Requirements baked into the workflow

- **`id-token: write`** permission — mints the OIDC token npm exchanges for auth.
- **npm ≥ 11.5.1** — trusted publishing and automatic provenance need it; the
  workflow runs `npm install -g npm@latest` because the pinned Node ships an older
  npm. `changeset publish` shells out to `npm publish` (not `pnpm publish`), so
  this global npm is the one that authenticates — which also sidesteps the pnpm
  11.x OIDC regression ([pnpm/pnpm#11513](https://github.com/pnpm/pnpm/issues/11513)).
- **No `NPM_TOKEN`** — intentionally absent. Auth is OIDC-only.
