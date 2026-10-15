---
"phoebe-agent": patch
---

Every line a pipeline writes now opens with the deployment's name: `[<deployment>:<owner>/<repo>:<pipeline>]`, where the name is the one the bootstrapper already computes for the console (the solo tenant's `repoSlug`, or the workspace root's directory name). The agent's lines share that bracket. They used to carry their own `[<owner>/<repo>:<pipeline>:<provider>]`, and now they add the unit and then `[<provider>]`, or `[<provider>:stderr]`, at the end. So a solo deployment writes `[JesusFilm/phoebe:JesusFilm/phoebe:work][issues issue:88][claude] …`.

In the console a pipeline is one tab again. The agent's lines sit with the engine's, and the `phoebe:work:claude` tab is gone. Host log collectors need a look. One keyed on `[phoebe:` stops matching unless the deployment happens to be called `phoebe`. One keyed on the engine bracket now catches the agent's lines too. One pinned to the old `[<owner>/<repo>:<pipeline>:<command>]` agent bracket stops matching.
