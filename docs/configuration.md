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
  engine: { source: "github", ref: "v0.1.0" },
};

export default config;
```

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

Resolution order is deterministic:

1. shipped Phoebe defaults
2. the optional generated base document named by `PHOEBE_BASE_CONFIG`
3. the repository's `phoebe.config.ts`
4. existing `PHOEBE_*` field overrides

Scalars replace lower-layer values, nested records merge key by key, arrays
replace the lower array as a whole, and absent fields do not override lower
layers. The engine, `phoebe boot`, and `phoebe config resolve --json` all use
this same resolver. Boot passes its canonical non-secret resolution to the child
engine as an immutable launch snapshot, so an edit between source selection and
child startup cannot mix one engine source with another runtime configuration.

### Generated base configuration

`PHOEBE_BASE_CONFIG` may name an absolute path to a UTF-8 JSON document:

```json
{
  "schemaVersion": 1,
  "config": {
    "branchPrefix": "managed/",
    "paths": {
      "stateDir": "/data/managed-state"
    },
    "engine": {
      "source": "github",
      "repo": "JesusFilm/phoebe",
      "ref": "v0.2.0"
    }
  }
}
```

The base can supply any optional configuration field, including `engine`, but
must not define the five required repository-owned fields (`repoSlug`,
`repoUrl`, `installCommand`, `checkCommand`, `testCommand`). Those must remain
present and non-empty in `phoebe.config.ts`.

The document is strict: unknown fields, unsupported schema versions, invalid
JSON, invalid field shapes, a relative path, or a missing/unreadable file fail
with an error naming the configured path before a new engine starts. When no
base path is set, resolution is identical to the original defaults → repository
→ environment behavior.

An engine selected while the generated base is active must carry the
`src/bootstrap-config-protocol.json` version-1 marker, which declares support
for boot's resolved snapshot handoff. Older pinned refs fail clearly before
spawn instead of silently ignoring the generated layer. The marker check is not
required when `PHOEBE_BASE_CONFIG` is unset, preserving older-engine
compatibility for existing deployments.

Use the read-only command below to validate a deployment and inspect the
canonical non-secret effective configuration:

```bash
PHOEBE_BASE_CONFIG=/etc/phoebe/generated-base.json \
  phoebe config resolve --json
```

The output is a versioned JSON document. It includes resolved configuration and
the canonical engine source, but never serializes environment values or secrets.

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
fit. Nested objects (`promptFiles`, `paths`, `defaultModels`, `providerEnv`)
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

See [`operating.md`](operating.md) for how a human drives Phoebe with these.

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

## Work order

| Field       | Default                                                    | Meaning                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workOrder` | `["conflicts", "checks", "reviews", "issues", "research"]` | Ordered work kinds; the first kind with a workable unit each cycle wins. Validated at startup — must be non-empty and contain only known kinds (`conflicts`, `checks`, `reviews`, `issues`, `research`). |

Order is priority: put janitor kinds first so open PRs are unblocked before new
issues are started, and `research` last so net-new code advances before research
tickets. Omit `research` to disable it for a repo. See
[`work-kinds.md`](work-kinds.md).

## Providers & models

| Field             | Default                                                                          | Meaning                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `defaultProvider` | `"cursor"`                                                                       | Which agent CLI to drive: `cursor`, `claude`, or `codex`.                                                    |
| `defaultModels`   | `{ cursor: "composer-2.5", claude: "claude-sonnet-4-6", codex: "gpt-5.4-mini" }` | Per-provider model. Merged key-by-key.                                                                       |
| `providerEnv`     | `{ cursor: "CURSOR_API_KEY", claude: "ANTHROPIC_API_KEY", codex: "OPENAI_KEY" }` | Env var holding each provider's API key — the **only** key the agent child inherits for the active provider. |

## Prompt files

| Field         | Default keys                                                                                                                                                                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptFiles` | `{ issue: "prompts/issues-prompt.md", conflict: "prompts/conflict-prompt.md", checks: "prompts/checks-prompt.md", reviews: "prompts/reviews-prompt.md", research: "prompts/research-prompt.md" }` | Prompt template paths, relative to the **runtime root** (process working directory — the consumer checkout on the host, or `/etc/phoebe` in the container where compose mounts `phoebe.config.ts` and `prompts/`). Resolved only from that base, never from the installed package. `phoebe init` copies the shipped defaults into `prompts/`; edit them to override, or point a key at another runtime-root-relative path. |

## Container paths

| Field                | Default             | Meaning                                                                                      |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `paths.repoDir`      | `"/data/repo"`      | The private clone (origin hub).                                                              |
| `paths.worktreesDir` | `"/data/worktrees"` | Per-unit git worktrees.                                                                      |
| `paths.stateDir`     | `"/data/state"`     | Lock, watermarks, logs, and the bootstrapper's crash-loop record (`engine-crash-loop.json`). |

These map to the named volumes in `compose.yml` — see
[`architecture.md`](architecture.md#named-volumes).

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
(see Reconcile below, and [`upgrading.md`](upgrading.md#upgrading)).

### Reconcile (config + ref watch)

`phoebe boot` does not just launch the engine — it keeps the **right** engine
running. Every `PHOEBE_RECONCILE_INTERVAL_MS` (default 60s) it samples the
following inputs and compares them against what the running engine was launched
from:

| Watched                    | How it is sampled              | Relaunches when                                      |
| -------------------------- | ------------------------------ | ---------------------------------------------------- |
| The repository declaration | one `stat` (mtime + size)      | `phoebe.config.ts` changed                           |
| The generated base         | one `stat` (mtime + size)      | its contents or readable/missing state changed       |
| The tracked ref            | one `git ls-remote` (no fetch) | the branch advanced past the running engine's commit |

The generated-base watch is active only when `PHOEBE_BASE_CONFIG` is set. On a
change, boot sends the engine `SIGTERM` — a **graceful drain**, not a kill:
the engine finishes the work unit in flight, starts no new one, and exits 0.
Only then does boot re-resolve every layer, fetch and check out the new ref if
needed, and spawn the replacement in the same container. If the changed base is
invalid, resolution fails and boot retries without starting a partially
configured engine.

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

The record lives in `paths.stateDir` as `engine-crash-loop.json` (last-good SHA,
quarantined SHA, crash count), so a quarantine survives the container restart a
crash-looping engine causes. An unwritable state dir is a warning, not a failure:
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
(`promptFiles`, `paths`, `defaultModels`, `providerEnv`, `workOrder`) stay
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

| Env var                        | Default              | Meaning                                                                                                                                                                  |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PHOEBE_AGENT`                 | —                    | Provider for this run (`cursor` \| `claude` \| `codex`).                                                                                                                 |
| `PHOEBE_MODEL`                 | —                    | Model for this run.                                                                                                                                                      |
| `PHOEBE_POLL_INTERVAL_MS`      | `300000`             | Persistent-mode idle poll interval.                                                                                                                                      |
| `PHOEBE_ENGINE_DIR`            | `<tmp>/phoebe-agent` | Base dir `phoebe boot` clones a `github` engine source into (and bin.mjs materializes under). Put it on a persistent volume so github boots fetch instead of re-cloning. |
| `PHOEBE_RECONCILE_INTERVAL_MS` | `60000`              | How often `phoebe boot` polls the mounted config and the tracked ref for a drain-and-relaunch (see Engine source → Reconcile).                                           |
| `PHOEBE_BASE_CONFIG`           | —                    | Absolute path to the optional versioned generated base configuration. Resolved below the repository declaration and watched by `phoebe boot`.                            |
| `PHOEBE_BASE`                  | —                    | Force the worktree base ref for issues (bypasses blocker resolution).                                                                                                    |

Secrets (`GH_TOKEN` and the active provider's key) are also read from the
environment — see [`ai-install.md`](ai-install.md) and `.env.example`.
</content>
