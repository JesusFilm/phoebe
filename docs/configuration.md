# Configuration

The complete reference for `phoebe.config.ts` — every field, its default, and
the `PHOEBE_*` environment overlay. The shape is defined in
`src/config-schema.ts`; the engine reads a fully-resolved copy where every
optional field has been filled from the shipped defaults.

## The config file

Consumers write a `phoebe.config.ts` at the runtime root:

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

`defineConfig` is an identity helper — it exists only for editor autocomplete
and a compile-time check that no unknown field slips in. The file is loaded via
native Node type-stripping (Node ≥ 22.7 with `--experimental-strip-types`, or
≥ 23 by default), so **no bundler is needed on the consumer side**. Either a
default export or a named `export const config` is accepted.

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
fit. Nested objects (`promptFiles`, `paths`, `defaultModels`, `providerEnv`)
are **merged key-by-key**, so overriding one provider's model or one prompt file
does not force you to supply the rest.

## Repository & branching

| Field           | Default     | Meaning                                                            |
| --------------- | ----------- | ------------------------------------------------------------------ |
| `defaultBranch` | `"main"`    | Branch PRs target and worktrees base off.                          |
| `branchPrefix`  | `"phoebe/"` | Prefix for agent branches. Issue branches are `<prefix>issue-<n>`. |

## Labels

| Field             | Default             | Meaning                                              |
| ----------------- | ------------------- | ---------------------------------------------------- |
| `readyLabel`      | `"ready-for-agent"` | Only issues carrying this label are picked up.       |
| `processingLabel` | `"processing"`      | The agent applies this to an issue it has claimed.   |
| `prOptOutLabel`   | `"ready-for-human"` | PRs with this label are excluded from every PR scan. |

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

| Field       | Default                                        | Meaning                                                                                                                                         |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `workOrder` | `["conflicts", "checks", "reviews", "issues"]` | Ordered work kinds; the first kind with a workable unit each cycle wins. Validated at startup — must be non-empty and contain only known kinds. |

Order is priority: put janitor kinds first so open PRs are unblocked before new
issues are started. See [`work-kinds.md`](work-kinds.md).

## Providers & models

| Field             | Default                                                                          | Meaning                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `defaultProvider` | `"cursor"`                                                                       | Which agent CLI to drive: `cursor`, `claude`, or `codex`.                                                    |
| `defaultModels`   | `{ cursor: "composer-2.5", claude: "claude-sonnet-4-6", codex: "gpt-5.4-mini" }` | Per-provider model. Merged key-by-key.                                                                       |
| `providerEnv`     | `{ cursor: "CURSOR_API_KEY", claude: "ANTHROPIC_API_KEY", codex: "OPENAI_KEY" }` | Env var holding each provider's API key — the **only** key the agent child inherits for the active provider. |

## Prompt files

| Field         | Default keys                                                                                                                                       | Meaning                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptFiles` | `{ issue: "prompts/prompt.md", conflict: "prompts/conflict-prompt.md", checks: "prompts/checks-prompt.md", reviews: "prompts/reviews-prompt.md" }` | Prompt template paths, relative to the runtime root. `phoebe init` copies the shipped defaults into `prompts/`; edit them to override, or leave them to use the defaults. |

## Self-update paths

| Field             | Default                                 | Meaning                                                                                                                                                                                                    |
| ----------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selfUpdatePaths` | `["package.json", "package-lock.json"]` | A default-branch fetch touching any of these means "Phoebe's own code changed" → exit for supervisor reinstall + re-exec. Directory entries must end with `/` (matched as a prefix); others match exactly. |

See supervisor self-update in [`architecture.md`](architecture.md).

## Container paths

| Field                | Default             | Meaning                         |
| -------------------- | ------------------- | ------------------------------- |
| `paths.repoDir`      | `"/data/repo"`      | The private clone (origin hub). |
| `paths.worktreesDir` | `"/data/worktrees"` | Per-unit git worktrees.         |
| `paths.stateDir`     | `"/data/state"`     | Lock, watermarks, logs.         |

These map to the named volumes in `compose.yml` — see
[`architecture.md`](architecture.md#named-volumes).

## Environment overlay (`PHOEBE_*`)

`PHOEBE_*` env vars provide **one-off run overrides** without editing
`phoebe.config.ts` (`src/load-config.ts`). The overlay is additive: an unset
var leaves the field untouched, so `resolveConfig` can still fall back to a
default. Only **scalar** fields are overlayable — nested records
(`promptFiles`, `paths`, `defaultModels`, `providerEnv`, `workOrder`) stay
config-file territory.

| Env var                          | Config field            | Notes                                                               |
| -------------------------------- | ----------------------- | ------------------------------------------------------------------- |
| `PHOEBE_REPO_SLUG`               | `repoSlug`              |                                                                     |
| `PHOEBE_REPO_URL`                | `repoUrl`               |                                                                     |
| `PHOEBE_DEFAULT_BRANCH`          | `defaultBranch`         | Also read directly as the branch the supervisor keeps the clone on. |
| `PHOEBE_BRANCH_PREFIX`           | `branchPrefix`          |                                                                     |
| `PHOEBE_READY_LABEL`             | `readyLabel`            |                                                                     |
| `PHOEBE_PROCESSING_LABEL`        | `processingLabel`       |                                                                     |
| `PHOEBE_PR_OPT_OUT_LABEL`        | `prOptOutLabel`         |                                                                     |
| `PHOEBE_INSTALL_COMMAND`         | `installCommand`        |                                                                     |
| `PHOEBE_CHECK_COMMAND`           | `checkCommand`          |                                                                     |
| `PHOEBE_TEST_COMMAND`            | `testCommand`           |                                                                     |
| `PHOEBE_READY_COMMAND`           | `readyCommand`          |                                                                     |
| `PHOEBE_BLOCKED_BY_PATTERN`      | `blockedByPattern`      |                                                                     |
| `PHOEBE_REVIEWS_SUCCESS_HEADING` | `reviewsSuccessHeading` |                                                                     |
| `PHOEBE_PR_SCOPE`                | `prScope`               | Validated: must be `phoebe` or `all`.                               |
| `PHOEBE_DRAFT_PRS`               | `draftPrs`              | Validated: `skip-non-phoebe`, `skip-all`, or `include`.             |
| `PHOEBE_DEFAULT_PROVIDER`        | `defaultProvider`       | Validated: `cursor`, `claude`, or `codex`.                          |

### Runtime toggles (read directly, not overlaid onto config)

| Env var                   | Default  | Meaning                                                               |
| ------------------------- | -------- | --------------------------------------------------------------------- |
| `PHOEBE_AGENT`            | —        | Provider for this run (`cursor` \| `claude` \| `codex`).              |
| `PHOEBE_MODEL`            | —        | Model for this run.                                                   |
| `PHOEBE_POLL_INTERVAL_MS` | `300000` | Persistent-mode idle poll interval.                                   |
| `PHOEBE_BASE`             | —        | Force the worktree base ref for issues (bypasses blocker resolution). |
| `PHOEBE_QUARANTINED_SHA`  | —        | Set by the supervisor during crash-loop fallback; not for manual use. |

Secrets (`GH_TOKEN` and the active provider's key) are also read from the
environment — see [`ai-install.md`](ai-install.md) and `.env.example`.
</content>
