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

(empty until the spike runs)

## Flags and versions used

(empty until the spike runs)
