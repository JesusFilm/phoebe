---
"phoebe-agent": minor
---

A deployment can be reached from the companion over Tailscale, paired with a one-time code. A `remote` block on the root config picks the arm: a `tailscale/tailscale` sidecar beside the container, or the machine's own Tailscale serving a loopback port. `phoebe init` scaffolds the two Compose overlays and Serve's config, `phoebe start` adds the arm's overlay and reconciles Serve on the host arm, and the bootstrapper serves an open descriptor and a bearer-only `/api` with the report, an event stream, config edits, secrets and doctor runs. `phoebe pair` mints the code as root through a file drop; `phoebe sessions` lists and revokes the 30-day sessions the deployment keeps on its volume. The companion's rail lists machines, with a section per remote host, a deployment reachable two ways shown once per route, an add-remote modal that takes the pairing link, a devices panel, and pairing from the install tab. `docs/remote.md` is the whole of it.
