# AI install

**Who this is for:** an agent or a person installing Phoebe into a repository
for the first time. It answers what to run, in what order, to get from nothing to
a running container.

Deterministic runbook for installing Phoebe into a target repository. Execute
top to bottom. It assumes no `vp` on the target side.

## Prerequisites

- Node.js ≥ 24, `npm` on `PATH`.
- `git`, `gh` (GitHub CLI), Docker + Docker Compose on the host that will run
  the container.
- A GitHub token in `GH_TOKEN`: a fine-grained PAT (the five grants listed in
  [onboarding §2](phoebe-core-onboarding.md#2-operator-github-token-a-fine-grained-pat)),
  or a GitHub App installation token for multi-repo deployments
  ([`github-app-mode.md`](github-app-mode.md)).
- An API key for whichever agent provider you plan to use
  (`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, or `OPENAI_KEY`).

## 1. Scaffold the runtime

From the root of the repo that Phoebe will work:

```
npx --yes phoebe-agent init
```

That drops these files into place. Re-running is safe, because existing files are
skipped:

- `phoebe.config.ts`, the consumer config. Edit `repoSlug`, `repoUrl`, and the
  three toolchain commands.
- `prompts/`, copies of the shipped agent prompts. Edit any of them to
  override; leave them as-is to use the defaults.
- `.env.example`, which you copy to `.env` and fill in with secrets.
- `.gitignore`, with Phoebe entries appended rather than replacing what is there.
- `container/Dockerfile`, `container/compose.yml`,
  `container/compose.local.yml`, the runtime image and its compose files.
  Consumer-owned; commit them.

Point `phoebe init` at a subdirectory when you want the runtime out of the
repo root:

```
npx --yes phoebe-agent init ./phoebe
```

## 2. Edit `phoebe.config.ts`

Fill in the five required fields, and pin the engine:

```ts
import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  engine: { source: "github", ref: "v0.7.1" },
};

export default config;
```

Everything else is optional and pulled from the shipped defaults.

Keep the import **type-only**. The container mounts this file into `/etc/phoebe`
and `phoebe boot` loads it from there, where a value import of `phoebe-agent`
cannot resolve.

## 3. Pin the engine version

`engine.ref` above is the pin, and it is the only one. The image carries the
bootstrapper, not the engine. Use a released tag (or a full SHA) in a real
deployment; `main` follows the tip and relies on the crash-loop fallback as its
safety net. See [`upgrading.md`](upgrading.md#pinning-the-engine-version).

## 4. Build the image and one-shot the engine

The scaffolded `.env` lives at the repo root while the compose files live in
`container/`, so pass `--env-file ../.env` on every Compose command run from
there. Otherwise Compose only auto-loads a `.env` sitting beside the compose
file and misses `GH_TOKEN` and the provider keys.

```bash
cd container
docker compose --env-file ../.env build
docker compose --env-file ../.env run --rm phoebe --dry-run --run-once
```

The `--dry-run` prints the unit the engine would pick without executing it.
Remove `--dry-run` to actually work a unit.

The container runs as the unprivileged `phoebe` user, which adds one thing to
check if the build succeeds but the run cannot read its config: the mounted
`phoebe.config.ts` and `prompts/` must be readable by _other_. A git checkout's
default `0644` is; a file you created with a restrictive umask, or copied from
somewhere with `0600`, is not.

```bash
chmod o+r ../phoebe.config.ts && chmod -R o+rX ../prompts
```

## 5. Start persistent mode

```bash
docker compose --env-file ../.env up -d
docker compose --env-file ../.env logs -f
```

The container's main process is `phoebe boot`, which runs the engine and keeps
supervising it: it relaunches on a config or ref change, falls back to the last
engine commit that ran healthily if a new one will not boot, and drains the
engine gracefully on `docker compose stop`. At boot it configures git
credentials from `GH_TOKEN` so private-repo clones and pushes authenticate.

## 6. Upgrade later

Edit `engine.ref` in `phoebe.config.ts`. The running container picks it up within
a reconcile interval (default 60s) and relaunches the engine at the next
work-unit boundary, without rebuilding or restarting the container. Rebuild only
when the _image_ changes.

How you write the file does not matter. `compose.yml` mounts the whole deployment
directory at `/etc/phoebe`, so an in-place edit, an editor's atomic save, and a
`git pull` are all visible inside the container and all fire the reconcile watch.
No `--force-recreate` is needed, and running one would interrupt whatever work
unit is in flight. See [`upgrading.md`](upgrading.md#upgrading).
