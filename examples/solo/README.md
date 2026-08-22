# Solo topology

**Who this is for:** anyone deploying Phoebe against a single repository. It
shows the config and secrets layout for the simplest deployment there is.

One `phoebe.config.ts` at the runtime root describes one repository, and Phoebe
works that repository's issues and PRs. Reach for this when one repo and one
deployment is all you need.

Use the workspace topology instead when you want one container serving many
repos as isolated tenants, with Phoebe running at the root of a workspace of
self-configured child repos. See [`../workspace/`](../workspace/), the
[#81](https://github.com/JesusFilm/phoebe/issues/81) layout.

## What's here

| File               | Role                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| `phoebe.config.ts` | The consumer config: five required fields plus a pinned `engine.ref`.           |
| `.env.example`     | The secrets template. Copy to `.env` and fill in `GH_TOKEN` and a provider key. |

These illustrate rather than run. Read them to see the canonical shape, then
scaffold your own with `npx --yes phoebe-agent init`. The `acme/widget` naming is
fictional and shared with the workspace example so the two read as one
progression.

The config type-checks against the live schema (`src/config-schema.ts`) as part
of the repo's `typecheck`, so if the schema changes underneath it, this example
fails CI instead of rotting quietly.

## Learn more

- [`docs/configuration.md`](../../docs/configuration.md), every `phoebe.config.ts` field and the `PHOEBE_*` env overlay.
- [`docs/ai-install.md`](../../docs/ai-install.md), scaffolding and first boot end to end.
