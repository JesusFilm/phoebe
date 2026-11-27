---
"phoebe-agent": minor
---

You can now export unit history as CSV or JSON Lines. `phoebe history --export csv|jsonl` walks every page and writes each unit the filters match to stdout. The History tab in the console has an **Export** button with the same two formats. It fetches every page under the active filters, including the ones not loaded yet, shows progress, then says how many units it saved. The CSV has one row per unit, with tokens summed across its agent runs. API cost and estimated cost sit in separate columns and are never added together. JSON Lines is one full `HistoryRecord` per line. `phoebe-agent/contracts` now exports the mapping as `historyExportHead`, `historyExportLines`, `HISTORY_CSV_COLUMNS` and `HISTORY_EXPORT_FORMATS`, with `HISTORY_MAX_LIMIT`, so the CLI and the console write the same files. `--json` still prints one page.
