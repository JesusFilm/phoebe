# Can self-hosted Renovate be a detector Phoebe reads?

Research for [#749](https://github.com/JesusFilm/phoebe/issues/749), the dependency-update map, and
ADR 0003. Hosted Renovate crashes on `JesusFilm/core`. Nobody has checked whether the
self-hosted CLI, pinned and run in dry-run against a local checkout, does too. The engine design
unions Renovate with a native source, so the answer only decides whether the Renovate source ships
enabled or disabled by default, and whether Docker needs a native row in v1.

Fill the sections in as the work happens. Cite the Renovate docs page or the source file for every
claim about flags and output.

## The questions

1. **Which output channel is stable enough to parse?** Renovate's `LOG_FORMAT=json` log stream
   carries the lookup results, and there may be a report file option. Record which one exposes,
   per dependency: manager, package name, current version, the proposed new version, the update
   type, and the release timestamp. Record the exact flag set.
2. **Which `--dry-run` level is the cheapest that still performs lookups?** `extract` reads
   manifests only; `lookup` queries registries; `full` goes further. The engine wants lookups and
   nothing else.
3. **Does `--platform=local` need a token at all?** The run must work with no GitHub credential in
   its environment, because the agent env strips `GH_TOKEN` and the detector should not hand
   Renovate one.
4. **How long does it take on `JesusFilm/core`, and does it finish?** Three consecutive runs inside
   the Phoebe container image, pinned version, same checkout. Record wall time, peak memory, exit
   code, and whether the candidate list is identical across runs.
5. **deps.dev and OSV rate limits.** Both are unauthenticated. Record the documented limits, the
   headers they return, and the request count one detection pass makes on `JesusFilm/core` and on
   this repo. The security detector runs hourly by default, so multiply by 24.

## Acceptance for the Renovate source shipping enabled

- Three runs in a row on `JesusFilm/core` finish within 20 minutes each and exit 0.
- The parsed candidate list is identical across the three runs.
- No GitHub credential was present in the environment.
- The output channel used is documented by Renovate, not inferred from a log line's shape.
- An exit of 0 with an empty or partial report is not a pass. The spike names the report field
  that shows a lookup completed for a dependency that is already up to date (an empty `updates`
  array alone does not, since the smoke run's 403 case produced the same shape), and at least one
  dependency per covered ecosystem (npm, crates.io, PyPI) shows it.
- `repositories.local.problems` carries no lookup error for a covered ecosystem. The two
  "Unknown error fetching default owner preset" entries are the one expected exception; any other
  entry is named with its cause and judged before the source ships enabled.
- GitHub Actions dependencies skipped with `github-token-required` are expected in a
  credential-free run and do not count against the gate.

If any line fails, the source ships behind `sources: ["renovate"]` with the default off, and a
native Docker row moves into v1.

## Findings

I answered questions 1, 2, 3 and 5 by reading, on 2026-11-04, for
[Research: Renovate local-platform output and deps.dev/OSV limits](https://github.com/JesusFilm/phoebe/issues/751).
Renovate claims cite its docs and its source at tag
[`44.210.0`](https://github.com/renovatebot/renovate/tree/44.210.0), the latest release on npm that
day. To check the reading I ran that version once against a scratch git directory holding a
`package.json`, a `Cargo.toml`, a `requirements.txt` and one workflow file, with nothing in the
environment but `PATH` and `HOME`. That run is a smoke test, not the spike. Question 4 belongs to
the spike.

### 1. The output channel is the report file

Set `reportType` to `file` and Renovate writes one JSON document to `reportPath` when the run ends
([`reportType`](https://docs.renovatebot.com/self-hosted-configuration/#reporttype),
[`reportPath`](https://docs.renovatebot.com/self-hosted-configuration/#reportpath)). The global
worker writes it after every repository has run
([`workers/global/index.ts:261`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/global/index.ts#L261)).
This is the channel to parse.

The JSON log carries the same data in a debug record whose message is `packageFiles with updates`
([`extract-update.ts:361`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/process/extract-update.ts#L361)).
No docs page promises that message or its shape. The docs only say dry-run information is
"provided mainly in debug log level"
([`dryRun`](https://docs.renovatebot.com/self-hosted-configuration/#dryrun)). Parsing it would
fail the acceptance line about inferring the channel from a log line's shape.

On the local platform Renovate names its one repository `local`
([`autodiscover.ts:29`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/global/autodiscover.ts#L29)),
so everything lives under `repositories.local`. Its `packageFiles` maps a manager name to a list
of package files, each with a `packageFile` path and a `deps` list
([`RepoReport`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/instrumentation/types.ts#L54),
[`PackageFile`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/manager/types.ts#L127)).
The repository worker fills it from the combined extract-and-lookup result
([`workers/repository/index.ts:124`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/index.ts#L124)),
so the lookups' `updates` arrays are in the report. Field names are from
[`PackageDependency` and `LookupUpdate`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/manager/types.ts#L144).

| Candidate field   | Report path                                 | Notes                                                                                 |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| manager           | the key in `packageFiles`                   | `npm`, `cargo`, `pip_requirements`, `github-actions`                                  |
| package           | `deps[].packageName`, else `deps[].depName` | `depName` is the display name                                                         |
| current version   | `deps[].currentVersion`                     | `currentValue` is the raw specifier, `==2.31.0` where `currentVersion` is `2.31.0`    |
| dependency type   | `deps[].depType`                            | `dependencies`, `devDependencies`, `action`                                           |
| owning package    | `packageFile`                               | the manifest path, relative to the checkout                                           |
| proposed version  | `deps[].updates[].newVersion`               | one entry per proposal, so a minor and a major can both appear                        |
| update type       | `deps[].updates[].updateType`               | `major`, `minor`, `patch`, `digest`, `pin` and others, set in [`generate.ts:83`][gen] |
| release timestamp | `deps[].updates[].releaseTimestamp`         | only when the datasource returns one ([`generate.ts:39`][gen39])                      |
| not looked up     | `deps[].skipReason`                         | `github-token-required` matters most, see question 3                                  |
| run problems      | `repositories.local.problems`               | every warning and error the run logged, which is where a GitHub 403 shows up          |

[gen]: https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/process/lookup/generate.ts#L83
[gen39]: https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/process/lookup/generate.ts#L39

One dependency from the smoke run's report, trimmed to the fields above:

```json
{
  "packageFile": "package.json",
  "dep": {
    "depName": "typescript",
    "packageName": "typescript",
    "depType": "devDependencies",
    "datasource": "npm",
    "currentValue": "5.4.5",
    "currentVersion": "5.4.5",
    "updates": [
      {
        "updateType": "minor",
        "newVersion": "5.9.3",
        "releaseTimestamp": "2025-09-30T21:19:38.784Z"
      },
      {
        "updateType": "major",
        "newVersion": "7.0.2",
        "releaseTimestamp": "2026-07-08T15:55:18.431Z"
      }
    ]
  }
}
```

Two things to know before relying on it. Both `reportType` and the local platform are marked
`experimental: true` in source
([`options/index.ts:648`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/config/options/index.ts#L648),
[`platform/local/index.ts:11`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/platform/local/index.ts#L11)),
and the docs generator prints "Experimental features might be changed or even removed at any time"
for that flag
([`tools/docs/platforms.ts:30`](https://github.com/renovatebot/renovate/blob/44.210.0/tools/docs/platforms.ts#L30)).
The pin in the image makes that tolerable. Every bump of the pin should re-run the parser's test
against a report from the new version, because nothing upstream promises the shape holds.

The second is Cargo. The smoke run proposed nothing for `serde = "1.0.150"` even though 1.0.229
exists. That is by design. Cargo's default range strategy is `update-lockfile`
([`cargo/range.ts:14`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/manager/cargo/range.ts#L14)),
1.0.229 already satisfies the caret requirement, and the scratch directory had no `Cargo.lock` to
move. Whether "in range but the lockfile is behind" counts as a candidate is a question for the
candidate contract. It is not a Renovate bug, and the native Rust row will meet the same case.

### 2. `lookup` is the cheapest level that queries registries, and the local platform defaults to it

The docs list four values. `extract` "performs a very quick package file scan to identify the
extracted dependencies", `lookup` also identifies "updates available", and `full` logs the branch
and PR work instead of doing it
([`dryRun`](https://docs.renovatebot.com/self-hosted-configuration/#dryrun)). The source matches.
`extractDependencies` returns straight after extraction when `dryRun` is `extract` and calls
`lookup` otherwise
([`process/index.ts:237`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/process/index.ts#L237)),
and the repository worker skips all branch and PR work for both `extract` and `lookup`
([`workers/repository/index.ts:132`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/index.ts#L132)).

The local platform settles it anyway. Its `initPlatform` returns `extract` when asked for `extract`
and `lookup` for everything else, `full` included
([`platform/local/index.ts:14`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/platform/local/index.ts#L14),
[local platform docs](https://docs.renovatebot.com/modules/platform/local/)). The flag can be left
off. I would still pass `--dry-run=lookup` so the command says what it does. In the smoke run,
`--dry-run=extract` produced the same dependencies with no `updates` arrays.

### 3. No credential is needed to run, but GitHub Actions come back empty without one

The local platform asks for no token. `initPlatform` takes none and returns
`requireConfig: 'optional'`
([`platform/local/index.ts:13`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/platform/local/index.ts#L13)).
The smoke run under `env -i` exited 0 in 2.6 seconds, with npm and PyPI updates and their
timestamps filled in.

GitHub Actions pay for it. The `github-actions` manager maps `uses: owner/repo@v4.1.0` to the
`github-tags` datasource
([`github-actions/extract.ts:165`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/manager/github-actions/extract.ts#L165)).
After extraction Renovate looks for a token for `api.github.com`. With none, and with
`githubTokenWarn` at its default of `true`, it marks every `github-tags`, `github-releases` and
`github-release-attachments` dependency `skipReason: github-token-required`
([`check-token.ts:24`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/util/check-token.ts#L24),
default at
[`options/index.ts:951`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/config/options/index.ts#L951)).
The smoke run skipped both of its actions that way.

Turning the warning off does not help. With `--github-token-warn=false` Renovate tries the lookup,
but `github-tags` goes through GitHub's GraphQL API
([`github-tags/index.ts:80`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/datasource/github-tags/index.ts#L80)),
and GraphQL needs authentication
([GitHub docs](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql)).
The smoke run got two 403s from `api.github.com/graphql` and logged "Rate limit exceeded for
api.github.com, as no hostRules set for this host", and that message is wrong. The REST quota
still read 58 of 60 afterwards. The actions came back with no `updates` and no `skipReason`. A silent empty
is worse than a labelled skip, so leave the warning on and read `github-token-required` as "Renovate
did not cover this dependency".

So with no credential, the Renovate source covers no GitHub Actions and nothing else served by the
`github-tags` or `github-releases` datasources. This sits awkwardly with the ADR's "It never
touches GitHub". Either the native Actions row is the only Actions coverage, or the detector hands
Renovate a read-only `RENOVATE_GITHUB_COM_TOKEN`
([running Renovate](https://docs.renovatebot.com/getting-started/running/#githubcom-token-for-changelogs-and-tools)).
That is a decision for the map, not for this note. I did not test Docker lookups.

Every local run also logs "Unknown error fetching default owner preset" twice. It comes from
onboarding config resolution asking for a `local>` preset
([`onboarding/branch/config.ts:70`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/onboarding/branch/config.ts#L70)),
which the local platform cannot serve, as the Limitations list in its docs says. It is harmless,
and the parser should not count it as a failure.

### 4. Time and memory on `JesusFilm/core`

I ran the spike on 2026-11-04 for
[#752](https://github.com/JesusFilm/phoebe/issues/752), against `JesusFilm/core` at
[`af4e1fd`](https://github.com/JesusFilm/core/commit/af4e1fd5533df6954d781ea7ccbf7154b178b541), its
`main` that afternoon. The image is the consumer template, `templates/container/Dockerfile`,
rendered for `phoebe-agent@0.16.0`, with one more layer for Renovate `44.210.0`. I cloned core
once, from inside the image, onto a named volume. Every run then started a fresh container, so
Renovate's cache was cold each time. `env -i` cut Renovate's environment down to `PATH`, `HOME`,
`LOG_FORMAT` and `LOG_LEVEL`, and each run saved that environment beside its report. The host was
Docker Desktop 29.8.1 on WSL2 with 10 CPUs, 62 GB of memory and no container limit.

I built the image three ways and ran each three times. Build A is what the ticket describes,
`npm install -g renovate@44.210.0` on the image's own Node 26. Build B is what build A's failures
pointed to. It gives Renovate its own Node 24 and a global config that turns the GitHub datasources
off. Build C keeps the image's Node 26, compiles `re2` in a builder stage, and adds one
`logLevelRemap` entry to build B's config. "Flags and versions used" has all three. The extra B
rows are one run at `LOG_LEVEL=info`, one with every GitHub host resolved to `127.0.0.1`, and two
under a container memory limit. Build C repeats the blocked run.

| Build | Run              | Exit | Wall time | Peak RSS | Container peak | Candidates | Sorted-list hash   |
| ----- | ---------------- | ---- | --------- | -------- | -------------- | ---------- | ------------------ |
| A     | 1                | 1    | 51.9 s    | 2.87 GiB | 2.92 GiB       | 346        | `53a3142f1b613fdb` |
| A     | 2                | 1    | 55.2 s    | 2.65 GiB | 2.70 GiB       | 346        | `53a3142f1b613fdb` |
| A     | 3                | 1    | 54.1 s    | 3.04 GiB | 3.10 GiB       | 346        | `53a3142f1b613fdb` |
| B     | 1                | 0    | 65.7 s    | 2.90 GiB | 2.95 GiB       | 346        | `53a3142f1b613fdb` |
| B     | 2                | 0    | 67.0 s    | 2.85 GiB | 2.90 GiB       | 346        | `53a3142f1b613fdb` |
| B     | 3                | 0    | 63.7 s    | 2.89 GiB | 2.94 GiB       | 346        | `53a3142f1b613fdb` |
| B     | `LOG_LEVEL=info` | 0    | 62.5 s    | 2.88 GiB | 2.93 GiB       | 346        | `53a3142f1b613fdb` |
| B     | GitHub blocked   | 0    | 62.7 s    | 2.88 GiB | 2.93 GiB       | 346        | `53a3142f1b613fdb` |
| B     | 4 GiB limit      | 0    | 64.1 s    | 2.80 GiB | 2.84 GiB       | 346        | `53a3142f1b613fdb` |
| B     | 2 GiB limit      | 134  | 49.9 s    | 1.67 GiB | 1.68 GiB       | no report  |                    |
| C     | 1                | 0    | 62.8 s    | 2.80 GiB | 2.87 GiB       | 346        | `53a3142f1b613fdb` |
| C     | 2                | 0    | 61.6 s    | 2.87 GiB | 2.92 GiB       | 346        | `53a3142f1b613fdb` |
| C     | 3                | 0    | 62.9 s    | 2.80 GiB | 2.84 GiB       | 346        | `53a3142f1b613fdb` |
| C     | GitHub blocked   | 0    | 62.5 s    | 3.17 GiB | 3.23 GiB       | 346        | `53a3142f1b613fdb` |

Peak RSS is GNU `time`'s maximum resident set size for the Renovate process. Container peak is
the cgroup's `memory.peak`, which also counts page cache. The hash is over the sorted list of
manager, package file, dependency type, package, current version, new version, update type and
release timestamp. Every run left `git status` clean.

**Build A exits 1 on every run, and the cause is the Node version.** Renovate `44.210.0` declares
`engines.node: ^24.11.0`, and so does `44.216.2`, the latest on npm that day. On Node 26 it logs
"Unsupported node environment detected" at error level. Renovate exits non-zero whenever it has
logged an error ("Renovate is exiting with a non-zero code due to the following logged errors"),
so an otherwise complete report comes with exit 1. Build A also lost `re2`. The image's npm 11.20
skips install scripts on a global install unless told otherwise, `re2` needs one, and Renovate
logs "RE2 not usable, falling back to RegExp". Build B's npm 11.16 warned about the same scripts
but ran them. Builds B and C both use `re2` and take 62 to 67 seconds, while build A falls back to
`RegExp` and takes 52 to 55. So `re2` probably costs the ten seconds. I did not time it in
isolation.

**Build C shows Node 26 itself is fine.** Renovate has no switch for its version check, but the
check runs right after Renovate applies the global `logLevelRemap`
([`global/index.ts:190`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/global/index.ts#L190)).
One remap entry turns "Unsupported node environment detected" into a warning. The message stays in
the report's top-level `problems` at level 40, and the run exits 0. Getting `re2` onto Node 26
needed one more step. Allowing its install script was not enough on its own. The script downloads
the Node 26 prebuilt, `linux-x64-147.br`, which links against glibc 2.38, and the image's bookworm
base has 2.36. Loading it fails with "version `GLIBC_2.38' not found". The script then tries
`node-gyp`, which finds no Python in the slim image, and npm drops `re2`as a failed optional
dependency without failing the install. Build C installs Renovate in a`node:26-bookworm` builder
stage, which has the compilers, and copies the result in. Node 24's prebuilt loads on bookworm,
which is why build B never hit this.

**Build A still sends two requests to GitHub.** Core calls its own reusable workflows as
`JesusFilm/core/.github/workflows/<file>.yml@main`, 14 times. Renovate maps those to the
`github-digest` datasource, and the token check from question 3 does not cover that datasource.
Renovate sent two `POST https://api.github.com/graphql` requests for them, and both got 403. Each
of the 14 came back with
`warnings: ["Failed to look up github-digest package JesusFilm/core: no-result"]`, and the run
logged the problem "Rate limit exceeded for api.github.com". So the token warning alone does not keep Renovate off
GitHub. Build B's global config disables `github-tags`, `github-releases`,
`github-release-attachments`, `github-digest` and `github-runners` through `packageRules`. The 14
dependencies then come back `skipReason: disabled` with no request. Renovate's debug log only
records requests that fail, so I proved the "no request" part with one more run that resolved
`github.com`, `api.github.com` and `raw.githubusercontent.com` to `127.0.0.1`. It produced the same
report and no connection errors. The tags and releases dependencies keep `github-token-required`.
The token check sets that skip reason before lookup, and the lookup stage returns early for any
dependency that already has one, before it applies `packageRules`
([`fetch.ts:81`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/process/fetch.ts#L81)).

**The candidate list holds still.** Both builds produced the same 346 candidates on every run: 321
npm, 9 Dockerfile, 8 Terraform, 6 Docker Compose, 1 devcontainer and 1 nvm. By update type that
is 195 minor, 98 major and 53 patch. Renovate read core's own `renovate.json` ("Found renovate.json
config file"), so a consumer's Renovate config shapes what the source reports.

**Memory is the main cost.** Renovate held about 2.9 GiB on core whether it logged at debug or
info. Node sizes its default heap from the container's memory limit. Under a 2 GiB limit it died
at 1.67 GiB with "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed -
JavaScript heap out of memory", exit 134, and wrote no report. Under 4 GiB it passed. The compose
templates set no limit, so a consumer is only exposed if they add one or run on a small host. This
repo took 7.7 seconds and 0.96 GiB.

**`registryUrl` is the field that proves a lookup completed.** The lookup copies `registryUrl`,
`sourceUrl`, `lookupName` and `mostRecentTimestamp` onto the dependency only after
`getRawPkgReleases` returns releases
([`lookup/index.ts:160`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/process/lookup/index.ts#L160),
[`lookup/index.ts:196`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/process/lookup/index.ts#L196)).
The datasource layer fills `registryUrl` in for every result
([`datasource/index.ts:145`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/datasource/index.ts#L145)).
A failed lookup returns early with a `warnings` entry and none of those fields
([`lookup/index.ts:173`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/workers/repository/process/lookup/index.ts#L173)).
That is the 403 case. The 14 `github-digest` dependencies in build A have `updates: []`, a
`warnings` entry, and no `registryUrl`. The rule for the parser is that a dependency was looked up
when `registryUrl` is set and `warnings` is empty, and it is up to date when `updates` is also
empty. All 91 up-to-date dependencies in core's report carry `registryUrl`: 81 npm, 5 Docker,
2 PyPI, 2 Terraform providers and the root `node` engine.

| Ecosystem | Dependency                                                | `currentValue` | `registryUrl`                    | `updates` | `warnings` |
| --------- | --------------------------------------------------------- | -------------- | -------------------------------- | --------- | ---------- |
| npm       | `@apollo/client-integration-nextjs` (`package.json`)      | `^0.14.5`      | `https://registry.npmjs.org`     | `[]`      | `[]`       |
| PyPI      | `google-genai` (a skill's `requirements.txt`)             | `>=1.0.0`      | `https://pypi.org/pypi`          | `[]`      | `[]`       |
| crates.io | `serde` (scratch `Cargo.toml`)                            | `1.0.150`      | `sparse+https://index.crates.io` | `[]`      | `[]`       |
| Docker    | `ghcr.io/devcontainers/features/docker-outside-of-docker` | `1`            | `https://ghcr.io`                | `[]`      | `[]`       |

Core has no Cargo manifest, so crates.io cannot be shown on core. The `serde` row comes from a
scratch directory run through build B. Core's only PyPI dependencies sit in a vendored skill under
`.claude/skills/`, and both were up to date.

**`repositories.local.problems` holds one entry in builds B and C.**

- "GitHub token is required for some dependencies". The 163 `github-tags` and 33 `github-releases`
  dependencies skipped as `github-token-required`. The gate expects this.
- Build A adds "Rate limit exceeded for api.github.com, as no hostRules set for this host". That is
  the `github-digest` 403 above, and build B's config removes it.
- The two "Unknown error fetching default owner preset" entries do not appear on core or on this
  repo. Both carry a `renovate.json`, so onboarding never asks for the `local>` preset. The scratch
  Cargo directory had no config file, and it logged both.

Build A also has two entries in the report's top-level `problems`, outside `repositories.local`.
They are the Node version error and the `re2` warning. Build B has none. Build C has one, the
Node version message remapped to a warning. The other skip reasons in
core's report mark dependencies Renovate never tried to look up, so they are not lookup errors:

- `local`, 63 workspace packages.
- `unspecified-version`, 20 `deb` and 26 `apk` packages in Dockerfiles, 23 npm entries, 18
  Terraform providers and 1 Python version.
- `invalid-version`, 5 `runs-on` runner labels.
- `invalid-value`, 3 Compose images tagged `latest`, 1 Node version and 1 dependency with no
  datasource.
- `unversioned-reference`, 1 action.

**Docker works with no credential, but no Docker candidate has a release date.** Core has 22 Docker
dependencies across Docker Hub, GHCR and MCR. Renovate looked up 19, skipped the 3 `latest` tags,
and failed none. It proposed 16 updates, and none of them carry a `releaseTimestamp`. Renovate
documents dates as "Only supported on Docker Hub"
([`docker/index.ts:101`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/datasource/docker/index.ts#L101)),
and core's three Docker Hub images lose them too. Renovate pages Docker Hub's tag API until it has
every tag
([`docker/index.ts:1162`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/datasource/docker/index.ts#L1162)).
`node`, `postgres` and `clickhouse/clickhouse-server` each have more than 1,000 tags, and Docker Hub
refuses page 11 to an anonymous caller with 403 "pagination offset too large for anonymous requests;
sign in to page further". Renovate then falls back to the registry's tag list, which has no dates
([`docker/index.ts:1263`](https://github.com/renovatebot/renovate/blob/44.210.0/lib/modules/datasource/docker/index.ts#L1263)).
The maturity policy waits on a publish date, so the candidate contract needs a rule for a Docker
candidate that has none.

### 5. deps.dev and OSV publish no rate limits

**deps.dev.** The [v3](https://docs.deps.dev/api/v3/) and
[v3alpha](https://docs.deps.dev/api/v3alpha/) references and the [FAQ](https://docs.deps.dev/faq/)
name no rate limit or quota. The project README says use falls under the Google API Terms of
Service and that "Clients are expressly permitted to cache data served by the API"
([`google/deps.dev` README](https://github.com/google/deps.dev#terms)). A response on 2026-11-04
carried `cache-control: public, max-age=3600`, `access-control-allow-origin: *` and
`via: 1.1 google`, and no `x-ratelimit-*` or `retry-after`. With no budget to read, the client
should honour `cache-control` and back off on 429 and 5xx. The one-hour max-age lines up with an
hourly window anyway.

**OSV.** "Currently there are no limits on the API"
([API index](https://google.github.io/osv.dev/api/), repeated in the
[FAQ](https://google.github.io/osv.dev/faq/)). Responses are capped at 32 MiB over HTTP/1.1 and
uncapped over HTTP/2. The docs give no cap on queries per batch. The server rejects more than 1,000
with `InvalidArgument: too many queries`
([`query_affected.go:39`](https://github.com/google/osv.dev/blob/f40ffd96500cc83640a18922e12f3c5e7a45dd21/go/internal/api/query_affected.go#L39)).
A batch paginates when one query passes 1,000 advisories or the set passes 3,000
([`POST /v1/querybatch`](https://google.github.io/osv.dev/post-v1-querybatch/)). Observed headers
were `server: Google Frontend`, `grpc-status: 0`, `x-cloud-trace-context` and
`x-envoy-decorator-operation: ingress QueryAffectedBatch`, again with nothing rate-related.

**Versions with dates.** deps.dev's `GetPackage` lists every version with `publishedAt`, "if
available", plus `isDefault` and `isDeprecated`
([GetPackage](https://docs.deps.dev/api/v3/#getpackage)). Names are percent-encoded, and PyPI
names are PEP 503 normalised.

```
GET https://api.deps.dev/v3/systems/npm/packages/%40colors%2Fcolors
GET https://api.deps.dev/v3/systems/cargo/packages/serde
GET https://api.deps.dev/v3/systems/pypi/packages/requests
```

```json
{
  "versionKey": { "system": "NPM", "name": "@colors/colors", "version": "1.6.1" },
  "publishedAt": "2026-09-07T03:51:27Z",
  "isDefault": true,
  "isDeprecated": false,
  "deprecatedReason": ""
}
```

The list is not in version order. The last entry for `requests` was 2.9.2, so the client sorts with
the ecosystem's own comparison. In the sample, 160 of 161 `requests` versions had a `publishedAt`,
as did all of `serde` and `react`. v3 has no batch form of `GetPackage`, so a pass costs one GET per
package. v3alpha's `POST /v3alpha/versionbatch` takes up to 5,000 version keys
([GetVersionBatch](https://docs.deps.dev/api/v3alpha/#getversionbatch)), but it describes versions
you already name rather than listing new ones, and v3alpha "may change in incompatible ways".

deps.dev has no GitHub Actions system. The allowed values are `GO`, `RUBYGEMS`, `NPM`, `CARGO`,
`MAVEN`, `PYPI` and `NUGET`, and `/v3/systems/github_actions/...` answers 404 "package not found".
The Actions row has to get tags and dates from GitHub itself, where unauthenticated REST gets 60
requests an hour
([GitHub docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-unauthenticated-users),
`x-ratelimit-limit: 60` observed).

**Batch advisories.** One `querybatch` covers all four ecosystems. The ecosystem strings are `npm`,
`crates.io`, `PyPI` and `GitHub Actions`
([OSV schema](https://ossf.github.io/osv-schema/#affectedpackage-field)). Results come back in
input order and hold only `id` and `modified`, so each new advisory needs a
`GET /v1/vulns/{id}` for its severity and fixed versions
([`POST /v1/querybatch`](https://google.github.io/osv.dev/post-v1-querybatch/)).

```
POST https://api.osv.dev/v1/querybatch
{"queries":[
  {"package":{"ecosystem":"npm","name":"lodash"},"version":"4.17.15"},
  {"package":{"ecosystem":"crates.io","name":"time"},"version":"0.1.43"},
  {"package":{"ecosystem":"PyPI","name":"jinja2"},"version":"3.1.4"},
  {"commit":"a284dc1814e3fd07f2e34267fc8f81227ed29fb8"}
]}
```

On 2026-11-04 that returned 5, 2, 6 and 1 advisories. The last line is the GitHub Actions query, and
it is a commit for a reason. A version query for `tj-actions/changed-files` at `45.0.7`, or at
`v45.0.7`, came back empty, even though GHSA-mrrh-fwg8-r2c3 lists that package as affected from 0
up to the fix in 46.0.1. A query by package alone returned GHSA-mrrh-fwg8-r2c3 and
GHSA-mcph-m25j-8j63. A query by the commit that tag points at returned CVE-2025-30066. OSV's GitHub
Actions enricher adds git ranges with resolved commit SHAs to these advisories
([`githubactions.go`](https://github.com/google/osv.dev/blob/f40ffd96500cc83640a18922e12f3c5e7a45dd21/go/internal/worker/pipeline/githubactions/githubactions.go#L64)),
which explains why the commit query works. Neither the docs nor the source I read explain why the
version query misses. For Actions, query by the pinned or resolved commit SHA, or fetch the
package's advisories and compare ranges locally.

**Request count for this repo.** Three `package.json` files hold 24 unique npm packages, and the
workflows use 7 third-party actions. One pass is 24 deps.dev GETs, one OSV batch, and one
`GET /v1/vulns/{id}` per advisory not already cached by `modified`. Hourly, that is 576 deps.dev
calls and 24 batches a day, an upper bound since the security detector does not need deps.dev's
version lists every hour. The `JesusFilm/core` count belongs to the spike.

**Measured pass.** For #752 I ran one pass's worth of requests against both repos on 2026-11-04. The
dependency list came from each repo's build B Renovate report: every npm, PyPI or crates.io
dependency that Renovate did not skip, at its `lockedVersion`, else its `currentVersion`. It made
one deps.dev `GetPackage` per unique package, eight at a time. It sent one OSV `querybatch` per
1,000 queries, with the SHA-pinned actions as commit queries, followed any `next_page_token`, and
then made one `GET /v1/vulns/{id}` per advisory ID returned. A second OSV pass covered every unique
`name@version` in `pnpm-lock.yaml`, the shape a security pass over transitive packages takes. This
repo's lockfile holds two YAML documents. pnpm 11 writes its own toolchain into the first, so the
count comes from the second.

| Request                            | `JesusFilm/core`             | this repo                   |
| ---------------------------------- | ---------------------------- | --------------------------- |
| deps.dev `GetPackage`              | 332 (330 npm, 2 PyPI), 3.7 s | 24 npm, 0.5 s               |
| OSV `querybatch`, direct           | 1 batch, 336 queries         | 1 batch, 27 queries         |
| OSV `GET /v1/vulns/{id}`, direct   | 163                          | 6                           |
| OSV `querybatch`, lockfile         | 5 batches, 4,526 queries     | 1 batch, 592 queries        |
| OSV `GET /v1/vulns/{id}`, lockfile | 424, 14.1 s for the pass     | 28                          |
| GitHub Actions refs                | 27 unique refs, 1 SHA-pinned | 5 unique refs, 3 SHA-pinned |

Every response was a 200. None carried a header with "rate" or "retry" in its name, and there were
no 429s to back off from. Hourly, core's direct pass comes to 7,968 deps.dev GETs and 24 OSV
batches a day, and the lockfile pass to 120 OSV batches. Advisory fetches drop after the first
pass for a client that caches by `modified` and re-fetches only when it changes. Neither service
documents a limit to measure these against. The only number in play is OSV's server-side cap of
1,000 queries per batch, and core's lockfile needs five batches to stay under it.

The Actions row did not run in this pass. The 26 tag refs in core would need resolving to commit
SHAs for OSV, through GitHub's unauthenticated REST API at 60 requests an hour.

### The gate, and which outcome applies

| Acceptance line                                | Build A                             | Build B                            | Build C                           |
| ---------------------------------------------- | ----------------------------------- | ---------------------------------- | --------------------------------- |
| Three runs finish within 20 minutes and exit 0 | fails, exit 1 on Node 26            | passes, 64 to 67 s, exit 0         | passes, 62 to 63 s, exit 0        |
| Identical candidate list across runs           | passes                              | passes                             | passes, and matches build B       |
| No GitHub credential in the environment        | passes                              | passes                             | passes                            |
| Documented output channel                      | passes, `--report-type=file`        | passes                             | passes                            |
| Proof field shown per covered ecosystem        | `registryUrl`, npm and PyPI on core | same, crates.io on a scratch crate | same as build B                   |
| No `problems` entry beyond the expected ones   | fails, the `github-digest` 403      | passes                             | passes, plus the remapped warning |
| `github-token-required` skips do not count     | 196 skipped                         | 196 skipped                        | 196 skipped                       |

Build A, the image as the ticket describes it, fails two lines. Builds B and C pass all of them.
Both failures have causes the install controls, so I read the result as the Renovate source
shipping enabled, as long as #760 installs it the way build B or build C does.

I would ship build C. It keeps one Node in the image, so the execute-only `node` stays the only
`node`, and its Renovate layer is 460 MB against build B's 836 MB. The cost is that Renovate runs
outside its declared `engines` range, and upstream does not test there. The pin and the parser
test that re-records on every bump (#760) are what catch a break, and build B is the fallback if
one comes. Build C also carries a builder stage for `re2` until either `re2` ships a prebuilt for
glibc 2.36 or the image moves off bookworm. What #760 needs either way:

- Renovate runs on the image's Node 26 with the `logLevelRemap` entry for the version check, or
  on its own Node 24 as in build B. The parser expects the remapped "Unsupported node environment
  detected" warning in the top-level `problems` and does not count it.
- `re2` is present. On Node 26 that means building it from source, since a skipped or failed
  install script drops it silently.
- The source passes a global config that disables `github-tags`, `github-releases`,
  `github-release-attachments`, `github-digest` and `github-runners`. That config, not the token
  warning, is what keeps Renovate off GitHub.
- The source expects about 3 GiB of memory on a repo the size of core. Under a container limit
  below 4 GiB it should raise Node's heap with `--max-old-space-size`, or the run dies with no
  report.
- The parser treats a dependency as looked up only when it has `registryUrl` and no `warnings`.

Docker stays on Renovate in v1, and no native Docker row is needed. Renovate covers Docker Hub, GHCR
and MCR with no credential. The gap is release dates, which Renovate never reports for GHCR or MCR
and loses for any Docker Hub image with more than 1,000 tags. That is a policy question for the
candidate contract, not a reason to build a row. If the map would rather not depend on either
install, the fallback is the one the acceptance section names. The source ships behind
`sources: ["renovate"]` with the default off, and a native Docker row moves into v1.

## Flags and versions used

The reading and smoke run above used Renovate `44.210.0` from npm on Node `v24.18.1`, deps.dev at
`api.deps.dev/v3`, and OSV at `api.osv.dev/v1`. The smoke run's command:

```sh
env -i PATH="$PATH" HOME="$scratch_home" LOG_FORMAT=json LOG_LEVEL=debug \
  renovate --platform=local --report-type=file --report-path=/tmp/renovate-report.json
```

Rerun with `RENOVATE_GITHUB_TOKEN_WARN=false` for the GraphQL test, and with `--dry-run=extract`
for the comparison in question 2. The spike's own flags go below.

The spike ran on 2026-11-04 with Docker Desktop 29.8.1 on WSL2 (kernel `6.6.87.2`), 10 CPUs and 62
GB of memory. `JesusFilm/core` was at `af4e1fd5533df6954d781ea7ccbf7154b178b541` and this repo at
`53b3c5ff4d8e1f6c76337cfc99edfbabec9807e0`.

The base image is `templates/container/Dockerfile` with `{{CLI_BIN}}` set to `phoebe-agent`,
`{{INSTALL_COMMAND}}` set to `pnpm install --frozen-lockfile`, and
`--build-arg PHOEBE_AGENT_VERSION=0.16.0`. It runs Node `v26.13.0` and npm 11.20.0. I did not use
the dogfood `.phoebe/container/Dockerfile`, because `main`'s copy no longer builds. Node 26 ships
no corepack, so its `corepack enable` step exits 127.

Build A adds one layer, 648 MB:

```dockerfile
FROM phoebe-runtime:spike-752-base
USER root
ARG RENOVATE_VERSION=44.210.0
RUN apt-get update && apt-get install -y --no-install-recommends time && rm -rf /var/lib/apt/lists/* \
 && npm install -g "renovate@${RENOVATE_VERSION}"
USER phoebe
```

Build B takes Node `v24.18.1` and npm 11.16.0 from `node:24-bookworm-slim` and installs Renovate
with them under its own prefix. The three layers come to 836 MB:

```dockerfile
FROM node:24-bookworm-slim AS node24
FROM phoebe-runtime:spike-752-base
USER root
COPY --from=node24 /usr/local/bin/node /opt/node24/bin/node
COPY --from=node24 /usr/local/lib/node_modules/npm /opt/node24/lib/node_modules/npm
ARG RENOVATE_VERSION=44.210.0
RUN apt-get update && apt-get install -y --no-install-recommends time && rm -rf /var/lib/apt/lists/* \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/node24/bin/npm \
 && PATH=/opt/node24/bin:$PATH npm install -g --prefix /opt/renovate "renovate@${RENOVATE_VERSION}" \
 && printf '#!/bin/sh\nexec /opt/node24/bin/node /opt/renovate/lib/node_modules/renovate/dist/renovate.js "$@"\n' \
      > /usr/local/bin/renovate \
 && chmod 0755 /usr/local/bin/renovate
USER phoebe
```

GNU `time` is there for the RSS measurement only. Build B's second Node is not made execute-only
the way the image's own `node` is. Renovate holds no secret here, but #760 should decide that
deliberately.

Build C installs Renovate with npm 11.20.0 in a `node:26-bookworm` builder stage, where `re2`
compiles from source in about 35 seconds, and copies it into the base image. The Renovate layer is
460 MB, and the image's Node `v26.13.0` runs it:

```dockerfile
FROM node:26-bookworm AS renovate-build
ARG RENOVATE_VERSION=44.210.0
RUN npm install -g --allow-scripts=re2 "renovate@${RENOVATE_VERSION}" \
 && test -f /usr/local/lib/node_modules/renovate/node_modules/re2/build/Release/re2.node

FROM phoebe-runtime:spike-752-base
USER root
RUN apt-get update && apt-get install -y --no-install-recommends time && rm -rf /var/lib/apt/lists/*
COPY --from=renovate-build /usr/local/lib/node_modules/renovate /usr/local/lib/node_modules/renovate
RUN ln -s ../lib/node_modules/renovate/dist/renovate.js /usr/local/bin/renovate
USER phoebe
```

Build B's global config, passed as `RENOVATE_CONFIG_FILE`:

```json
{
  "packageRules": [
    {
      "matchDatasources": [
        "github-digest",
        "github-tags",
        "github-releases",
        "github-release-attachments",
        "github-runners"
      ],
      "enabled": false
    }
  ]
}
```

Build C's config is the same with one more top-level key:

```json
{
  "logLevelRemap": [
    {
      "matchMessage": "Unsupported node environment detected*",
      "newLogLevel": "warn"
    }
  ]
}
```

Each run, as the `phoebe` user in a fresh container with the checkout on a named volume:

```sh
cd /data/repos/core
/usr/bin/time -v -o "$out/time.txt" \
  env -i PATH="$PATH" HOME="$HOME" LOG_FORMAT=json LOG_LEVEL=debug \
    RENOVATE_CONFIG_FILE=/spike/global-config.json \
  renovate --platform=local --dry-run=lookup \
    --report-type=file --report-path="$out/report.json"
cat /sys/fs/cgroup/memory.peak
```

Build A ran the same command without `RENOVATE_CONFIG_FILE`. The blocked run added
`--add-host` entries mapping `api.github.com`, `github.com` and `raw.githubusercontent.com` to
`127.0.0.1`. The memory-limited runs added `--memory=2g --memory-swap=2g` and
`--memory=4g --memory-swap=4g`. The deps.dev and OSV pass used Node's `fetch` against
`api.deps.dev/v3` and `api.osv.dev/v1`, with no credentials.
