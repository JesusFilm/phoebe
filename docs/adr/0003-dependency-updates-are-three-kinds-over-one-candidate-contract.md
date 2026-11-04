# Dependency updates are three catalog kinds over one candidate contract

Consumers run hosted Renovate today. It opens a PR and stops, it knows nothing
about this repo's changeset gate (the `checks` kind patches its PRs, #655), and
it crashes on `JesusFilm/core`. The consumers also run more than npm: Rust,
Python, Docker and GitHub Actions. The grilling session behind #749
(2026-11-03) asked what a Phoebe-owned dependency bot would be for. The
answer is finishing the upgrade: reading the changelog, fixing what breaks,
satisfying the changeset gate, opening the PR. Detection is table stakes, and
it cannot depend on the one detector that is known to fall over.

So the feature is three catalog kinds, none built in, shipped under
`phoebe-agent/kinds/`. `dependency-updates` and `dependency-security` are
read-only detectors. Their `fetch` checks a window (`every`, one day and one
hour by default) and yields one synthetic unit; their `run` executes every
source concurrently under a per-source timeout, groups what came back, and
files or refreshes issues. `dependencies` is the implementer, an
issue-producer keyed by the `phoebe:dependencies` label with its own prompt
file. All three sit on one contract: a candidate is a manager, a package, a
current and a target version, an update type, a publish date, a dependency
type, an owning workspace package, a list of advisories, and the two inputs
`by-relation` grouping reads, the package's declared peer dependencies and its
source repository URL. The native rows read those two from the installed
package's manifest; a candidate from any other source gets them from the
deps.dev version record. Policy, grouping and filing never learn which source
produced a candidate.

Three sources feed that contract and are unioned. Two candidates are the same
occurrence, and merge, only when manager, package, current version, target,
dependency type and owning workspace package all match; the same package
wanted by two workspace packages stays two candidates, so `by-workspace` can
tell them apart. The native source is a table of ecosystem rows; a row only
lists direct dependencies with their current version using stock tooling, and
deps.dev answers what is newer and when it shipped while OSV answers what is
vulnerable, with the manager's own audit unioned in where it has one. An agent
fallback, on by default, covers manifests no row understands by writing
candidates to a JSON file that the engine validates. Renovate runs pinned in
the container image, on the local platform, in dry-run, and Phoebe parses its
output. Phoebe hands it no GitHub credential and leaves its token warning at
the default, which is what keeps it off GitHub: with a token, or with the
warning turned off, Renovate does call `api.github.com`. The cost is that
Renovate covers no GitHub Actions; the native Actions row does. A source that
fails is a log line, and the others' results stand.

## Considered options

- **Adopt Renovate's PRs.** The `checks` kind already repairs them. Rejected
  because Renovate's crashes stay visible to consumers, its PRs bypass the
  grouping and maturity policy, and the repo carries two bots.
- **Native detection only.** Rejected for v1 because Docker tags are not
  semver and need per-registry clients with their own auth, and because the
  union makes a Renovate crash cost nothing.
- **The agent enumerates.** Rejected as the primary path. Enumeration is where
  a model is slowest, costliest and least reliable; it is kept as the
  fallback for ecosystems the table does not know.
- **A sixth built-in kind for the implementer.** Built-ins are scheduled by
  default and every scheduled kind's prompt must exist at boot, so the upgrade
  would fail every consumer who never asked for a dependency bot. Instead the
  sweeps generalise: a kind declares what its units are keyed by and
  `sweep-scope.ts` reads that instead of the five names.
- **Dependabot alerts as the security source.** Needs a new permission on
  both auth arms, the App docs, the console's PAT URL and every install.
  Deferred to the webhook trigger, which needs it anyway. The package
  manager's audit plus OSV reads the same advisory database today.
- **A top-level `dependencies` config block.** The shared settings are two
  lists and a label. Per-kind options duplicate a few lines and need no schema
  or console change.

## Consequences

- Maturity is release age per update type (patch 3 days, minor 7, major 14).
  Security has a `minSeverity` threshold, default high; an advisory over it
  with a fixed version files a routed issue, including a pnpm override for a
  transitive package; one with no fix files a tracking issue with the
  `security` label and no routing label; one under it folds into the normal
  bundle and skips the wait for that package alone.
- Grouping is a strategy enum (`individual`, `all`, `by-dependency-type`,
  `by-workspace`, `by-relation`) with pattern overrides. Defaults: production
  `by-relation`, development `all`, security `individual`, majors individual
  unless `majors: "follow-strategy"`. A bundle never spans two ecosystems.
  Open dependency PRs are capped at 5. Nothing auto-merges.
- State lives in GitHub. An HTML marker in each issue carries the bundle key
  and a fingerprint of the package, version and advisory-id set. Same
  fingerprint, leave the issue; new fingerprint, update the body and comment;
  closed without a merged PR, veto that fingerprint for as long as it stays the
  same, so a newer version or a new advisory on the same version both lift the
  veto. A bump the
  implementer had to drop is re-filed on its own and stops after two failures
  per package-version. Window state is in memory, so a boot re-runs detection
  and files nothing new.
- Applying the routing label is a standing config decision, as it is for the
  Sentry kind's `applyReadyLabel`. `preparing-work.md` gains that sentence.
- The container image grows by a pinned Renovate, and the templates `init`
  scaffolds change with it.
- deps.dev and OSV rate limits are unmeasured at an hourly window on a large
  monorepo. The Renovate spike's acceptance test is in
  `docs/research/renovate-extraction-spike.md`; if it fails, the Renovate
  source ships disabled by default and Docker becomes the first native row
  added after v1.
- Hosted Renovate and `renovate.json` stay on this repo for now. Phoebe does
  not run here continuously, and a bot that only runs sometimes is not yet a
  replacement.
