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

4. **The companion is packaged from the same run.** If step 3 published, the
   `package` job builds the desktop app on three runners and attaches the
   artifacts to the GitHub Release at the `phoebe-agent@x.y.z` tag that was just
   pushed. Nobody triggers it separately. See
   [the companion's artifacts](#the-companions-artifacts) — that job is written
   and waiting on a maintainer to paste it in.

So publishing always waits on a human merging the version PR. Nothing reaches npm
straight from a feature branch, and no build of the app exists that a release did
not produce.

## The workspace apps ride the root version

The repo is a pnpm workspace, and the packages under `apps/*` are private. They
carry no version of their own and read the root package's version at build time,
so one changeset and one `CHANGELOG.md` entry cover the engine and the apps
together.

`privatePackages: { version: false, tag: false }` in
[`.changeset/config.json`](../.changeset/config.json) is what holds that.
`changeset version` skips every private package, so it never writes a version
into an app's `package.json` and never cuts a tag for one. The `ignore` list
says the same thing one name at a time, but a name in `ignore` matching no
package in the workspace is a hard config error, so it cannot carry a rule that
has to hold before the first app exists.

One consequence is worth knowing. A PR touching **only** `apps/*` passes the
changeset gate with no changeset, because `changeset status` resolves those
files to a package it has been told to skip. Such a change rides out with the
next release some engine change triggers, and says nothing in the changelog. If
an app change deserves a release note, a new window or a changed sign-in flow,
write the changeset by hand against the root package.

## The companion's artifacts

Three platforms, one config
([`apps/desktop/electron-builder.config.cjs`](../apps/desktop/electron-builder.config.cjs)),
decided in [#525 §1](https://github.com/JesusFilm/phoebe/issues/525):

| Runner           | Artifacts                                 |
| ---------------- | ----------------------------------------- |
| `macos-latest`   | arm64 `.dmg` and `.zip`, `latest-mac.yml` |
| `windows-latest` | x64 NSIS `.exe`, `latest.yml`             |
| `ubuntu-latest`  | x64 `.AppImage`, `latest-linux.yml`       |

Intel Macs and arm64 Windows and Linux are added when somebody asks for one. The
`latest*.yml` files are what `electron-updater` reads; they are artifacts like the
installers are, and a release missing one is a release the companion cannot
update to.

**Everything is unsigned this effort** ([#525 §2](https://github.com/JesusFilm/phoebe/issues/525)).
No certificate lives in a secret, macOS builds are not notarised, and the app's
updater is off on macOS because Squirrel.Mac refuses to install an unsigned
bundle. Getting an Apple Developer ID and a Windows certificate for JesusFilm is
a task of its own; when it lands it adds credentials to the `package` job and
flips one clause in [`apps/desktop/src/updates.ts`](../apps/desktop/src/updates.ts).

**The `package` job is not in `release.yml` yet.** Everything it needs is in the
repo — the config, the script, the ignore rule — but the agent that wrote them
holds a token that GitHub will not let write a workflow file, so the job itself
travels in the body of the pull request for
[#561](https://github.com/JesusFilm/phoebe/issues/561) rather than in the tree.
Pasting it into `release.yml` is the one step left, and this paragraph goes with
it.

Nothing about packaging is in the `ready` gate
([#521 §6](https://github.com/JesusFilm/phoebe/issues/521)): it needs an Electron
binary per platform and takes minutes. What the gate does run is `vp run -r build`,
so a main process that no longer builds fails a PR rather than a release.

### Building it yourself

The self-build path is what CI runs, and it stays a supported way to get the app —
the release artifacts exist so that nobody _has_ to:

```sh
vp install            # with scripts, so Electron's binary lands
vp run -r build       # the console bundle and the companion's main and preload
cd apps/desktop && vp run package
```

The artifacts land in `apps/desktop/release/`, which is gitignored. `vp run package`
builds for the platform you are on and publishes nothing.

## One thing is built before it is published

The engine and the bootstrapper ship raw `.ts` and run under Node 24
type-stripping, so nothing is compiled for them. The console is the exception:
`apps/console` builds into `console/` at the root, the root package's `files`
publishes that directory, and `phoebe relay serve` reads the pages out of it.

`console/` is generated and gitignored, so a publish from a clean checkout would
ship a relay whose pages answer 503. The root `prepublishOnly` script runs
`vp run -r build`, which `npm publish` — the binary `changeset publish` shells out
to — fires before it packs. It does not fire on `npm pack`, so the packaging
checks stay as fast as they were.

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
