# Architecture

How Phoebe is put together: one container that is both orchestrator and
execution environment, an origin-hub git model with per-unit worktrees, a
locked-down agent child, and a supervisor that keeps the engine self-updating.

For the day-to-day mechanics of each work kind, see
[`work-kinds.md`](work-kinds.md); for every config field, see
[`configuration.md`](configuration.md).

## Topology: one container, two roles

Phoebe ships as a **single Docker container** that is simultaneously:

- the **orchestrator** — the polling loop that picks the next unit of work
  (`src/main.ts`), and
- the **execution environment** — where the chosen agent CLI runs, installs
  dependencies, edits files, runs your gates, and pushes.

There is no host-spawns-sandboxes layer. Your host checkout is never touched:
the container owns a **private clone** of the target repo and pushes branches
directly to `origin`. The same image drives any repository because every
repo-specific value lives behind one config file
([`configuration.md`](configuration.md)).

The container is built from consumer-owned templates that `phoebe init`
scaffolds (`templates/container/`): a `Dockerfile` (Node + git + `gh` + the
pinned `phoebe-agent` CLI), a base `compose.yml`, a `compose.daemon.yml`
overlay, and a `supervisor.sh`. The engine itself is installed from npm — its
source is never vendored into the consumer repo.

### Host vs. container

The engine detects whether it is running inside the container by the presence
of the marker file `/.phoebe-container` (`src/execution-gate.ts`). This gate is
load-bearing:

- **On the host**, only selection and `--dry-run` are allowed. `repoDir` is the
  current working directory; nothing is mutated, no agent launches, nothing
  pushes. Running a real unit on the host is **refused** with a clear message.
- **Inside the container**, execution proceeds and all git state lives in the
  private clone on the named volume.

Keeping selection logic host-runnable makes it fast to preview what Phoebe
*would* do (`phoebe --dry-run --run-once`) without booting the container.

## Named volumes

Three named volumes hold all persistent state (declared in `compose.yml`,
defaulted in `config.paths`):

| Volume              | Mount             | Config field        | Holds                                    |
| ------------------- | ----------------- | ------------------- | ---------------------------------------- |
| `phoebe-repo`       | `/data/repo`      | `paths.repoDir`     | The private clone (the origin hub).      |
| `phoebe-worktrees`  | `/data/worktrees` | `paths.worktreesDir`| Per-work-unit git worktrees.             |
| `phoebe-state`      | `/data/state`     | `paths.stateDir`    | Lock, watermarks, crash-loop state, logs.|

The consumer's `phoebe.config.ts` and `prompts/` are mounted **read-only** into
`/etc/phoebe` so a `docker compose restart` picks up edits without a rebuild.

## The origin-hub git model

All local git state lives in the private clone; work units never operate on it
directly. Instead, each unit runs in its own **git worktree** created off the
clone (`src/git-model.ts`):

1. `ensureClone` clones `repoUrl` into `/data/repo` once; later cycles reuse it.
2. Each cycle `git fetch origin` refreshes the clone.
3. For a unit, `prepareWorktree` removes any stale worktree for the branch and
   adds a fresh one:
   - **Issues** — a new branch `<branchPrefix>issue-<n>` reset to the resolved
     base ref (`origin/main`, a blocker's branch when stacked, etc.).
   - **Conflicts / checks / reviews** — a worktree on the PR's existing head
     branch (local first, falling back to `origin/<branch>`).
4. The agent works inside the worktree; the engine counts new commits with
   `git rev-list --count <base>..HEAD`.
5. If there are new commits, `pushBranch` pushes straight to `origin`; the
   worktree is then removed in a `finally`.

Worktree directory names are derived from the branch, lowercased with
non-alphanumerics collapsed to `-`, so they are filesystem-safe and collision-
resistant. A failed unit never kills the daemon: `prepareWorktree` clears any
stale worktree on the next attempt.

## The agent child and its locked-down environment

The chosen provider runs as a **direct child process** of the engine, not a
nested container. Providers live in `src/providers/`; three are supported —
`cursor`, `claude`, and `codex` — each wrapping its CLI's argv and stream-JSON
output schema (`src/providers/providers.ts`). Provider and model are chosen per
run from `config.defaultProvider` / `config.defaultModels`, overridable with
`PHOEBE_AGENT` / `PHOEBE_MODEL`.

The child sees a **deliberately narrow env allowlist** (`src/agent-env.ts`):
`PATH`, `HOME`, `GH_TOKEN`, the git identity vars, `CI=true`, and **only the
active provider's API key**. The other providers' keys are never passed, so a
prompt-injected agent cannot exfiltrate the whole keyring.

Prompts are rendered from templates (`src/prompt.ts`): `{{KEY}}` placeholders
are substituted from config-derived args plus per-callsite args, and `` !`cmd` ``
shell blocks that appear in the *raw* template are executed in the worktree and
spliced in. Shell blocks arriving via substituted values are treated as data,
never executed — a marker pass runs before substitution to guarantee it.

## Supervisor self-update and crash-loop fallback

The container's `supervisor.sh` keeps the engine alive and lets Phoebe upgrade
its own code without an operator. The decision logic is specified and tested in
TypeScript (`src/supervisor-decision.ts`); the shell supervisor **mirrors** it
in POSIX sh rather than calling it, so the fallback survives the very failure it
guards against — a bad pull that makes the TypeScript itself fail to boot.

**Self-update.** After each cycle's fetch, the engine diffs `HEAD..origin/<tracked
branch>`. If any changed path matches `config.selfUpdatePaths` (default
`package.json`, `package-lock.json` — i.e. Phoebe's own code or its dependency
lockfile moved), the orchestrator exits with `SELF_UPDATE_EXIT_CODE`. The
supervisor catches that exit code, reinstalls the pinned CLI, and re-execs.
Only the container path self-updates; the host never does.

**Crash-loop fallback.** A freshly pulled SHA that keeps dying on startup is
quarantined: after `CRASH_LOOP_THRESHOLD` (3) consecutive *fast* crashes — a run
that exits non-zero before `HEALTHY_RUN_SECONDS` (60s) — the supervisor pins to
the **last SHA that ran healthily** and passes the quarantined SHA in
`PHOEBE_QUARANTINED_SHA`. While `origin/<branch>` still points at the bad commit,
the engine stays on the good code (no self-update back into the quarantine); once
the branch advances past it (a fix landed), self-updating resumes. A run counts
as healthy if it self-updated, exited cleanly, or survived the healthy window.

The self-update exit code is defined once as the tested spec
(`SELF_UPDATE_EXIT_CODE` in `src/supervisor-decision.ts`, value `42`) and the
scaffolded `supervisor.sh` must watch for the same value. Keep the two in sync
whenever you touch either.

## One cycle, end to end

```
fetch origin ──► self-update? ──exit 42──► supervisor reinstalls + re-execs
      │
      ▼
gather work data for each kind in workOrder
      │
      ▼
selectFirstWorkUnit(workOrder) ──► first kind with a workable unit wins
      │
      ├─ nothing  ──► --run-once: exit · daemon: sleep pollInterval, repeat
      │
      ▼
execution gate (host = refuse · --dry-run = print · container = execute)
      │
      ▼
prepare worktree ─► install ─► run agent ─► count commits ─► push ─► open/update PR
      │
      ▼
--run-once: exit · daemon: repeat
```

The persistent daemon repeats this forever, idling `PHOEBE_POLL_INTERVAL_MS`
(default 300000) between empty cycles. `--run-once` works at most one unit of
the first one-shot-eligible kind (only `issues`) and exits — the janitor kinds
(`conflicts`, `checks`, `reviews`) are persistent-mode only.
</content>
</invoke>
