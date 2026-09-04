---
"phoebe-agent": patch
---

Solo boot lines name their pipeline (#457). #420 asked every `[phoebe] boot:` line to name a pipeline `<slug>:<pipeline>`, and only the workspace arm delivered it: solo's spawn failure read `engine failed to spawn`, and a solo pipeline dying produced no line at all.

Both arms now report a spawn failure and a child exit through the same two functions, so neither can drift from the other or go quiet. Solo also takes its label from the `repoSlug` its root config declares — in solo that config _is_ the tenant's — instead of the null slug discovery leaves it with, so its lines read `acme/widget:work` rather than `/etc/phoebe:work`. That covers the slot-floor and cap lines too, which were already labelled and already degrading to the path. A config with no usable `repoSlug` keeps the path label; nothing about that field turns into a boot failure.

Solo wires no `onPipelineChange`: its tenant fingerprint is a constant, so the pipeline matrix never reshapes mid-run and the handler would have nothing to report.
