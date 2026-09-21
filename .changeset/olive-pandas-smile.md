---
"phoebe-agent": minor
---

`phoebe relay init` scaffolds the relay's container files, so standing a relay
up with TLS is `cp .env.example .env`, a hostname, and
`docker compose up -d --build`.

It writes a consumer-owned `relay/{Dockerfile,compose.yml,.env.example}` plus a
`.gitignore` for the `.env` that holds the Google client secret. The Dockerfile
is the deployment image minus git, `gh` and every agent CLI, and it pins the
version of the CLI that scaffolded it — the relay's version is the
bootstrapper's. The compose file runs `phoebe relay serve` on a port nothing
publishes, beside a Caddy sidecar that gets a Let's Encrypt certificate for
`RELAY_HOST` on its own. Operators with a proxy of their own delete that service.

One named volume, mounted at `/data` in both containers: the relay writes
`/data/relay`, Caddy writes `/data/caddy`, so certificates survive a restart
rather than being re-issued. Caddy starts after the relay, because the first
container to mount a fresh volume is the one whose ownership it inherits.

Re-running never overwrites a file that exists — it reports what it skipped and
says the skipped files were left alone. The container-image test now builds the
scaffold and holds it to the deployment image's privilege drop.

See `docs/relay.md`, which now covers the Google Cloud project in Testing
status, the DNS and port prerequisites, and upgrading.
