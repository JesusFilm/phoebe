# Init, pin & upgrade

The contract between the published `phoebe-agent` CLI and a consumer repo: what
`phoebe init` scaffolds, which files you own, how the version is pinned, and how
upgrades roll out — both operator-driven and self-driven.

## The distribution model

You never vendor the engine source. You install the `phoebe-agent` package as a
**pinned CLI** and keep only:

- a small `phoebe.config.ts` (see [`configuration.md`](configuration.md)),
- your `prompts/` overrides (or the shipped copies), and
- the container files `phoebe init` scaffolds.

Everything else — the orchestration loop, work-kind logic, git model, providers
— lives inside the pinned package and upgrades as a unit.

## `phoebe init` — scaffold a consumer-owned runtime

```
npx --yes phoebe-agent init            # into the current directory
npx --yes phoebe-agent init ./phoebe   # into a subdirectory
```

It writes these files (all **consumer-owned** — commit them):

| File                           | Purpose                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `phoebe.config.ts`             | Consumer config starter — edit the five required fields.                            |
| `prompts/`                     | Copies of the shipped agent prompts. Edit to override; leave as-is to use defaults. |
| `.env.example`                 | Documented env vars — copy to `.env` and fill secrets.                              |
| `.gitignore`                   | Phoebe entries **appended additively** (existing content untouched).                |
| `container/Dockerfile`         | Runtime image: Node + git + `gh` + the pinned `phoebe-agent`.                       |
| `container/compose.yml`        | Base one-shot compose config + named volumes.                                       |
| `container/compose.daemon.yml` | Overlay to run Phoebe as a persistent daemon.                                       |
| `container/supervisor.sh`      | Warm-install + engine-restart/self-update loop.                                     |

**Existing files are left untouched**, so re-running `init` is safe and only
fills gaps. To regenerate one scaffolded file, delete it and re-run. Placeholder
tokens in the templates (the CLI bin name, your `installCommand`) are
substituted at scaffold time.

## Pinning the engine version

The engine version is a single knob: `PHOEBE_VERSION` in `.env`.

```
PHOEBE_VERSION=0.1.0
```

`compose.yml` feeds `PHOEBE_VERSION` to the `Dockerfile` build arg, which runs
`npm install -g phoebe-agent@${PHOEBE_VERSION}`. So a rebuild installs exactly
the pinned engine. `latest` is only a build-time fallback — **always pin an
explicit released version** in a real deployment.

## Operator-driven upgrade

To move to a new release:

1. Bump `PHOEBE_VERSION` in `.env`.
2. Rebuild the image: `docker compose --env-file ../.env build` (from the
   `container/` directory).
3. Restart the service with the daemon overlay:
   `docker compose --env-file ../.env -f compose.yml -f compose.daemon.yml up -d`.

The `--env-file ../.env` is needed because the scaffolded `.env` lives at the
repo root while the compose files live in `container/`; Compose otherwise only
auto-loads a `.env` sitting next to the compose file.

New engine defaults land automatically — because your `phoebe.config.ts` only
names fields you deliberately override, any field you left to the default picks
up the new default on upgrade. That is the point of the required-vs-optional
split in [`configuration.md`](configuration.md): a minimal config stays current.

## Self-driven upgrade (supervisor)

Inside the container the supervisor is _designed_ to upgrade **without an
operator** when Phoebe's own code moves on the tracked branch. After each
cycle's fetch, if a changed path matches `config.selfUpdatePaths` (default
`package.json`, `package-lock.json`), the engine exits with a dedicated
self-update code; the supervisor is meant to catch that code, reinstall the
pinned CLI, and re-exec. A freshly pulled commit that crash-loops on startup is
quarantined and the supervisor falls back to the last healthy SHA until a fix
lands.

> **Known limitation:** the self-update exit code is currently **mismatched**
> between the engine and the scaffolded supervisor — the engine exits `42`
> (`SELF_UPDATE_EXIT_CODE` in `src/supervisor-decision.ts`) but
> `templates/container/supervisor.sh` watches for `75`. Until these are aligned,
> a self-update exit is treated as an ordinary crash (restart after backoff)
> rather than triggering a reinstall + re-exec, so **do not rely on automatic
> self-update yet** — use the operator-driven upgrade above. Operator-driven
> upgrades and the crash-loop fallback are unaffected.

Full mechanics — exit codes, crash-loop thresholds, the
TypeScript-spec/shell-mirror split — are in
[`architecture.md`](architecture.md#supervisor-self-update-and-crash-loop-fallback).

## Scaffolded-file invariants

A few properties the templates rely on — keep them intact when you customise:

- **The container marker.** Work-unit execution is refused unless
  `/.phoebe-container` exists (created by the image). Selection and `--dry-run`
  stay host-runnable; anything that mutates a clone or pushes runs only in the
  container.
- **`ENTRYPOINT` owns the supervisor.** Compose's `command:` fully replaces
  `CMD` (it does not append to `ENTRYPOINT`), so the supervisor path lives in
  `ENTRYPOINT` and the compose files only ever contribute engine flags
  (`--run-once`, or `[]` for the daemon).
- **Config + prompts are mounted read-only.** `compose.yml` mounts
  `phoebe.config.ts` and `prompts/` into `/etc/phoebe` read-only, so a
  `docker compose restart` picks up edits **without a rebuild**. Only a
  `PHOEBE_VERSION` change needs a rebuild.
- **`.gitignore` edits are additive.** `init` only appends; it never rewrites
  your existing ignore rules.

## First install

For the full, execute-top-to-bottom install runbook — prerequisites, secrets,
first one-shot, starting the daemon — see [`ai-install.md`](ai-install.md).
</content>
