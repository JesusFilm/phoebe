# Security relevance is asked where the fix costs something

The first `dependency-security` scan of `JesusFilm/youtube-studio` (2026-11-17)
filed 23 issues holding 151 rows, 146 of them transitive and 70 on development
dependencies, and 20 pull requests against one lockfile followed. Every
advisory was high or critical, so the threshold of
[ADR 0003](0003-dependency-updates-are-three-kinds-over-one-candidate-contract.md)
held. What a severity score cannot see is whether the tenant is exposed. A
grilling session on 2026-11-19 settled how the detector accounts for that, and
this record amends ADR 0003's threshold, tracking issues and security grouping.
The work is #888 to #892.

**Relevance is not judged before filing.** Deciding whether a vulnerable code
path is reachable costs more than moving a lockfile, and it is a call an agent
gets wrong. So a lockfile fix is applied without asking, and the question is
put only on a ticket that needs a manifest fix, to the implementer, which has
the checkout in front of it.

**The threshold is per dependency type.** `minSeverity` is `{ prod, dev }` in
both detectors, default `{ prod: "high", dev: "critical" }`. A development
dependency never ships, so a high against one is mostly denial of service
against the tenant's own build. Code execution at install or build time is
what matters there. An advisory of that kind rated critical is filed. One
rated high is under the default, and the Consequences say what becomes of it.

**Transitive fixes ride in one bundle per manager.** The implementer tries a
lockfile fix for each row. A row that needs more is dropped and filed again on
its own. `transitive: "individual"` restores one issue per package. The
detector cannot sort the two kinds of fix cheaply: `pnpm audit` prints the
names on each path but no ranges, and the hourly pass makes no registry
lookups.

**A critical is never queued.** It gets its own ticket, outside the bundle and
outside the cap, and its lockfile fix and manifest fix are tried in one run.
Everything else answers to `prConcurrentLimit`, default 5.

**A tracking issue needs someone who can act on it.** One is filed for a
direct dependency or a critical. A transitive high with no fix files nothing
until the fix ships.

**A ticket that needs a manifest fix ends in a verdict.** "Not affected" has to
name the vulnerable function or input, the dependency that reaches the package,
and why that path never sees attacker-controlled input or never runs outside a
build. "Can't tell" gets the fix. The implementer never closes a ticket. On a
not-affected verdict the detector closes a high as not planned, which is a
dismissal, and parks a critical for a maintainer.

## Considered Options

- **Classify build-time from runtime packages in the detector.** Rejected. A
  transitive row counts as production when anything that pulls it in does, so
  `browserslist` under Next passes the production threshold. Telling the two
  apart takes the reading the verdict already does, with evidence.
- **Re-check a dismissal on a timer.** Rejected. It would file the same tickets
  again every period.
- **Have the detector look up each parent's range.** Rejected. It is a registry
  call per parent version on an hourly pass built to make none, and the
  implementer learns the answer by trying.

## Consequences

- With the defaults a high on a development dependency is not a security
  issue. On a direct dependency the release that fixes it goes out with the
  daily pass. Two cases are filed by neither detector: a transitive package
  reached only through development dependencies, because `dependency-updates`
  lists direct dependencies only, and a direct development dependency with no
  release that fixes the advisory, because `dependency-updates` files moves to
  a newer version. The scan log counts both, and `dev: "high"` brings them
  back.
- A dismissal has no expiry. It lifts when a new advisory id lands on the
  package or a person reopens the issue. It does not notice the tenant's code
  changing so that the vulnerable path becomes reachable.
- An agent's wrong "not affected" on a high closes the ticket with nobody
  looking. The evidence rule and the critical exception are the guard.
- Removing an override that is no longer needed is left out of this work.
