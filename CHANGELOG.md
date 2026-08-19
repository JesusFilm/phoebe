# phoebe-agent

## 0.7.0

### Minor Changes

- e23cbd0: Credit the issue author on Phoebe's commits (#198). On the issue-to-PR path
  (`issues` and `research` units) the engine now appends
  `Co-authored-by: <login> <id>+<login>@users.noreply.github.com` — the issue's
  author — to every commit it pushes for that unit, so the human who filed the
  ticket gets contribution-graph credit for the work it produced. The trailer is
  applied by the engine after the agent runs and before the push (a message-only
  rewrite of the unit's own commits), so operator prompt overrides need no change.

  Policy, decided here: it applies to every issue Phoebe works — applying
  `readyLabel` is already a maintainer's deliberate act — and never to the janitor
  kinds (`conflicts` / `checks` / `reviews`), which have no single requester. Bots
  and deleted accounts are never credited. Credit is best-effort: a failed author
  lookup, a merge commit in the range, or a failed rewrite leaves the commits
  exactly as the agent made them and logs why.

  New config field `creditIssueAuthor` (default `true`). Set it to `false` on a
  repo where a drive-by reporter's name on agent-written code would read as
  misattribution rather than credit. The opt-out is the operator's only — there
  is deliberately no per-issue or per-author switch.

- b988d95: New bootstrapper-only config block `deployment` (#260, #261) for deployments
  that do not run under Phoebe's Compose driver — Podman, a systemd unit, a
  remote host, anything with its own start/stop incantation:

  ```ts
  deployment: {
    startCommand: "podman compose -f container/compose.yml up -d",
    stopCommand: "podman compose -f container/compose.yml down",
    stopNowCommand: "podman compose -f container/compose.yml down -t 1", // optional
  }
  ```

  When the block is present, `phoebe start` runs `startCommand` and `phoebe stop`
  runs `stopCommand` (`--now` runs `stopNowCommand`, falling back to
  `stopCommand`) via `/bin/sh` with inherited stdio, and skips the docker-on-PATH
  check, Compose discovery, settle wait, and killed-mid-run detection that belong
  to the Compose path. `--build` warns and is a no-op. `startCommand` and
  `stopCommand` must be declared together; a half-declared block or a blank
  `stopNowCommand` is a config error. Like `engine` / `workspace` / `configDir`,
  `resolveConfig` drops the block — the engine never sees it.

  **Nothing changes when the block is absent** — `phoebe start` / `phoebe stop`
  drive `container/compose.yml` exactly as in 0.6.0.

- b988d95: New config field `disabled` (default `false`) — the human off-switch for a
  tenant (#202). Set `disabled: true` in a repo's `phoebe.config.ts` and its
  engine stops dispatching work at the top of the next poll: a run already in
  flight finishes, nothing new starts, and any quarantined work units are
  cleared so the tenant comes back clean when re-enabled. The child keeps
  running (so re-enabling is a config edit, not a restart), and `phoebe list`
  shows a `(disabled)` suffix (`disabled: boolean` in `--json`) while
  `phoebe doctor` reports it as an informational `ok` check.
- 52eaec2: New bootstrapper-only config field `gitIdentity` (#199): a repo declares how its
  commits are attributed — `gitIdentity: { name, email }` in `phoebe.config.ts` —
  instead of every deployment that adopts it restating the four `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` vars in a `.env`. A name and an email are not secrets and are
  repo-scoped, which is exactly the class of fact `phoebe.config.ts` is for.

  **The precedence ladder, decided here** (the objection #161 raised when it
  declined the field). Later wins: the supervisor's deployment-global `GIT_*` <
  the `app` arm's bot fallback < `gitIdentity` < the tenant's own `.env`. The
  config field outranks anything said deployment-wide and is outranked by anything
  said about that tenant specifically, per variable. Nothing moves for existing
  deployments: a `.env` that sets an identity today still wins, and a repo that
  declares nothing gets a byte-for-byte unchanged child env. In solo there is no
  deployment-global rung — the container env _is_ the single tenant's env-file, so
  it wins and the field fills the gaps; where it does, boot logs a line naming the
  vars it overrode, so a declaration cannot go quietly inert.

  Both halves are required — #161 established the email must be exact for
  GitHub's commit→account linkage, so a name-only field would look like it worked
  and attribute nothing — and the pair sets all four vars; author and committer
  are not separately expressible. A malformed value fails the tenant
  (skip-and-warn in a fleet, a hard boot error in solo) rather than silently
  falling back to the deployment's identity.

  Read by the bootstrapper only, like `engine` / `workspace` / `configDir`:
  `resolveConfig` drops it and the engine sees only the env vars the supervisor
  sets from it. Editing the field relaunches that tenant's child with the new
  identity at the next work-unit boundary, no container restart.

- b988d95: GitHub App mode: a deployment can now authenticate to GitHub as an installed
  GitHub App instead of carrying a fine-grained PAT per tenant (#155). Set
  `GH_APP_ID` and `GH_APP_PRIVATE_KEY` (base64-encoded PEM) in the
  deployment `.env` and leave a tenant's `GH_TOKEN` blank; the supervisor mints a
  short-lived installation token for that tenant's repo — narrowed to that one
  repository and the five onboarding permissions — and hands it to the engine
  child. Tokens are refreshed before expiry and re-delivered at the next
  work-unit boundary; a mint failure puts that tenant on hold without touching
  its siblings. The App's private key never reaches an agent process, and in a
  fleet never reaches an engine child; a solo engine child holds it by design,
  since it mints its own token. See
  `docs/github-app-mode.md` for registration, cost, and the per-tenant rate-limit
  budget.

  Every tenant resolves to one of two **credential arms** — `pat` (its own
  `GH_TOKEN`) or `app` — and mixed fleets are supported. The arm is now visible
  across the CLI: `phoebe boot` logs a per-arm tally, `phoebe list` shows an
  `arm:` column (also in `--json`), `phoebe doctor` checks each tenant by its arm
  (an App-arm tenant with no `GH_TOKEN` is healthy, not broken; the arm is only
  determinable inside the container, so an unverifiable check reports `unknown`
  and never fails `--check`), and `scripts/verify-tenant-token.mjs` verifies App
  installations by their granted permissions.

  Along the way, solo deployments gain what fleets already had: the engine child
  runs on an IPC channel with a slot broker, so `PHOEBE_MAX_CONCURRENT_AGENTS`
  now has its documented meaning in solo (default cap 1 — no behaviour change
  unless you raise it), and the engine leases its credential over that channel at
  the top of each poll instead of reading a fixed env var.

  **Nothing changes for existing PAT deployments.** A tenant with a `GH_TOKEN`
  never mints; the PAT arm remains the recommended solo default and is not
  deprecated. App mode is new in this release and has not yet been run in
  Phoebe's own dogfood deployment — treat it accordingly. Existing deployments that want the App arm need the two new
  variables in the deployment `.env` — see `docs/github-app-mode.md` §7 for the
  migration and `docs/configuration.md` for the variable reference.

- b988d95: New verb `phoebe migrate`, and `phoebe upgrade` runs migrations for you (#177).
  A **deployment migration** is a small, idempotent, engine-owned reshaping of
  the files a deployment carries — a prompt file the engine now expects, a work
  kind that should be in `workOrder` — so that moving to a newer engine no longer
  depends on an operator reading the changelog and editing by hand.

  - `phoebe migrate` walks the deployment (solo root, or workspace root plus
    every tenant), applies each registered migration that detects as applicable,
    and prints per-directory verdicts (`migrated` · `up-to-date` · `manual` ·
    `failed` · `reverted` · `skipped` · `invalid`) with the paths it wrote so
    you can review and commit them. Writes are staged and flushed only after a
    migration succeeds, create-if-absent files are written no-clobber, and a
    failure mid-flush or in post-apply validation reverts what was written.
    Dirty tenant trees are skipped, not overwritten.
  - `phoebe migrate --check` previews the walk with every write suppressed and
    exits 1 when anything is pending, for scripted pipelines.
  - `phoebe migrate --json` (with or without `--check`) emits a stable,
    additive-only envelope — documented in `docs/upgrading.md`.
  - `phoebe upgrade` now materialises the **target** checkout and runs _its_
    `migrate` before flipping `engine.ref`, so new code migrates old artifacts and
    a failed migration aborts the upgrade with the pin untouched. `upgrade
--check` is unchanged.

  **What changes for existing deployments.** `phoebe upgrade` may now leave
  uncommitted, reviewable edits in your deployment repos (a scaffolded prompt
  file, a `workOrder` entry) — review and commit them; nothing is pushed for you.
  A migration that fails aborts the upgrade with `engine.ref` untouched. This
  runs only for `engine.source: "github"` deployments: a `source: "local"`
  deployment does not go through the materialise-and-migrate step and must run
  `phoebe migrate` by hand after moving its checkout.

  Two migrations ship in this release: scaffold a missing
  `prompts/research-prompt.md`, and append `"research"` to `workOrder` where it
  is absent. Both are no-ops on a deployment that already has them.

  Config edits are made by a parser-based substrate (a vendored `@babel/parser`
  bundle, MIT) that splices only the bytes it changes and refuses — rather than
  guesses — on config shapes it cannot edit safely (spread, shorthand,
  computed keys, non-literal values, and so on); a refusal reports `manual` with
  the reason. `docs/migrations.md` covers writing migrations, the supported
  config forms, and the closed refusal set.

### Patch Changes

- b988d95: Agent log lines now carry the repo slug in a multi-tenant container:
  `[owner/repo:provider]` (and `[owner/repo:provider:stderr]`) instead of the
  bare `[provider]`, so interleaved agent output is attributable to a tenant.
  `docs/operating.md` is corrected to describe the actual `[<slug>:<command>]`
  prefix shape.
- a25a428: A blocker issue closed as **completed** now satisfies the block (#219). Blocker
  resolution used to ask only "is there a PR on `<branchPrefix>issue-<N>`?", so
  work that landed outside the prefix — a human's `wheat/issue-497`, another
  tool's branch — was indistinguishable from work nobody had started, and every
  dependent issue was skipped forever. `resolveWorktreeBase` gains a third arm
  after the open- and merged-PR arms: `CLOSED`/`COMPLETED` blocker → base
  `origin/main`, unstacked. `NOT_PLANNED` deliberately does not count; an
  abandoned blocker leaves the dependent on unbuilt ground.

  The `gh issue view` behind it is lazy — it fires only when both PR lookups come
  back empty, so every blocker with a Phoebe PR keeps the two calls per cycle it
  costs today and only a blocker Phoebe cannot see pays a third. A failure on it
  is caught the way `buildBlockerStates` already catches blocker-state failures
  (warn, treat as unsatisfied, retry next cycle).

  The idle line also names the blockers now — `3 ready-for-agent issue(s) but none
workable this cycle (waiting on blockers #497, #498)` — instead of a bare count
  that read the same whether the wait was legitimate or a permanent stall.

- b988d95: A GitHub rate-limit 403 is now reported as one, not as a permission failure
  (#201). Failed `gh` calls are classified from their stderr — `rate limit` vs
  `Resource not accessible by …` — and a rate-limit hit is rethrown as
  `GitHub rate limit exhausted (graphql|core) — resets at <time>`, with the reset
  time fetched from `/rate_limit` (which does not count against the primary
  quota). Operators reading
  the log can now tell "wait" from "fix the token".
- eec9021: Mask the deployment env-file inside the container so tenant engine children
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

- b988d95: Rotate a tenant's PAT without a relaunch (#205). Editing only `GH_TOKEN` in a
  tenant's `.env` no longer drains and respawns that tenant's engine child: the
  supervisor answers each credential lease with the token as it currently is on
  disk, and the engine picks it up at its next poll. Every other `.env` value
  still triggers the relaunch (they are frozen into the child's env at spawn).
  Removing or blanking `GH_TOKEN` also relaunches, so an absent token cannot
  linger in a running child.
- 95cc93c: Teach `phoebe start` / `phoebe stop` at the three sites where the long compose
  incantations lived.

  - `phoebe upgrade --cli` now tells operators to run `phoebe start --build` instead
    of the raw `docker compose --env-file ../.env build && docker compose --env-file
../.env up -d` pair.
  - `docs/upgrading.md` leads with `phoebe start [--build]` / `phoebe stop` for
    image rebuilds, the one-time chown step, and the multi-tenant clean-break
    upgrade. Raw compose is kept as a documented fallback with the `--env-file`
    explanation intact.
  - The `container/compose.yml` template header teaches `phoebe start`,
    `phoebe stop`, and `phoebe start --build` as the primary lifecycle commands.

- b988d95: Fewer GitHub calls per poll cycle (#200). The open-PR list is fetched once per
  cycle and shared by the `conflicts`, `checks`, and `reviews` kinds, and each
  PR's merge-info is fetched once (with the existing `UNKNOWN`-mergeability retry)
  instead of once per kind. Behaviour is unchanged; a fleet's per-tenant API
  budget stretches further, which matters most under App-installation rate
  limits.
- 4349cc9: Make the supervisor non-dumpable in the consumer image — chmod 0711 the system node.

  `templates/container/Dockerfile` now applies `chmod 0711 "$(command -v node)"` unconditionally,
  matching the dogfood image's long-standing deviation. The supervisor (`phoebe boot`) and every
  engine child run on this system node; without the execute-only bit, those long-lived processes
  holding `GH_TOKEN` stayed dumpable and a same-uid sibling could read `/proc/<pid>/environ`. The
  dogfood has run exactly this in production — evidence it does not break the shebang shims or
  execute-only ELF loading.

  `docs/trust.md` updated: the "what is isolated" list now names both the vendored cursor node
  (protecting the agent process) and the system node (protecting the supervisor and engine
  children), so the full non-dumpable set is documented.

  `docs/upgrading.md` adds a one-time image-rebuild note for existing deployments that predate
  this change.

## 0.6.0

### Minor Changes

- 1de2e41: Reasoning effort is now configurable per provider. `defaultEfforts` sits beside
  `defaultModels` in `phoebe.config.ts` and is merged the same key-by-key way, so
  `defaultEfforts: { claude: "low" }` sets a level without restating the rest;
  `PHOEBE_EFFORT` overrides the active provider's entry for one run.

  Only the `claude` provider maps it today — to `--effort`, one of `low`,
  `medium`, `high`, `xhigh`, `max`. `cursor` and `codex` have no equivalent knob
  and ignore it.

  **Nothing changes for existing deployments.** The default is empty rather than a
  level, so a provider with no entry is invoked with no effort flag at all and
  keeps its CLI's own default — the behaviour before this change.

- 08048b2: `phoebe start [--build]` brings the deployment container up detached from the
  host. It reuses the Compose discovery and injectable command runner from
  `phoebe stop` (#186), does not rebuild an existing image unless `--build` is
  passed, confirms the container stayed up after a short settle wait, and returns
  to the prompt pointing at how to follow the logs.
- b104f8e: `phoebe stop [--now]` drains and stops the deployment container from the host.
  It resolves `container/compose.yml` from the current directory (no upward walk),
  passes the deployment `.env` only when present, blocks for up to the fleet
  supervisor's 1h drain grace (or 1s with `--now`), streams Compose progress, and
  warns loudly when the container was SIGKILLed mid-run. Shared Compose discovery
  and an injectable command runner land here for `phoebe start` (#187) to reuse.

### Patch Changes

- 78227a3: The scaffolded `container/compose.yml` now sets `stop_grace_period: 1h` so
  `docker compose stop` gives the engine its full drain window (finish the work
  unit in flight, start no new one) instead of Compose's 10-second default, which
  was SIGKILLing mid-run. The value matches the fleet supervisor's
  `DEFAULT_DRAIN_TIMEOUT_MS`.

  **Existing deployments are not updated automatically** — `phoebe init` skips
  files you already have. Add this under the `phoebe` service in your
  consumer-owned `container/compose.yml`, then recreate:

  ```yaml
  stop_grace_period: 1h
  ```

  ```bash
  docker compose --env-file ../.env up -d --force-recreate
  ```

- 703445d: Corepack's download confirmation can no longer hang a work unit. The `pnpm` and
  `yarn` shims `corepack enable` installs default `COREPACK_ENABLE_DOWNLOAD_PROMPT`
  to `1`, so the first use of a version Corepack has not cached yet asks "Do you
  want to continue? [Y/n]" — and blocks on stdin whenever it is a TTY and `CI` is
  unset, which is exactly the case for a deployment started with `docker compose
run`. The engine spawns `installCommand` with inherited stdio, so that question
  reached a terminal with no operator watching it and the unit stalled at install
  rather than failing; the run-timeout deadline cannot interrupt a blocked
  `execSync`, so it stalled indefinitely. `installCommand` and the prompt `!`
  expansions now default the variable to `0`, which answers the confirmation
  without changing what gets downloaded — the version still comes from the repo's
  own `packageManager` field. An operator who sets the variable themselves keeps
  their value. (The expansions were never at risk of hanging — `execSync`'s default
  stdio gives them a piped stdin — but they would still have logged Corepack's
  download notice, and both spawns now build their env the same way.)

  This removes the need for a consumer image to set it: the fix holds for any image
  whose toolchain runs through Corepack, not just those that thought to add the
  `ENV` line.

## 0.5.2

### Patch Changes

- 21f7cf7: Two CLI guards against misleading errors: an unknown bare subcommand is now rejected with the installed version and the `pnpm dlx phoebe-agent@latest upgrade` hint (instead of falling through to the engine-run path and dying in config validation), and the engine-run path refuses a workspace-root config with "run from a tenant directory, or `phoebe boot`" (instead of the five-required-fields error about tenant fields a root never carries).

## 0.5.1

### Patch Changes

- 204aa3e: Quarantine now has two working exits. The auto-un-stick sweep is wired into the
  poll cycle: each cycle Phoebe checks every unit still labelled
  `phoebe:quarantined` and removes the label when the unit's content has advanced
  past the baseline its escalation comment recorded — a PR's head SHA, or a
  fingerprint of the issue body. Issue baselines are that fingerprint rather than
  `updatedAt`, which GitHub bumps on any comment, label, or reaction (including
  Phoebe's own quarantine writes) and which would therefore have cleared every
  quarantine on the first sweep. Both exits — the sweep and a hand-removed label —
  now reset the timeout counter, so a released unit gets a fresh
  `maxUnitTimeouts` allowance instead of re-quarantining on its next timeout. A
  `phoebe:quarantined` label applied by a human is never auto-removed: the sweep
  only acts on a quarantine of its own that is still in force, and ignores the
  baseline of one it has already lifted.

## 0.5.0

### Minor Changes

- 808b24f: New operator commands: `phoebe upgrade` advances the pinned engine ref (a
  strict-literal, in-place rewrite of `engine.ref` in the deployment-root
  `phoebe.config.ts` — refs validated before the pin moves, rollback command
  printed) and/or the npm CLI, with `--check [--json]` as a scriptable
  behind-detector; `phoebe doctor [--json]` reports deployment health (cli and
  engine versions, config, repo reachability, crash-loop quarantine state,
  supervisor liveness) and sweeps every tenant's token and repo reachability.

## 0.4.0

### Minor Changes

- c7a741a: Remove the nested (`repos/<owner>/<repo>/`) layout; **solo and workspace are the
  only supported layouts** (#169). Nested was never used in a real deployment, and
  workspace mode covers every fleet case it was meant to — and better, since
  children are self-configured repos rather than config dirs the operator
  hand-assembles.

  Breaking, with no deprecation window:

  - The surviving single-repo layout is renamed **`flat` → `solo`** everywhere —
    `InitProfile`, the discovery `mode` discriminant, help text, log lines, and
    docs — so code, docs, and `examples/` share one vocabulary.
  - `phoebe init` gains an explicit `--solo` flag alongside `--workspace` /
    `--tenant`. Default behaviour is unchanged: no flag ⇒ solo.
  - `phoebe add-repo` and `phoebe remove-repo` are **deleted** — both were
    nested-only. Workspace children are scaffolded by `phoebe init --tenant`, and
    registering or unregistering one is an edit to the deployment-root config the
    operator owns.
  - `--repo <owner/repo>` is **deleted**, along with the config-selection ladder it
    drove. It existed only to pick a nested tenant's config. So that it fails loudly
    rather than surviving as a no-op alias, engine mode now **rejects any
    unrecognised flag** instead of forwarding it — the engine reads its flags with
    `argv.includes(...)`, so a forwarded unknown flag was silently dropped and a
    typo like `--dry-runn` would run the opposite of what was asked. `--run-once`,
    `--dry-run`, `--config`/`-c`, and `--help`/`-h` are unchanged.
  - `phoebe list` and `phoebe purge` survive minus their nested arms. `list`
    enumerates workspace children and reports no tenants in solo; `purge` now
    refuses whenever a live config still claims the slug — including a _held_
    child, whose engine may still be running — and its advice names no removed
    verb.
  - A deployment root that still carries a `repos/` directory **fails boot** with
    `nested \`repos/\` layout was removed in 0.4.0; use workspace mode`. That guard
    is an error message, not a mode: without it such a tree would fall through to
    solo and die on a misleading "missing required field".
  - `examples/nested/` is retired; `examples/` ships solo and workspace.

  `/data/repos/<owner>/<repo>/` is untouched — that is the runtime data layout for
  every tenant, unrelated to the removed config-side `repos/`.

## 0.3.2

### Patch Changes

- c66e9f1: Validate `promptFiles` at engine startup (#164). Prompt loading was fail-at-use:
  a tenant whose runtime root was missing one prompt kind booted clean, polled
  happily, and only died when the first work unit of that kind was dispatched —
  which for a rare kind meant weeks later, one failed unit at a time. The engine
  now checks, before it starts, every entry the tenant's `workOrder` can actually
  dispatch, and refuses to run with a single error naming the tenant and every
  missing kind with its resolved path. A kind you dropped from `workOrder` needs no
  prompt file — it was never going to be loaded.

  Being a loadable file is the whole rule — a regular file, since a directory would
  pass an existence check and then throw `EISDIR` at dispatch — so a `promptFiles`
  key may point outside the runtime root. That is what a `configDir` tenant wants:
  `issue: "../prompts/issues-prompt.md"` reaches the prompts at the repo root
  instead of keeping a second copy under `<configDir>/prompts/` that silently
  misses every prompt improvement merged afterward.

## 0.3.1

### Patch Changes

- 2b2723e: Add `workspace: { tenants: [...] }` (#128) — the field shape, ordering, and
  validation for declaring a workspace fleet in the root config instead of walking
  the tree for it. A `workspace` block now declares exactly one of two discovery
  arms: `depth` (walk, unchanged and still the default) or `tenants` (an ordered
  list of directory paths). Declared order is authoritative, so it is spawn,
  `phoebe list`, and warn order rather than the walk's emergent slug sort.

  Entries are normalized (`"./widget/"` → `widget`); absolute and `..` paths are
  deliberately supported so a root may supervise repos outside the workspace
  checkout. Fatal at load: an entry that is or contains the workspace root, a
  duplicate after normalization, a tenant nested inside another tenant, a glob, or
  declaring both arms at once. An empty list is a valid zero-tenant fleet.

  One validator in `bootstrap/workspace-source.ts` backs both the bootstrapper and
  `resolveConfig`, so the two entry points cannot drift, and `WorkspaceField` is a
  union — declaring both arms fails to compile as well as to validate.

  Discovery for a declared fleet is not wired yet: a config using `tenants` is
  validated and then refused at boot rather than silently falling back to a walk.

## 0.3.0

### Minor Changes

- 0591258: Add a bootstrapper-only `configDir` field (#98) so a fleet tenant can point at a
  single asset directory instead of duplicating `.env`/`prompts/` at the repo
  root. `configDir: ".phoebe"` makes the supervisor read the tenant's `.env` from
  `<dir>/.phoebe/.env` and run its engine child with cwd `<dir>/.phoebe/` (so
  relative `promptFiles` resolve there), while `phoebe.config.ts` stays at the
  tenant root for discovery. Honored for workspace children and nested `repos/`
  tenants; malformed values are held like a bad `repoSlug`. Default `"."` keeps
  the co-located path byte-for-byte unchanged. Like `engine`/`workspace` it is
  validated then dropped by `resolveConfig` — the engine never reads it.

## 0.2.0

### Minor Changes

- 8bbfa25: Multi-tenant Phoebe: run one container that supervises many repos (map #57). A
  single deployment can now discover a fleet of tenants from
  `/etc/phoebe/repos/<owner>/<repo>/` — each with its own `phoebe.config.ts` and
  `.env` — and run one supervised engine child per tenant behind a global
  concurrency cap, per-tenant `[phoebe:<slug>]` log tagging, per-tenant
  `state/<slug>/status.json`, and `phoebe list`. Env-scrub isolation hands each
  child only its own secrets. The flat single-tenant layout still works
  unchanged; nested discovery is additive.
- 8bbfa25: Wire the poison-unit quarantine write path into the engine (#75/#80). A unit of
  work that repeatedly fails is now quarantined rather than retried indefinitely,
  keeping a poison ticket from stalling the fleet.
- 8bbfa25: Workspace discovery mode (map #81): run `phoebe` at the root of a workspace
  whose child repos are linked as submodules, each carrying its own in-tree
  Phoebe install (config + gitignored `.env`). Phoebe walks the tree, reads each
  child's config, and feeds the same tenant abstraction as multi-tenant mode —
  one supervised engine child per tenant, still cloning each repo privately (the
  local checkout is a discovery + config source only). A `workspace: { depth }`
  block in the root `phoebe.config.ts` selects the mode. Highlights:

  - Discover and supervise a fleet from the submodule tree, reconciling on every
    poll as children come and go.
  - Child `repoSlug` stays authoritative; the submodule `origin` is a best-effort
    cross-check, and duplicate slug/origin across the fleet is a fatal boot abort.
  - `phoebe list` and per-tenant status surface workspace tenants.
  - Two new scaffolder profiles: `phoebe init --workspace` (root) and
    `phoebe init --tenant` (child, prefilling `repoSlug`/`repoUrl` from the
    child's `origin`).
  - Topology docs and an operator runbook for the workspace layout.

### Patch Changes

- 8bbfa25: Bound `superviseFleet.drain` with a SIGKILL escalation (#79). Draining the fleet
  on shutdown no longer hangs indefinitely on a child that ignores SIGTERM — the
  supervisor escalates to SIGKILL after a bounded grace period.
- 8bbfa25: Let the conflict-resolution agent drop relocated or superseded hunks (#89)
  instead of forcing every hunk to apply, so a rebase whose changes have moved or
  already landed upstream resolves cleanly.
- 8bbfa25: Fix two container-boot blockers surfaced by dogfooding: the Corepack download
  prompt hanging boot, and the agent child's `0711` permissions preventing it from
  running.

## 0.1.1

### Patch Changes

- 9b8cb25: Authenticate git against private repos at boot. When `GH_TOKEN` is set,
  `phoebe boot` runs `gh auth setup-git --hostname github.com` once before
  supervising the engine, so `ensureClone`, engine fetch/push, and the agent
  child's own `git push`/`fetch` all authenticate via a live credential helper
  — no token is written to disk.
- bcbeefb: Stop two Phoebe instances on one host from sharing each other's clone. The
  scaffolded compose file lives in a directory named `container`, so Compose
  derived the same project name — and therefore the same "private" `/data/repo`,
  `/data/state`, … volumes — for every repo on the machine. `ensureClone` then
  adopted whatever clone was already there, so an instance could silently run its
  git work against the wrong repo while its `gh` calls used its own `repoSlug`.

  - The scaffold compose file now sets an explicit, overridable project name
    (`name: ${COMPOSE_PROJECT_NAME:-phoebe}`); `.env.example` documents setting
    `COMPOSE_PROJECT_NAME` uniquely per repo when sharing a host.
  - `ensureClone` now verifies an existing clone's `origin` matches the configured
    `repoUrl` and fails loudly on a mismatch instead of adopting a foreign clone.

## 0.1.0

### Minor Changes

- f185f7f: Run buildless on Node 24. The engine (`src/`) and the published bootstrapper now
  run from raw `.ts` via native type-stripping — no `dist/` build, no
  `tsconfig.build.json`; `tsc --noEmit` stays for typecheck only, and the package
  requires Node >= 24.

  Node 24 refuses to type-strip files under `node_modules`, so the two files Node
  resolves there — the `bin` and the `defineConfig` import entry — are a dumb JS
  launcher (`bootstrap/bin.mjs`) and a one-line runtime shim (`bootstrap/index.mjs`).
  The launcher copies the package out of `node_modules` (default under the OS temp
  dir, override with `PHOEBE_ENGINE_DIR`) and execs the real, still-TypeScript
  bootstrapper (`bootstrap/cli.ts`) from there. Consumer-facing behavior is
  unchanged — same `phoebe` / `phoebe-agent` commands, same `defineConfig` import —
  only the Node floor moved to 24.

- d76833c: `phoebe boot` now guards against a bad engine ref. Tracking a branch means
  eventually tracking it onto a commit that will not boot; after three consecutive
  fast crashes (a non-zero exit inside 60s) boot quarantines that commit and
  materializes the last engine SHA that ran healthily instead, keeping the
  container serving until the tracked ref moves past the bad commit — at which
  point the quarantine lapses and reconcile resumes normally.

  A run is judged three ways — healthy, crash, or inconclusive — so that a run boot
  itself ended (a reconcile drain, a container stop) moves nothing, and a commit
  that outlives the healthy window is banked as last-good while it is still
  running. The record (last-good SHA, quarantined SHA, crash count) is JSON in
  `paths.stateDir`, so a quarantine survives the container restart a crash-looping
  engine causes; an unwritable state dir is a warning, not a failure. The guard is
  inert unless the engine ref is a moving branch — a `local` mount has no commit to
  pin, and a pinned SHA or tag means the operator chose that exact commit — and
  inert until some commit has proven itself, so a first boot onto a broken ref
  still fails loudly.

- 2db8640: The engine's self-update machinery is gone, and `phoebe init` scaffolds the
  bootstrapper model. With `phoebe boot` owning engine updates, the engine no
  longer diffs its own code on every cycle and exits for a supervisor re-exec:
  `selfUpdatePaths` is removed from the config, and the shell `supervisor.sh` the
  scaffold used to write is removed with it.

  **The engine version moved out of the image and into the config.** It is now
  `engine: { source: "github", ref }` in `phoebe.config.ts`, and `PHOEBE_VERSION`
  is gone from the scaffolded compose and `.env`. Editing `ref` upgrades a running
  deployment: within one reconcile interval boot drains the engine at a work-unit
  boundary and relaunches it on the new commit — no image rebuild, no container
  restart. A tag or SHA pins exactly; a branch follows its tip, guarded by the
  crash-loop fallback.

  **If you already scaffolded a runtime** (nothing is published yet, so this
  breaks no released version), migrate it:

  - `selfUpdatePaths` is no longer a config field. Remove it — an unknown field is
    a type error.
  - Your `phoebe.config.ts` must import **nothing at runtime**. Replace
    `import { defineConfig } from "phoebe-agent"` with
    `import type { PhoebeUserConfig } from "phoebe-agent"` and a plain default
    export. Boot loads the config from the container mount, where no
    `node_modules` is reachable, so a value import fails to resolve.
  - Add an `engine` field (it defaults to `{ source: "github", ref: "main" }` —
    pin it) and set `PHOEBE_ENGINE_DIR` at a persistent volume so engine checkouts
    survive a restart.
  - Re-scaffold `container/`: the Dockerfile's `ENTRYPOINT` is now
    `["/usr/bin/tini", "--", "phoebe", "boot"]`, `compose.yml` describes the
    long-lived container directly, and `compose.daemon.yml` is replaced by a
    dev-only `compose.local.yml` for running an engine checkout from your host.

- c303d65: First public release of the `phoebe-agent` CLI: the configurable AFK coding-agent
  engine, distributed as a pinned CLI with `phoebe init` scaffolding and container
  templates. Installable via `npx phoebe-agent`.

### Patch Changes

- 8327a35: Introduce nominal (branded) types for git SHAs, branch refs, and PR numbers
  (`Sha`, `BranchRef`, `PrNumber`) with `asSha` / `asBranchRef` / `asPrNumber`
  constructors applied at the `gh`/config trust boundary. These were previously
  bare `string` / `number` that could pass each other's parameter slot silently.
  Internal-only hardening — no consumer-facing API or runtime behaviour change.
