# Configuration

The complete reference for `phoebe.config.ts` — every field, its default, and
the `PHOEBE_*` environment overlay. The shape is defined in
`src/config-schema.ts`; the engine reads a fully-resolved copy where every
optional field has been filled from the shipped defaults.

## The config file

Consumers write a `phoebe.config.ts` at the runtime root:

```ts
import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  engine: { source: "github", ref: "vX.Y.Z" },
};

export default config;
```

`vX.Y.Z` stands for a released tag. Pick one from
[the releases page](https://github.com/JesusFilm/phoebe/releases); the
[Quickstart](../README.md#quickstart) and [`ai-install.md`](ai-install.md) carry a
concrete one you can copy.

**Keep every import in this file type-only.** In the container the file is
mounted into `/etc/phoebe` and read by `phoebe boot`, from a directory with no
reachable `node_modules` — a _value_ import of `phoebe-agent` cannot resolve
there and boot dies on module resolution. `import type` is erased before the
file ever runs, so it costs nothing and still type-checks in your editor. (The
package does export a `defineConfig` identity helper for the same
autocomplete-plus-unknown-field check; it is only usable in a config that is
loaded where `phoebe-agent` resolves — the host, not the container mount.)

The file is loaded via native Node type-stripping (unflagged on Node ≥ 24, the
version Phoebe requires), so **no bundler is needed on the consumer side**.
Either a default export or a named `export const config` is accepted.

See [`examples/solo/`](../examples/solo/) for a complete single-repo layout
(config + `.env.example` + README) built from exactly this shape.

Load order (`src/cli.ts`): load the file → apply the `PHOEBE_*` env overlay →
merge shipped defaults (`resolveConfig`) → install the resolved config → run.

## Required fields

Exactly **five** fields have no sensible cross-repo default and must be present
and non-empty; the engine throws at startup otherwise.

| Field            | Type   | Purpose                                                       |
| ---------------- | ------ | ------------------------------------------------------------- |
| `repoSlug`       | string | GitHub `owner/repo`, passed to every `gh -R` call.            |
| `repoUrl`        | string | HTTPS clone URL for the container's private clone.            |
| `installCommand` | string | Dependency install run inside each worktree before the agent. |
| `checkCommand`   | string | Lint/type gate; surfaced to prompts as `{{CHECK_COMMAND}}`.   |
| `testCommand`    | string | Test gate; surfaced to prompts as `{{TEST_COMMAND}}`.         |

Everything below is optional — override a field only when the default does not
fit. Nested objects (`promptFiles`, `defaultModels`, `defaultEfforts`, `providerEnv`)
are **merged key-by-key**, so overriding one provider's model or one prompt file
does not force you to supply the rest.

## Repository & branching

| Field           | Default     | Meaning                                                            |
| --------------- | ----------- | ------------------------------------------------------------------ |
| `defaultBranch` | `"main"`    | Branch PRs target and worktrees base off.                          |
| `branchPrefix`  | `"phoebe/"` | Prefix for agent branches. Issue branches are `<prefix>issue-<n>`. |

## Labels

| Field             | Default                | Meaning                                                             |
| ----------------- | ---------------------- | ------------------------------------------------------------------- |
| `readyLabel`      | `"ready-for-agent"`    | Only issues carrying this label are picked up by the `issues` kind. |
| `researchLabel`   | `"wayfinder:research"` | Open issues with this label are picked up by the `research` kind.   |
| `processingLabel` | `"processing"`         | The agent applies this to an issue it has claimed.                  |
| `prOptOutLabel`   | `"ready-for-human"`    | PRs with this label are excluded from every PR scan.                |

See [`operating.md`](operating.md) for how a human drives Phoebe with these,
and [`preparing-work.md`](preparing-work.md) for why `researchLabel` defaults to a
wayfinder-shaped value and what to set it to if you use something else.

## PR-scan scope

The `conflicts` / `checks` / `reviews` work kinds scan open PRs. Two fields
bound what they touch:

| Field      | Default             | Values / meaning                                                                                                                           |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `prScope`  | `"phoebe"`          | `"phoebe"` = only `branchPrefix` branches; `"all"` = any same-repo PR.                                                                     |
| `draftPrs` | `"skip-non-phoebe"` | `"skip-non-phoebe"` = drafts on non-Phoebe branches are off-limits; `"skip-all"` = never touch drafts; `"include"` = drafts are fair game. |

Cross-repository PRs (from forks) are always excluded, regardless of scope.

## Toolchain commands

Toolchains differ per repo, so these are plain shell strings the engine runs
inside a worktree (`checkCommand`/`testCommand` are required, above).

| Field          | Default           | Meaning                                                                            |
| -------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `readyCommand` | `"npm run ready"` | The all-in-one gate the agent runs before pushing. Prompt arg `{{READY_COMMAND}}`. |

## Blocker detection & review summary

| Field                   | Default                               | Meaning                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blockedByPattern`      | `` String.raw`Blocked by\s+#(\d+)` `` | JS-compatible regex matching a blocker reference in issue body text. **Capture group 1 must yield the blocker issue number** (validated at load; `parseBlockedBy` reads `match[1]`). Compiled with `gi`. |
| `reviewsSuccessHeading` | `"## Review feedback addressed"`      | Markdown heading the reviews agent includes in its summary comment. The engine detects the summary by substring match, so it must be unique. Prompt arg `{{REVIEWS_SUCCESS_HEADING}}`.                   |

## Issue-author credit

| Field               | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `creditIssueAuthor` | `true`  | On the issue-to-PR path (`issues` and `research` units) the engine appends `Co-authored-by: <login> <id>+<login>@users.noreply.github.com` — the issue author — to every commit it pushes for that unit, so the human who filed the ticket gets contribution-graph credit for the work it produced. Bots and deleted accounts are never credited; the janitor kinds (`conflicts` / `checks` / `reviews`) never add one. Set `false` on a repo where a reporter's name on agent-written code would read as misattribution. |

The credit is best-effort and applied by the engine after the agent runs, before
the push (`git rebase --exec 'git commit --amend --trailer …'` over the unit's
own commits — trees and authorship untouched, hooks skipped). If the author
lookup fails, the range holds a merge commit, or the rewrite fails, the commits
are pushed exactly as the agent made them and the log says why. Because it does
not go through the prompt, operator prompt overrides need no change.

The opt-out is the operator's, deliberately: there is no per-issue or per-author
switch. Whether a repo credits its reporters is a repo-wide stance, and the
person who can turn it off is the one who labelled the ticket for Phoebe in the
first place. An author who does not want the credit asks the operator.

## Work order

| Field       | Default                                                    | Meaning                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workOrder` | `["conflicts", "checks", "reviews", "issues", "research"]` | Ordered work kinds; the first kind with a workable unit each cycle wins. Validated at startup — must be non-empty and contain only known kinds (`conflicts`, `checks`, `reviews`, `issues`, `research`). |

Order is priority: put janitor kinds first so open PRs are unblocked before new
issues are started, and `research` last so net-new code advances before research
tickets. Omit `research` to disable it for a repo. See
[`work-kinds.md`](work-kinds.md).

## Providers & models

| Field             | Default                                                                          | Meaning                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultProvider` | `"cursor"`                                                                       | Which agent CLI to drive: `cursor`, `claude`, or `codex`.                                                                                                                                                                                                |
| `defaultModels`   | `{ cursor: "composer-2.5", claude: "claude-sonnet-4-6", codex: "gpt-5.4-mini" }` | Per-provider model. Merged key-by-key.                                                                                                                                                                                                                   |
| `defaultEfforts`  | `{}`                                                                             | Per-provider reasoning effort, merged key-by-key. Only `claude` honours it today (`--effort`, one of `low`, `medium`, `high`, `xhigh`, `max`); `cursor` and `codex` ignore it. A provider left unset gets **no** effort flag, so its CLI default stands. |
| `providerEnv`     | `{ cursor: "CURSOR_API_KEY", claude: "ANTHROPIC_API_KEY", codex: "OPENAI_KEY" }` | Env var holding each provider's API key — the **only** key the agent child inherits for the active provider.                                                                                                                                             |

`PHOEBE_AGENT`, `PHOEBE_MODEL`, and `PHOEBE_EFFORT` override `defaultProvider`
and the active provider's entry in `defaultModels` / `defaultEfforts` for one
run, without editing the config. To run the `claude` provider under a Claude
Pro/Max subscription instead of API-key billing, point `providerEnv.claude` at
`CLAUDE_CODE_OAUTH_TOKEN` — see
[`claude-subscription-auth.md`](claude-subscription-auth.md).

## Prompt files

| Field         | Default keys                                                                                                                                                                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptFiles` | `{ issue: "prompts/issues-prompt.md", conflict: "prompts/conflict-prompt.md", checks: "prompts/checks-prompt.md", reviews: "prompts/reviews-prompt.md", research: "prompts/research-prompt.md" }` | Prompt template paths, relative to the **runtime root** (process working directory — the consumer checkout on the host, or `/etc/phoebe` in the container where compose mounts `phoebe.config.ts` and `prompts/`). Resolved only from that base, never from the installed package. `phoebe init` copies the shipped defaults into `prompts/`; edit them to override, or point a key at another runtime-root-relative path. |

Every key a tenant can dispatch is checked **at engine startup**: if one names a
file that does not exist, the engine refuses to start and names the tenant and
every missing kind at once. Prompt loading used to be fail-at-use, so a tenant
missing one kind booted clean and only died when the first unit of that kind was
dispatched — weeks later, if that kind was rare (#164). The check follows
[`workOrder`](#work-order), so a kind you dropped there needs no prompt file.

A key may point outside the runtime root. Being a loadable file is the rule, not
containment: `promptFiles: { issue: "../prompts/issues-prompt.md", … }` is how a
[`configDir`](#asset-directory-configdir) tenant reaches the prompts at its repo
root instead of keeping a second copy under `.phoebe/prompts/` — a copy that
receives no prompt improvement you later merge.

## Container paths (derived, not configured)

`paths` is **no longer a config field** — it is derived from `repoSlug`, so a
tenant's on-disk layout can never drift from its identity. Every tenant nests
under one slug-keyed root on the `phoebe-data` volume:

| Derived path                           | Holds                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/data/repos/<owner>/<repo>/repo`      | The private clone (origin hub).                                                                                                          |
| `/data/repos/<owner>/<repo>/worktrees` | Per-unit git worktrees.                                                                                                                  |
| `/data/repos/<owner>/<repo>/state`     | Per-tenant state — the supervisor's `status.json`.                                                                                       |
| `/data/engine`                         | The **shared** engine checkout + the crash-loop record (`engine-crash-loop.json`), deployment-global, on its own `phoebe-engine` volume. |

The base is `/data/repos` in the container; `PHOEBE_DATA_DIR` overrides it for
host/dev. These map to the two named volumes in `compose.yml` — see
[`architecture.md`](architecture.md#named-volumes).

## Multiple repos (workspace tenants)

A deployment is **solo** or **workspace**, selected by the boot ladder: a root
`workspace` block → workspace; else solo. Workspace topology and the operator
runbook live in [`workspace.md`](workspace.md). Side by side:

```text
# Solo (phoebe init):            # Workspace (phoebe init --workspace):
.phoebe/                         workspace-root/
  phoebe.config.ts   ← the repo    phoebe.config.ts   ← SHARED ONLY: engine source + workspace block
  .env                             .env               ← supervisor's token only
  prompts/?                        widget/            ← a child checkout the operator placed
  container/                         phoebe.config.ts ← per-tenant (no engine field)
                                     .env             ← per-tenant secrets (co-located, 1:1)
                                     prompts/?        ← optional per-tenant overrides
                                   container/
```

- **Config↔env binding is 1:1 by co-location** — each tenant dir has exactly one
  `phoebe.config.ts` and one `.env`; the supervisor reads that `.env` and hands
  the tenant's engine child **only** its own secrets (`buildEngineChildEnv`).
- **Engine source is shared** across the fleet — set `engine` in the root
  `phoebe.config.ts` only; a tenant config carrying `engine` is ignored with a
  warning (one engine version for everyone).
- **`paths` still derives from each tenant's `repoSlug`**, identically in both
  modes. Scaffold a child with `init --tenant` after linking its checkout, then
  use `list` / `purge` to operate the fleet
  ([`workspace.md`](workspace.md), [`operating.md`](operating.md)).

See [`examples/workspace/`](../examples/workspace/) for a complete layout — the
engine-only root config plus two placeholder children.

> The `repos/<owner>/<repo>/` (nested) layout was **removed in 0.4.0**. A
> deployment root still carrying a `repos/` directory fails boot with a message
> pointing here; move each tenant to a checkout under a workspace root.

## Asset directory (`configDir`)

Bootstrapper-only, per tenant. By default a tenant's `.env` (and any relative
`promptFiles`) sit **co-located** with its `phoebe.config.ts`. `configDir`
relocates them to a subdirectory of that dir — so a workspace child can reuse
its standalone `.phoebe/` folder instead of duplicating `.env`
and `prompts/` at the repo root:

```ts
// <repo>/phoebe.config.ts — stays at the repo root (see below)
import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "pnpm install --frozen-lockfile",
  checkCommand: "pnpm run check",
  testCommand: "pnpm run test",
  configDir: ".phoebe", // read .env + prompts from <repo>/.phoebe/
};

export default config;
```

- The supervisor reads the tenant `.env` from `<dir>/<configDir>/.env` and runs
  the tenant's engine child with cwd `<dir>/<configDir>`, so relative
  `promptFiles` (and other cwd-relative assets) resolve there.
- **That includes prompts you did not move.** If your prompts stayed at the repo
  root, say so — `promptFiles: { issue: "../prompts/issues-prompt.md", … }` — and
  keep one tree. Copying them into `<configDir>/prompts/` instead is what let
  this repo's own dogfood run months-old prompts and lose a kind outright (#164);
  the startup check now catches the missing kind, but nothing catches a stale
  copy.
- **The `phoebe.config.ts` itself must stay at `<dir>`.** Workspace discovery
  skips dotfolders, so a config inside `.phoebe/` would never be found — the
  config is a thin root file pointing at `configDir`, and everything else moves.
  `container/` is operator-run (never read by the engine), so it can live in
  `.phoebe/` too; you just point compose at it.
- Must be a **relative** path with no `..` (it stays inside the tenant dir).
  Default `"."` (co-located). Honored for fleet tenants (workspace children).
  Like `engine`, it is bootstrapper-only and `resolveConfig`
  drops it (the engine never sees it).

## Commit attribution (`gitIdentity`)

Bootstrapper-only, per tenant. Declares how **this repo's** commits are signed,
so the answer travels with the repo instead of being restated in every
deployment's `.env`:

```ts
const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  // …
  gitIdentity: { name: "Phoebe", email: "12345+phoebe@users.noreply.github.com" },
};
```

- **Both halves, always.** A name without the exact email is a trap: GitHub
  links a commit to an account by the _email_, so a name-only declaration would
  look like it worked and attribute the commits to nobody. A malformed value
  fails the tenant (skip-and-warn in a fleet, a hard boot error in solo) rather
  than silently falling back.
- **It sets all four vars** — `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` /
  `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL`. Author and committer are not
  separately expressible; "how are this repo's commits attributed" is one
  question.
- Like `engine` and `configDir`, it is bootstrapper-only: `resolveConfig` drops
  it and the engine never sees the field, only the env vars the supervisor sets
  from it.

### The precedence ladder

Four channels can name a git identity. Later wins:

| Rung | Channel                                             | Scope                        |
| ---- | --------------------------------------------------- | ---------------------------- |
| 1    | The supervisor's own `GIT_*` (deployment env-file)  | Every tenant it supervises   |
| 2    | The `app` arm's bot fallback (`<id>+<slug>[bot]@…`) | Every minted tenant          |
| 3    | **`gitIdentity`**                                   | This repo, every deployment  |
| 4    | The tenant's co-located `.env`                      | This tenant, this deployment |

In one sentence: **the config field outranks anything said deployment-wide and
is outranked by anything said about this tenant specifically.** So a `.env` that
sets `GIT_AUTHOR_*` today keeps winning, and a repo that declares nothing is
attributed exactly as it was before the field existed.

Collisions are resolved **per variable**, not per identity: a tenant `.env` that
sets only `GIT_AUTHOR_NAME` takes the other three from `gitIdentity`.

**In solo there is no rung 1.** A solo deployment has exactly one env-file, and
it is _the tenant's_ — the same co-located `.env` a fleet tenant carries, which
wins rung 4 there too. So it wins every variable it sets and `gitIdentity` fills
the rest; the same rule, read from the other end. (Rung 2 sits below it there as
well: the App arm's bot identity is applied as a fallback for vars still unset
by the time the engine runs.)

The consequence is worth stating plainly: on a solo deployment that already sets
`GIT_AUTHOR_*` in its `.env`, adding `gitIdentity` changes nothing until those
vars are removed. Boot says so at every launch rather than leaving the
declaration quietly inert:

```text
[phoebe] boot: gitIdentity declares Phoebe <12345+phoebe@users.noreply.github.com>,
  but this deployment's env already sets GIT_AUTHOR_NAME — the env wins (in solo
  it is this tenant's own env-file). Unset those vars to use the declaration.
```

**Editing it takes effect on the relaunch it already causes** — the config is
part of each tenant's reconcile fingerprint, so the child restarts with the new
identity at the next work-unit boundary, no container restart.

**Host-side runs are not covered.** The identity reaches the engine as env vars
set by `phoebe boot`; a bare `phoebe run` on your laptop uses your own
`~/.gitconfig`, which is what you want there.

## Lifecycle commands (`deployment`)

Host-CLI-only. `phoebe start` and `phoebe stop` drive the scaffolded
`container/compose.yml` with `docker compose` by default. The `deployment` block
replaces that driver with **literal shell command strings** — the same shape as
`installCommand` / `checkCommand` / `testCommand`, not a runtime name — for
deployments that are not plain `docker compose`. Design record:
[`research/lifecycle-runtime-seam.md`](research/lifecycle-runtime-seam.md) (#189).

| Field            | Required | Run by                                                                        |
| ---------------- | -------- | ----------------------------------------------------------------------------- |
| `startCommand`   | yes      | `phoebe start` — bring the deployment up.                                     |
| `stopCommand`    | yes      | `phoebe stop` — drain and stop the deployment.                                |
| `stopNowCommand` | no       | `phoebe stop --now` — short-grace stop. Omitted ⇒ `--now` runs `stopCommand`. |

When the block is absent (the default) nothing changes. When present, the
compose driver is bypassed entirely and each string runs via `/bin/sh -c` on the
host with inherited stdio — exit 0 is success, non-zero is failure. Both
`startCommand` and `stopCommand` must be present and non-empty together
(`resolveConfig` rejects a half-declared block, or a blank `stopNowCommand`), so
a deployment that has bypassed compose for start can never silently fall back to
compose for stop. Like `engine`, `workspace`, and `configDir`, it is host-side
only: `resolveConfig` drops it and the engine never sees it (the engine never
calls `phoebe start`/`phoebe stop`). The in-container refusal on `phoebe start`
/ `phoebe stop` still applies — start and stop are host actions in every shape.

It is designed for three shapes: **podman** (or any other compose-compatible
CLI), **systemd** (a unit that wraps the container or runs the engine directly),
and **a different compose invocation** (extra `-f` files, a project name, a
remote context) that the scaffolded driver does not know about.

```ts
// podman-compose
deployment: {
  startCommand: "podman compose -f container/compose.yml up -d",
  stopCommand: "podman compose -f container/compose.yml stop -t 3600",
  stopNowCommand: "podman compose -f container/compose.yml stop -t 1",
},
```

```ts
// systemd
deployment: {
  startCommand: "systemctl start phoebe",
  stopCommand: "systemctl stop phoebe", // set TimeoutStopSec in the unit for drain grace
  stopNowCommand: "systemctl kill --signal=SIGTERM phoebe && systemctl stop phoebe",
},
```

**You own the drain grace.** With the compose driver, `phoebe stop` passes
`-t 3600` so an in-flight work unit can finish; on the literal-command path
nothing is appended to your string — encode the timeout in `stopCommand`
yourself (`-t 3600`, `TimeoutStopSec=`, `--timeout=…`), and put the short-grace
variant in `stopNowCommand` if `--now` should mean something different.

**Not available on the literal-command path** — these are compose-specific and
are skipped when `deployment` is set:

- state queries, so no "already running" / "already stopped" pre-checks — make
  `startCommand` idempotent if you care;
- the "exited immediately" post-start probe — have `startCommand` verify the
  service is up before it exits 0, or accept that a fast-exit failure goes
  unnoticed;
- killed-mid-run detection (Docker's exit code 137);
- `.env` file discovery — your command reads whatever environment it needs;
- `--build` — not forwarded; `phoebe start --build` warns and runs
  `startCommand` unchanged. Encode the rebuild in `startCommand` or run it as a
  separate step.

## Engine source (`engine`)

Bootstrapper-only. `phoebe boot` reads this field to decide **where the engine
runs from**; the engine itself ignores it (`resolveConfig` drops it — it never
reaches the resolved config). Omitted ⇒ `{ source: "github", ref: "main" }`.

| `engine` value                                | What `phoebe boot` runs                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| _omitted_ / `{ source: "github", ref, repo }` | A git checkout of the engine repo. `ref` is any branch/40-char SHA/tag; `repo` defaults to `JesusFilm/phoebe`. |
| `{ source: "local" }`                         | The engine mounted at `/opt/phoebe-engine` (dev-only `compose.local.yml`); a missing mount fails loudly.       |

For `github`, first boot clones into `PHOEBE_ENGINE_DIR` (see runtime toggles)
and every boot fetches `ref` + checks it out — a branch tracks its tip, a SHA/tag
pins an exact commit. The clone authenticates with `GH_TOKEN`; the scaffolded
`compose.yml` points `PHOEBE_ENGINE_DIR` at the `phoebe-engine` named volume so
later boots fetch instead of re-cloning. (`engine` is not `PHOEBE_*`-overlayable
— it selects the engine before the engine's config pipeline runs.)

This field is the **upgrade knob**: editing `ref` is how a deployment moves to a
new engine, and the running container picks it up without a rebuild or a restart
(see Reconcile below, and [`upgrading.md`](upgrading.md#upgrading)). When the
ref moves, run `phoebe migrate` to apply any config or artifact changes the new
engine requires — see [`upgrading.md` → What Phoebe may write](upgrading.md#what-phoebe-may-write-in-your-repos).

### Reconcile (config + ref watch)

`phoebe boot` does not just launch the engine — it keeps the **right** engine
running. Every `PHOEBE_RECONCILE_INTERVAL_MS` (default 60s) it samples two
things and compares them against what the running engine was launched from:

| Watched            | How it is sampled              | Relaunches when                                  |
| ------------------ | ------------------------------ | ------------------------------------------------ |
| The mounted config | one `stat` (mtime + size)      | the file changed — the `engine` field is re-read |
| The tracked ref    | one `git ls-remote` (no fetch) | the branch advanced past the running commit      |

On a change, boot sends the engine `SIGTERM` — a **graceful drain**, not a kill:
the engine finishes the work unit in flight, starts no new one, and exits 0.
Only then does boot re-resolve the source (re-read the config, fetch + check out
the new ref) and spawn the replacement, in the same container. So a reconcile
never interrupts a work unit and never restarts the container.

The ref-watch is **inert for a pinned `ref`**: a 40-char SHA is never even asked
about, and a tag is asked but never acted on. Pinning means pinning — only a
config edit moves a pinned deployment. A `local` source has no ref to watch, so
only the config watch applies. A poll that finds nothing costs one stat plus at
most one `ls-remote`; a failed poll (network blip, unreadable mount) is logged
and treated as no change.

### Crash-loop fallback

Tracking a branch means eventually tracking it onto a commit that will not boot.
`phoebe boot` guards against that: it remembers which engine commits actually
ran, and pins back to the last good one rather than crash-looping an unattended
container.

| Constant               | Value   | Meaning                                                     |
| ---------------------- | ------- | ----------------------------------------------------------- |
| `CRASH_LOOP_THRESHOLD` | `3`     | Consecutive fast crashes before boot pins to the last-good. |
| `HEALTHY_RUN_MS`       | `60000` | How long a run must survive to prove its commit.            |
| `CRASH_BACKOFF_MS`     | `10000` | Wait before relaunching a crashed engine.                   |

Every finished run gets one of three verdicts:

| Verdict          | When                                                                           | Effect                       |
| ---------------- | ------------------------------------------------------------------------------ | ---------------------------- |
| **healthy**      | outlived `HEALTHY_RUN_MS`, or exited 0 unprompted                              | becomes the last-good commit |
| **crash**        | exited non-zero, of its own accord, inside the window                          | counts toward the threshold  |
| **inconclusive** | boot ended it early (reconcile drain or container stop), or a signal killed it | nothing moves                |

The third verdict is load-bearing: a container stop landing seconds into a
relaunch of a crash-looping commit must not credit that commit, or the fallback
would be disarmed for good. A commit that outlives the window is also banked as
last-good **while it is still running**, so an engine up for weeks that is then
killed outright (host reboot, OOM) still leaves a fallback target behind.

Each crash relaunches the engine after `CRASH_BACKOFF_MS` — deliberately not the
poll interval, so slowing the reconcile poll down does not also delay a fallback.
At the threshold boot checks out the **last-good commit** instead of the tip, and
the ref-watch stops treating the tip as a change while the branch still points at
the quarantined commit. When the branch advances past it, the quarantine lapses
and the next launch is an ordinary one. If the fallback crashes too the
quarantine still holds and the container exits — boot has run out of better
commits, and says so.

The record lives at `/data/engine/engine-crash-loop.json` (last-good SHA,
quarantined SHA, crash count) — deployment-global, beside the shared engine
checkout, since it is about the engine, not any tenant. A quarantine survives the
container restart a crash-looping engine causes. An unwritable dir is a warning,
not a failure:
the guard still works for the life of that container.

The guard is **inert** unless `engine.ref` is a moving branch — a `local` source
has no commit to pin, and a pinned SHA or tag means the operator chose that exact
commit, so boot crash-loops visibly rather than quietly serving different code.
It is also inert with nothing known-good yet: a first boot onto a broken ref
exits with the engine's status and lets the container's restart policy show the
failure. (A pinned launch still _records_ what it proved — that costs nothing,
and gives a deployment later moved onto a branch something to fall back to. It
simply never causes a fallback.) Every fallback event is logged with both SHAs
(`[phoebe] boot: …`).

## Environment overlay (`PHOEBE_*`)

`PHOEBE_*` env vars provide **one-off run overrides** without editing
`phoebe.config.ts` (`src/load-config.ts`). The overlay is additive: an unset
var leaves the field untouched, so `resolveConfig` can still fall back to a
default. Only **scalar** fields are overlayable — nested records
(`promptFiles`, `defaultModels`, `defaultEfforts`, `providerEnv`, `workOrder`) stay
config-file territory.

| Env var                          | Config field            | Notes                                                   |
| -------------------------------- | ----------------------- | ------------------------------------------------------- |
| `PHOEBE_REPO_SLUG`               | `repoSlug`              |                                                         |
| `PHOEBE_REPO_URL`                | `repoUrl`               |                                                         |
| `PHOEBE_DEFAULT_BRANCH`          | `defaultBranch`         |                                                         |
| `PHOEBE_BRANCH_PREFIX`           | `branchPrefix`          |                                                         |
| `PHOEBE_READY_LABEL`             | `readyLabel`            |                                                         |
| `PHOEBE_RESEARCH_LABEL`          | `researchLabel`         |                                                         |
| `PHOEBE_PROCESSING_LABEL`        | `processingLabel`       |                                                         |
| `PHOEBE_PR_OPT_OUT_LABEL`        | `prOptOutLabel`         |                                                         |
| `PHOEBE_INSTALL_COMMAND`         | `installCommand`        |                                                         |
| `PHOEBE_CHECK_COMMAND`           | `checkCommand`          |                                                         |
| `PHOEBE_TEST_COMMAND`            | `testCommand`           |                                                         |
| `PHOEBE_READY_COMMAND`           | `readyCommand`          |                                                         |
| `PHOEBE_BLOCKED_BY_PATTERN`      | `blockedByPattern`      |                                                         |
| `PHOEBE_REVIEWS_SUCCESS_HEADING` | `reviewsSuccessHeading` |                                                         |
| `PHOEBE_PR_SCOPE`                | `prScope`               | Validated: must be `phoebe` or `all`.                   |
| `PHOEBE_DRAFT_PRS`               | `draftPrs`              | Validated: `skip-non-phoebe`, `skip-all`, or `include`. |
| `PHOEBE_DEFAULT_PROVIDER`        | `defaultProvider`       | Validated: `cursor`, `claude`, or `codex`.              |

### Runtime toggles (read directly, not overlaid onto config)

| Env var                        | Default              | Meaning                                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PHOEBE_AGENT`                 | —                    | Provider for this run (`cursor` \| `claude` \| `codex`).                                                                                                                                                                                                       |
| `PHOEBE_MODEL`                 | —                    | Model for this run.                                                                                                                                                                                                                                            |
| `PHOEBE_EFFORT`                | —                    | Reasoning effort for this run, overriding the active provider's `defaultEfforts` entry. Only `claude` honours it (`low` \| `medium` \| `high` \| `xhigh` \| `max`).                                                                                            |
| `PHOEBE_POLL_INTERVAL_MS`      | `300000`             | Persistent-mode idle poll interval. Under the App arm this is the capacity lever — a shorter interval raises the per-tenant request rate ([github-app-mode.md §5](github-app-mode.md#5-capacity)).                                                             |
| `PHOEBE_ENGINE_DIR`            | `<tmp>/phoebe-agent` | Base dir `phoebe boot` clones a `github` engine source into (and bin.mjs materializes under). Put it on a persistent volume so github boots fetch instead of re-cloning.                                                                                       |
| `PHOEBE_RECONCILE_INTERVAL_MS` | `60000`              | How often `phoebe boot` polls the mounted config and the tracked ref for a drain-and-relaunch (see Engine source → Reconcile).                                                                                                                                 |
| `PHOEBE_BASE`                  | —                    | Force the worktree base ref for issues (bypasses blocker resolution).                                                                                                                                                                                          |
| `PHOEBE_DATA_DIR`              | `/data/repos`        | Base dir for derived tenant paths (host/dev override). Each tenant nests under `<base>/<owner>/<repo>/`.                                                                                                                                                       |
| `PHOEBE_MAX_CONCURRENT_AGENTS` | `1`                  | Cap on concurrently-executing work units (the supervisor's FIFO broker), in solo and fleet alike. Raise deliberately.                                                                                                                                          |
| `PHOEBE_RUN_TIMEOUT_MS`        | `2700000` (45 min)   | Whole-unit wall-clock budget; a unit that exceeds it is aborted so it can't hold the concurrency slot forever. Under the App arm the effective ceiling is ≈50 min (installation tokens expire after 60 min). Also settable as the `runTimeoutMs` config field. |
| `PHOEBE_MAX_UNIT_TIMEOUTS`     | `3`                  | Consecutive per-unit timeouts before the unit is quarantined (`phoebe:quarantined` label + escalation comment). Also the `maxUnitTimeouts` config field.                                                                                                       |

Secrets (`GH_TOKEN` and the active provider's key) are also read from the
environment — see [`ai-install.md`](ai-install.md) and `.env.example`. In a
workspace deployment each tenant's secrets live in its own co-located
`.env`, read by the supervisor and scrubbed so a tenant's engine child sees only
its own (workspace two-tier model: [`workspace.md`](workspace.md)).

## GitHub App arm

Two variables in the **deployment** env-file select the `app` credential arm —
boot mints a per-tenant installation token from the App instead of reading each
tenant's `GH_TOKEN`. The App arm is available in solo and workspace deployments.

| Env var              | Form               | Meaning                                                                                              |
| -------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `GH_APP_ID`          | integer as string  | GitHub App id — visible on the App's settings page under "General".                                  |
| `GH_APP_PRIVATE_KEY` | base64-encoded PEM | App private key encoded as a single line (`base64 -w0 key.pem` on Linux, `base64 key.pem` on macOS). |

Both must be set together; a partial declaration (one without the other) is a fatal boot error.
Set neither to stay on the `pat` arm.

**No file-path alternative.** A mounted key file is readable by every tenant in the container
(all tenants share the same uid), so the file-path option does not exist rather than merely being
discouraged. Base64 in the env-file is the only supported form.

These variables are deployment env-file only — they live beside `GH_TOKEN` in the deployment
root `.env`, never in a tenant's co-located `.env`. The supervisor withholds them from every
engine child.
</content>
