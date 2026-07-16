# ai install

Deterministic runbook for installing Phoebe into a target repository. Execute
top to bottom — no `vp` is assumed on the target side.

## Prerequisites

- Node.js ≥ 22.13, `npm` on `PATH`.
- `git`, `gh` (GitHub CLI), Docker + Docker Compose on the host that will run
  the container.
- A GitHub token with `repo` + `read:org` scope in `GH_TOKEN`.
- An API key for whichever agent provider you plan to use
  (`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, or `OPENAI_KEY`).

## 1. Scaffold the runtime

From the root of the repo that Phoebe will work:

```
npx --yes phoebe-agent init
```

That drops these files into place (safe to re-run — existing files are
skipped):

- `phoebe.config.ts` — consumer config. Edit `repoSlug`, `repoUrl`, and the
  three toolchain commands.
- `prompts/` — copies of the shipped agent prompts. Edit any of them to
  override; leave them as-is to use the defaults.
- `.env.example` — copy to `.env` and fill in secrets.
- `.gitignore` — Phoebe entries appended additively.
- `container/Dockerfile`, `container/compose.yml`,
  `container/compose.daemon.yml`, `container/supervisor.sh` — the runtime
  image and its supervisor. Consumer-owned; commit them.

Point `phoebe init` at a subdirectory when you want the runtime out of the
repo root:

```
npx --yes phoebe-agent init ./phoebe
```

## 2. Edit `phoebe.config.ts`

Fill in the five required fields:

```ts
import { defineConfig } from "phoebe-agent";

export default defineConfig({
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
});
```

Everything else is optional and pulled from the shipped defaults.

## 3. Pin the engine version

Edit `.env` and set `PHOEBE_VERSION` to a released `phoebe-agent` version
(e.g. `0.1.0`). The compose file feeds this to the Dockerfile so a rebuild
installs the pinned engine.

## 4. Build the image and one-shot the engine

```
cd container
docker compose build
docker compose run --rm phoebe --dry-run --run-once
```

The `--dry-run` prints the unit the engine would pick without executing it.
Remove `--dry-run` to actually work a unit.

## 5. Start the persistent daemon

```
docker compose -f compose.yml -f compose.daemon.yml up -d
```

The supervisor restarts the engine on crash and re-execs on self-update.

## 6. Upgrade later

Bump `PHOEBE_VERSION` in `.env`, rebuild the image
(`docker compose build`), and restart the service. The supervisor also
auto-upgrades in-place when the container's compose environment changes at
next tick.
