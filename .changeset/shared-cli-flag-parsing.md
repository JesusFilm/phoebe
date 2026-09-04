---
"phoebe-agent": patch
---

`--config`/`-c` and `--pipeline` now parse the same way in every subcommand (#460). Between them the two flags had seven hand-written copies, and the copies had drifted: `phoebe --pipeline --dry-run` read `--dry-run` as the pipeline name, where the engine's own `parsePipelineName` rejected it, and `--config --json` did the same to `--json` under `phoebe`, `phoebe upgrade` and `phoebe migrate`. The stricter reading wins everywhere — the next flag was never the value, and swallowing it dropped the flag that was actually typed — so a `-`-prefixed word is now refused, as is a `--config=` with nothing after it. One implementation, in `src/cli-flags.ts`; the parsers keep their own argv loops and their own unknown-argument errors.
