---
"phoebe-agent": patch
---

Mask the deployment env-file inside the container so tenant engine children
cannot read the deployment `GH_TOKEN` off disk.

The deployment root is mounted read-only at `/etc/phoebe`, which includes the
`.env` Compose uses as its `--env-file` input. Every tenant engine child (same
uid 10001) could `cat /etc/phoebe/.env` and recover the credential, defeating
the deny-by-default env allowlist in `bootstrap/engine-child-env.ts`.

Fix: add `- /dev/null:/etc/phoebe/.env:ro` to `container/compose.yml`. Compose
reads the real file before the container starts; inside the container the path
resolves to empty. The dogfood compose (`/.phoebe/container/compose.yml`) gets
the equivalent mask at `/opt/phoebe-engine/.phoebe/.env`.

- `docs/trust.md`: clarify the deployment env-file is not part of the accepted
  at-rest residual — only sibling tenant `.env` files remain readable.
- `docs/upgrading.md`: add a one-time step for existing deployments to add the
  mount by hand and restart.
