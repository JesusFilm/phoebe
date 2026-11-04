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

(empty until the spike runs)

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

## Flags and versions used

The reading and smoke run above used Renovate `44.210.0` from npm on Node `v24.18.1`, deps.dev at
`api.deps.dev/v3`, and OSV at `api.osv.dev/v1`. The smoke run's command:

```sh
env -i PATH="$PATH" HOME="$scratch_home" LOG_FORMAT=json LOG_LEVEL=debug \
  renovate --platform=local --report-type=file --report-path=/tmp/renovate-report.json
```

Rerun with `RENOVATE_GITHUB_TOKEN_WARN=false` for the GraphQL test, and with `--dry-run=extract`
for the comparison in question 2. The spike's own flags go below.

(empty until the spike runs)
