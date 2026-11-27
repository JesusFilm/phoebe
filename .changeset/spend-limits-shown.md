---
"phoebe-agent": minor
---

Spend limits now show wherever you look. A warning limit reached puts a warning badge on the console rail and a `spend warning:` line under the pipeline in `phoebe status`, and sends one `spend-warning` alert. Work goes on. A ceiling holding puts an error badge on the rail and a `spend ceiling:` line that reads "held until about <time>", and sends a `spend-ceiling` alert. `phoebe status --check` exits 1 for as long as the hold lasts. The overview's 7-day card and the fleet stats page list each configured limit next to the figure it is weighed against, along with when any hold should lift. There is no resume button. A config edit lifts a ceiling early. The deployment report carries every limit on each cell, in `cell.spend.limits`.
