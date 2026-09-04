---
"phoebe-agent": minor
---

`phoebe list` prints one line per pipeline (#427). A tenant is several rows now, and one engine-state column read from one status file could only ever describe one of them. The tenant row keeps what is true of the whole tenant — path, slug, the config/env/data flags, the credential arm, its hold reason, `(disabled)` — and beneath it every pipeline gets an indented line of its own. The implicit `work` row prints like any other; there is no collapsed form.

**The row set is the supervisor's.** `list` calls the same enumeration the supervisor spawns from, in its own process, so the two cannot disagree about what a tenant runs. A `state/<name>/` directory no enumerated row produces lists as `(stale)` with a legend line — the pipeline analogue of an `undeclared` tenant, reported and never acted on. A held tenant is one whose config could not be read, so there is no row set to ask for: beneath its held reason, `list` shows the snapshots that are on disk and marks each `(from disk)`.

**States, from each row's own snapshot and nothing else**: `no status`, `working k/N <units>` (`N` is the row's declared `concurrency`), `waiting for slot`, `idle`, and `wedged? <age>` beside a working row whose oldest unit has been running longer than its own `runBudgetMs` plus one poll interval. `wedged?` is a question — `list` reads files, not processes — and it is the only staleness claim made anywhere: an idle row is never wedged however old it is, and rows are never weighed against each other. `phoebe doctor` gains no wedged check.

**Solo lists its one tenant.** `phoebe list` in a solo deployment prints `[phoebe] 1 tenant (solo):`, the root's row, and its pipeline lines, instead of `No tenants`. That message now means what it says: nothing is declared here at all.

**`--json`**: every tenant gains `pipelines: [{ name, disabled, source, state, units, updatedAt, wedged }]` and loses the tenant-level `status` field — a reader that wants one row's snapshot names the row. `--check` is unchanged and still structural: exit 1 only on held declared tenants, whatever the pipeline lines say.
