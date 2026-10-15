---
"phoebe-agent": patch
---

An agent's own output now names the pipeline that spawned it: the bracket is `[<owner>/<repo>:<pipeline>:<command>]`, and `[<owner>/<repo>:<pipeline>:<command>:stderr]` on the error stream. Since a tenant runs one engine process per pipeline, two pipelines on the same provider used to pour their agent output into one stream with nothing on the line to tell them apart — the engine's own lines gained the pipeline segment for that reason and the agent's were left out. The missing `phoebe:` prefix still marks a line as the agent's rather than the loop's. A host log collector matching the slug as a prefix keeps working; one pinned to the exact `[<owner>/<repo>:<command>]` string does not.
