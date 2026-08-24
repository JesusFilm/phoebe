---
"phoebe-agent": minor
---

`phoebe upgrade --cli` and `--both` now rewrite the `ARG PHOEBE_AGENT_VERSION` pin in `container/Dockerfile` for container deployments and print the `docker build` command to apply it. `npm install -g` on the host does nothing to the baked image, so the pin has to change in the Dockerfile. `--check` and `--json` report the Dockerfile pin as the effective CLI version (`cli.source: "dockerfile"`). Unpinned Dockerfiles and host deployments are unchanged.
