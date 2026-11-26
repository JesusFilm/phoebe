---
"phoebe-agent": minor
---

Add `phoebe history` and `GET /api/history` for reading unit records. Both run the same query and return the same `HistoryPage`: `records` newest first, a `summary` of everything the filters matched, `nextBefore` for the next page, and `retained`, the oldest record each pipeline still holds. The filters are cell (`--tenant` and `--pipeline` on the CLI), kind, outcome, provider, model and since. A page holds 50 records by default and at most 200; a larger limit is cut to 200. The CLI prints a table whose cost column marks subscription estimates with "est." and shows "—" when no cost was reported. `--json` prints the page. The route needs a session with `read` scope. A history line with a record version the reader does not know is skipped.
