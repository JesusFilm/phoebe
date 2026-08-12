# Competitive landscape: what to steal, what to reject

**Compiled 2026-08-11.** This is a primary-source survey of projects adjacent to
Phoebe — autonomous issue→PR agents, agent-fleet orchestrators, sandboxing
substrates, verification harnesses, and agent control planes — read for
mechanisms worth adopting, not for market positioning.

Companion docs: `docs/performance.md` (same ranked-lever format, throughput
levers), `docs/trust.md` (the trust model this doc repeatedly stress-tests),
`docs/architecture.md` (the seams named throughout). The local
dev-environment/session-manager space is covered separately in
`~/repos/helm-go/docs/adjacent-tools-research.md` (2026-08-10) and is only
cross-referenced here, not re-surveyed.

---

## TL;DR — ranked adoptions

| #   | Pattern                                                                                | Status in Phoebe                        | Effort      | Risk   |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------- | ----------- | ------ |
| 1   | Capture token/cost from the provider stream and enforce a hard budget cap                | **Not implemented** — data is parsed and thrown away | Small       | Low    |
| 2   | Engine-executed verification gate (stop trusting the agent's self-report)                | **Not implemented** — `src/verification.ts` reads an agent-written file | Medium      | Low    |
| 3   | Sanitize untrusted issue/comment text before it reaches the prompt                       | **Not implemented** — spliced verbatim  | Small       | Low    |
| 4   | Rate-limit *commits*, not PRs (rebase storms, not PR count, drive CI cost)               | **Not implemented**                     | Small       | Low    |
| 5   | Landlock + seccomp wrapper around the agent child (issue #12's concrete form)            | **Not implemented** — open issue #12    | Medium-High | Medium |
| 6   | `minimizeComment(OUTDATED)` + `resolveReviewThread` after a successful fix push           | **Not implemented**                     | Small       | Low    |
| 7   | Propagate `TRACEPARENT` into the agent child instead of instrumenting Phoebe              | **Not implemented** — zero OTel in tree | Trivial     | Low    |
| 8   | Repro-test-must-fail-first as the producer gate                                          | **Not implemented**                     | Medium      | Low    |
| 9   | `git worktree lock` / `repair` for crash recovery; `gc.worktreePruneExpire`                | **Not implemented**                     | Small       | Low    |
| 10  | Typed park reasons + approval-recency-by-head-SHA in the sweep                            | **Not implemented**                     | Small       | Low    |

The single most important framing: **Phoebe's differentiator is not the
issue→PR half.** Two dozen projects do issue→PR. Phoebe's uncontested ground is
the *janitor sweep* — polling its own open PRs for conflicts, red CI, and
unresolved review threads — plus multi-tenant one-container-many-worktrees.
Section 6 argues why that gap is structural rather than accidental.

---

## 1. Scope & method

### What was searched

Six parallel primary-source passes, each reading repo source at HEAD, official
docs sites, specs, changelogs, ADRs, and first-party blog posts:

1. OSS autonomous issue→PR agents and the 2026 orchestrator cohort
2. Hosted/commercial coding agents (docs-only where closed source)
3. Agent-fleet / session managers and worktree tooling
4. Sandboxing and isolation substrates (with empirical testing on this host)
5. Verification, evaluation, and PR-fleet operations
6. Observability, cost control, and resumability

Discovery ran through `gh api repos/OWNER/NAME` for metadata, `gh api
.../contents/...` and `raw.githubusercontent.com` for file contents, live
GraphQL introspection against GitHub's production schema for the PR primitives
in §3.6, and `WebFetch` against vendor docs. `gh search repos` with
natural-language queries was tried and largely failed — see §7.

Phoebe itself was read first: `README.md`, `CONTEXT.md`, `AGENTS.md`, and all of
`docs/`, plus `src/main.ts`, `src/kinds/`, `src/git-model.ts`,
`src/providers/`, `src/verification.ts`, `src/quarantine.ts`,
`src/agent-env.ts`, `src/prompt.ts`, `bootstrap/`, `prompts/`, and
`templates/container/Dockerfile`. Every claim about Phoebe below cites a file
in this tree.

### What counts as a primary source

Repo source at a named path, official documentation pages, published JSON
Schemas, live API introspection, vendor changelogs with dates, and first-party
blog posts. No listicles, no "top 10 AI coding agents" posts, no secondary
summaries. Where a project is closed-source — Devin, Google Jules, GitHub
Copilot's coding agent, Sourcegraph Amp, Cursor's cloud backend — **only
official documentation was used, and internals are unverified**. Those claims
are marked inline.

### The freshness problem

This category churns faster than its documentation. Nine structural changes
verified in this survey invalidate most writing older than ~4 months:

| Event                                                                       | Evidence                                                                                                                  | Date       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| OpenHands emptied its flagship repo; engine moved to `software-agent-sdk`    | [commit `cb9138ca`](https://github.com/OpenHands/OpenHands/commit/cb9138ca) "clear repository for Agent Canvas migration"; old monorepo archived at [OpenHands/legacy](https://github.com/OpenHands/legacy) | 2026-07-27 |
| Continue read-only, acquired by Cursor                                       | [README](https://github.com/continuedev/continue/blob/main/README.md); `hub.continue.dev` no longer resolves               | 2026-06-15 |
| Roo Code shut down and archived (24,350★)                                    | [`RooCodeInc/Roo-Code`](https://github.com/RooCodeInc/Roo-Code) `archived: true`; README shutdown notice                   | 2026-05-15 |
| Terragon shut down and open-sourced its orchestrator                         | [terragon-labs/terragon-oss](https://github.com/terragon-labs/terragon-oss), Apache-2.0, snapshot notice 2026-01-16        | 2026-01-16 |
| vibe-kanban sunset at 27.7k★                                                 | [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban), last push 2026-04-24                                        | 2026-04-24 |
| AutoCodeRover acquired by Sonar; license changed to source-available          | [LICENSE](https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/LICENSE) is SONAR Source-Available v1.0             | 2025-02-26 |
| Goose donated to the Linux Foundation (`block/goose` → `aaif-goose/goose`)    | [PR #8152](https://github.com/aaif-goose/goose/pull/8152)                                                                  | 2026-04-07 |
| `githubnext/gh-aw` graduated to first-party `github/gh-aw`                    | repo redirect; MIT; shipping daily                                                                                        | —          |
| SWE-bench harness restructured — layered base/env/instance images **gone**    | `swebench/image_builder/` split from `swebench/harness/`; per-instance dataset-supplied Dockerfiles                        | 2026       |

Host moves that will rot any citation: `docs.claude.com/en/docs/claude-code/*` →
`code.claude.com/docs/en/*`; `developers.openai.com/codex/*` →
`learn.chatgpt.com/docs/*`; `graphite.dev/docs/*` → `graphite.com/docs/*`;
`laude-institute/terminal-bench` → `harbor-framework/terminal-bench-1`;
`docs.github.com/.../coding-agent/risk-mitigation` → `risks-and-mitigations`.

### Staleness flags

Dated by last real (non-bot) commit as of 2026-08-11:

- **Abandoned:** Sweep (code frozen 2024-06-26), Agentless (2024-12-22),
  AutoCodeRover (2025-04-24), `openai/SWELancer-Benchmark` (2025-07-18),
  `openai/evals` (deprecated, README redirects to a hosted product),
  `devflowinc/uzi` (2025-06-04), `entropy-research/Devon` (2025-05-26),
  `ThePrimeagen/git-worktree.nvim`, tmux-resurrect (Aug 2024).
- **Slowing, not dead:** Aider (2026-05-22, and **86 of the last 100 commits are
  one person**), SWE-ReX (2026-03-02 — and it is SWE-agent's load-bearing
  execution layer), moatless-tools (2025-09-01), DevPod (1 commit since Nov
  2025, commercialization "on hold").
- **Maintenance mode by their own README:** SWE-agent — *"Most of our current
  development effort is on mini-swe-agent, which has superseded SWE-agent."*

⚠️ `pushed_at` lies. All three SWE-agent org repos report the same second
because of a `gh-pages` docs deploy. Aider's recent issue volume is inflated by
auto-filed crash reports from its own `report.py`. OpenHands' 83.7k stars
accrued to a Python monorepo and now display on a TypeScript UI shell.

---

## 2. Where Phoebe sits

Phoebe is an AFK autonomous-agent orchestrator. One Docker container is both
the orchestrator **and** the execution environment. Work is discovered by
polling GitHub, executed by a vendored agent CLI in a git worktree, and pushed
straight to origin as a branch and PR.

The design commitments, each verified in-tree:

- **Origin-hub git model.** A private clone plus `git worktree add -B` per unit
  (`src/git-model.ts`); the worktree directory name is the branch lowercased
  with non-alphanumerics collapsed to `-`; `removeWorktree` runs in a `finally`.
- **Work kinds, three janitors and two producers.** `conflicts`, `checks`,
  `reviews` sweep Phoebe's own open PRs; `issues` and `research` produce new
  ones. A `workOrder` priority walk with `pickFirstPlan` selects exactly one
  unit per cycle (`src/main.ts` `runLoop`), and the loop is **stateless between
  cycles** — `docs/work-kinds.md` documents the starvation tradeoff as
  deliberate.
- **Type-erased kind interface.** `WorkKind<Data,Unit>` + `boxKind`
  (`src/kinds/kind.ts`) over an `Io` seam
  (`{github, git, agent, prompts, shell, quarantine}`) built once in
  `runEngine`.
- **Provider-agnostic.** `cursor` / `claude` / `codex` behind
  `src/providers/providers.ts`, each with its own stream-JSON parser.
- **Config-first.** 37 `PHOEBE_*` environment overrides plus a
  `phoebe.config.ts`; a 60-second config/ref reconcile loop; bootstrapper and
  engine are separate processes.
- **Multi-tenant fleet.** `bootstrap/supervise-fleet.ts` spawns one engine child
  per discovered tenant (`bootstrap/tenants.ts`); a FIFO counting-semaphore slot
  broker over IPC (`bootstrap/slot-broker.ts`, `src/slot-client.ts`) caps
  concurrency at `PHOEBE_MAX_CONCURRENT_AGENTS`, default 1.
- **GitHub as the database.** Quarantine state is a marker comment plus a
  `phoebe:quarantined` label (`src/quarantine.ts`), so it survives volume loss.
  Sweep watermarks are hidden HTML comments on the PR: `phoebe-conflict-fail`
  (prHead+mainHead), `phoebe-checks-fail` (prHead), `phoebe-reviews-handled`
  (timestamp).
- **Durable status contract.** `status-v2.json` written by atomic rename plus a
  segmented `events-v1/` JSONL journal (rotate at 100, retain 20), replay
  deduped by `(runtimeId, eventId)`, corrupt tails quarantined
  content-addressed, JSON Schemas in `contracts/`.

### Honest differentiators

1. **Polling a GitHub label as the trigger for a persistent daemon.** Nobody
   else in the survey does this. gh-aw, `claude-code-action`, open-swe,
   OpenCode, and Roomote are all event- or chat-triggered. Sweep did label
   triggers via webhooks and is dead. sandman and cezar can filter on labels but
   sandman is batch-invoked and cezar is human-first. Polling is also the
   correct choice for a self-hosted box: no public ingress, no App registration,
   no webhook-secret rotation.
2. **The full triple sweep as an orchestrator loop.** Conflicts + failing CI +
   unresolved review threads over Phoebe's *own* open PRs. Roomote and
   gluon-agent each own two of three. **Nobody polls for unresolved review
   threads** — every project that touches review feedback requires an explicit
   `@mention` or `/command`.
3. **One long-lived container, many repos, many worktrees.** sandman and
   gluon-agent share the container-pool bet; neither is multi-tenant across
   repos. Roomote is one throwaway sandbox per task.

### Honest weaknesses, all verified in-tree

- **No cost or token accounting anywhere.** `parseClaudeStreamLine`
  (`src/providers/providers.ts:59`) matches the terminal `result` event and
  returns only `obj["result"]` — it discards `usage` and `total_cost_usd`, which
  arrive on that exact object. `AgentRunResult` (`src/providers/run-agent.ts:8`)
  is `{exitCode, resultText}`; there is no field to populate. Grep for
  `total_cost` or `input_tokens` returns zero hits.
- **No tracing.** Grep for OTel returns zero hits.
- **Verification is agent-self-reported.** `src/verification.ts` opens with the
  design statement: *"the engine does not execute checkCommand/testCommand/
  readyCommand itself — by design … the agent runs them as part of its own
  workflow."* It reads a JSON report the agent wrote and falls back to
  `unknown` when absent. The fallback is honest; the gate is not a gate.
- **Untrusted text reaches a permission-bypassed agent verbatim.**
  `prompts/issues-prompt.md` line 1 splices
  `` !`gh issue view {{ISSUE_NUMBER}} --json ...body,comments` `` directly into
  the prompt — the issue body and every comment, undelimited. The agent it
  reaches runs with its permission gate fully off: `claude` gets
  `--dangerously-skip-permissions`, `codex` gets
  `--dangerously-bypass-approvals-and-sandbox`, `cursor` gets `--force`
  (`src/providers/providers.ts:164-221`). **The container is the only sandbox
  boundary.**
- **`GH_TOKEN` is handed over unscoped.** `src/agent-env.ts` `BASE_ALLOWLIST`
  is `["PATH","HOME","GH_TOKEN", …git identity…]` plus `CI: "true"` and the
  active provider key.
- **No egress restriction of any kind.**
- **Cross-tenant `.env` readable at rest.** All tenants share uid 10001;
  `docs/trust.md` documents this as an accepted residual. The 0711 agent-binary
  mode blocks `/proc/<pid>/environ` reads but not file reads.
- **No `$HOME` cache volume**, so every container recreation pays a cold
  install (`docs/performance.md` lever 3).

---

## 3. The landscape

### 3.1 Autonomous issue→PR agents

The category **bifurcated**. The SWE-bench lineage (SWE-agent, mini-SWE-agent,
AutoCodeRover, Agentless) optimizes one issue → one patch for a leaderboard.
None poll, none manage worktrees, none sweep PRs, none are multi-tenant. A
distinct **2026 orchestrator cohort** optimizes many issues → many PRs
unattended over time. That is Phoebe's actual competitive set: young (nearly all
created 2026), unconsolidated (largest is 9,372★), and almost absent from the
SWE-bench literature.

#### [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) — 9,372★, Apache-2.0, Go+TS, active

A Go daemon on `127.0.0.1:3001`, desktop-first. The largest independent find.

- **Status is derived at read time, never stored.** `working`, `ci_failed`,
  `changes_requested`, `mergeable`, `approved`, `pr_open`, `merged` are computed
  from SQLite tables plus a `change_log` CDC table. No status column to go
  stale. ([DESIGN.md](https://github.com/Untrivial-ai/agent-orchestrator/blob/main/DESIGN.md))
- **SCM Observer: 30 s ETag-conditioned polling** (`backend/internal/observe/scm/`)
  — the cheap way to poll GitHub hard without burning quota.
- **Runtime Reaper on a 5 s tick** with the explicit invariant *"Never treat
  failed probes as death"*, paired with *"Never force-delete dirty worktrees"*
  in `backend/internal/adapters/workspace/`. Both are exactly the 3am failure
  modes.
- **36 agent-CLI adapters** under `backend/internal/adapters/agent/`. If
  provider pluggability were a differentiator, this project has already gone
  furthest.
- Does not compete on intake: work enters via `ao spawn`/`ao send`, not a label.
  No concurrency limits, no cost controls.

#### [openai/symphony](https://github.com/openai/symphony) — 26,526★, Apache-2.0

OpenAI's own orchestrator, shipped as a [91 KB SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md)
with an explicit statement that they **will not maintain it as a product**.
Read it as a spec.

- **Claim state machine separate from run phases.** Claims:
  `Unclaimed → Claimed → Running → RetryQueued → Released`. Run phases:
  `PreparingWorkspace … CanceledByReconciliation`. Decoupling "who owns this
  ticket" from "what is this process doing" is the cleanest modeling of the
  problem found anywhere.
- **Deliberately no orchestrator DB.** Recovery re-derives state from the
  tracker and the workspace directories on restart — the same bet Phoebe makes
  with GitHub-as-database.
- **Concurrency shaped by state:** `max_concurrent_agents: 10` **plus**
  `max_concurrent_agents_by_state`.
- **Two timeouts, not one:** `turn_timeout_ms: 3600000` (a turn is slow) and
  `stall_timeout_ms: 300000` (no progress at all).
- **Workflow-as-code** in [`elixir/WORKFLOW.md`](https://github.com/openai/symphony/blob/main/elixir/WORKFLOW.md):
  Backlog → Todo → In Progress → Human Review → Merging → Rework → Done, with
  non-negotiables (reproduce first; validation checkboxes are hard gates; green
  checks required; exactly one `## Codex Workpad` comment per ticket; **never
  `gh pr merge`**).

#### [github/gh-aw](https://github.com/github/gh-aw) — 4,908★, MIT, shipping daily

**The competitor most likely to define this category's vocabulary**, because it
is first-party GitHub. Workflows are Markdown + YAML frontmatter compiled to a
standard Actions `.lock.yml`; engines are a frontmatter field
(`engine: copilot|claude|codex|gemini|pi`) — Phoebe's provider pluggability
expressed as config, by GitHub.

Its **Safe Outputs** model is the strongest structural idea in the whole survey
and is treated in depth in §3.5 and §4.3.

#### [RooCodeInc/Roomote](https://github.com/RooCodeInc/Roomote) — 184★, FCL-1.0-ALv2

Closest live product competitor, and **it does sweep PRs**. From
[`automations.mdx`](https://github.com/RooCodeInc/Roomote/blob/develop/apps/docs/automations.mdx)
and `packages/sdk/src/server/automations/conflict-scan.ts`:

- **"Resolve PR Conflicts"** is a scheduled scan on
  `CONFLICT_RESOLVER_INTERVAL_MS` testing `prDetail.mergeable === false`, gated
  by an opt-in label, an `updated_at` lookback window, and a `created_at`
  age cap.
- **Triple-layer dedup before dispatch** — `hasActiveResolutionRun()`,
  `findActiveGitHubBranchWork()`, `hasRecentGitHubBranchCommit()` bounded by an
  idle window. This is the anti-comment-spam machinery Phoebe's watermarks
  approximate with a single hidden comment.
- Ships **`stall-watchdogs.ts`** and **`exit-certificate.ts`** — wedge detection
  and *proof of clean termination*.
- Isolation is one throwaway sandbox per task via pluggable compute providers
  (Modal, E2B, Daytona, Blaxel, Azure, local Docker).
- ⚠️ **FCL-1.0-ALv2, not OSI-open.** Free self-host ≤10 users; each release
  converts to Apache-2.0 on its second anniversary.

#### [rafaelromao/sandman](https://github.com/rafaelromao/sandman) — 6★, MIT, Go

Badly under-starred. Makes **Phoebe's exact architectural bet, argued in 43
ADRs**: a container pool with many worktrees per container
([ADR-0002](https://github.com/rafaelromao/sandman/blob/main/docs/adr/0002-make-shared-container-the-default-sandbox.md),
[ADR-0005](https://github.com/rafaelromao/sandman/blob/main/docs/adr/0005-replace-isolated-container-toggle-with-container-capacity.md)),
with `container_capacity` (concurrent runs inside one container, default 4) and
`max_containers` as separate dials. `sandman run --label ready-for-agent` is
literally the documented example.

Two mechanisms worth stealing outright:

- **The verify gate is an oracle set over live GitHub state, not a command
  list.** A run is not successful while any of: `mergeable: CONFLICTING`;
  unpushed commits (`git log @{u}..HEAD` non-empty); `reviewDecision !==
  'APPROVED'`; **an approval posted against a stale head SHA**; an unanswered
  trigger comment; an open PR with no acceptance-criteria→test path.
- **A phantom-merge detector** in the
  [back-merge skill](https://github.com/rafaelromao/sandman/blob/main/internal/skill/sandman/back-merge/SKILL.md):
  after a clean merge it re-verifies `git merge-base --is-ancestor`, because
  `git stash` during a merge state silently drops `MERGE_HEAD`. Merge-only,
  never rebase, never force-push.

Weakest axis: one built-in agent preset (`opencode`). Batch-invoked, not a
daemon — the only always-on process is `sandman review`.

#### [carrotly-ai/gluon-agent](https://github.com/carrotly-ai/gluon-agent) — 11★, MIT, Python

The only true *engine-level periodic* PR sweeper besides Phoebe, and its
isolation is Phoebe's exact shape: one long-lived container hosting many git
worktrees, each agent additionally wrapped in bubblewrap.

- The sweep is a real `while True … asyncio.sleep(60)` loop
  (`src/gluon/web/background.py` `poll_pr_status_changes`).
- **The idempotency pair to copy: `last_comment_id` + `last_check_sha`.**
  Comments filtered to `id > run.last_comment_id` with a bot-author exclusion
  regex; CI failures guarded by `run.last_check_sha == run.git_commit_sha` so a
  SHA is never re-processed. That pair is the minimum state for a spam-free
  60-second sweep.
- Every re-entry is tagged (`resume_in_place(initiator="pr-monitor:comment")`)
  and capped by `MAX_AUTO_RESUMES = 5`.
- Health monitor classifies runs `healthy | slow | looping | stuck | zombie` —
  richer than a flat idle timeout.
- No GitHub-issue intake at all; work comes from CLI, dashboard, Telegram, or a
  scheduler.

#### [geserdugarov/agent-orchestrator](https://github.com/geserdugarov/agent-orchestrator) — 9★, Apache-2.0

Tiny, but it is Phoebe's design written down by someone else: 60-second polling;
state in the issue itself as `workflow:<state>` labels plus a pinned
`<!--orchestrator-state {...}-->` comment; worktrees at
`WORKTREES_DIR/<owner>__<name>/issue-N`; multi-repo config where the fifth field
is a per-tenant `parallel_limit`.

- **Typed park reasons** — `verify_failed` / `verify_timeout` / `verify_dirty` /
  `verify_head_changed` — the single most reusable idea here.
- Review watermarks split three ways: `pr_last_comment_id`,
  `pr_last_review_comment_id`, `pr_last_review_summary_id`, plus a debounce.
- `WORKFLOW_TRANSITION_GUARD` with `off | warn | enforce` — ship a state machine
  in warn mode first.
- **Security posture to reject:** its docs say plainly *"the host is the sandbox
  boundary."* Same position Phoebe is in today, stated out loud.

#### OpenHands V1 — [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk), 979★, MIT

The 83.7k stars are on a UI shell now (§1). The engine is here, and it is the
best available reference for **separable execution**: a `Workspace` hierarchy
(`LocalWorkspace`, `DockerWorkspace`, `ApptainerWorkspace`,
`APIRemoteWorkspace` with `runtime_class` defaulting to `"sysbox-runc"`) fronted
by an `agent-server` HTTP process *inside* the sandbox.

- **Per-conversation git worktrees**: `git worktree add -b
  openhands/{conversation_id}`, resolving the start point via `git symbolic-ref
  refs/remotes/origin/HEAD` → `main` → `master` → `HEAD`, cleaning stale state
  first. **But the discipline is prose** — `_build_worktree_guidance()` appends
  a system-message suffix telling the model to stay in the worktree. Nothing
  verifies that it did.
- **Event-sourced persistence with a movable HEAD.** `base_state.json` +
  `events/event-{idx:05d}-{event_id}.json`; `ConversationState` carries
  `leaf_event_id` plus `fork()` / `navigate_to()` — a conversation *tree*.
- **Stuck detection with five heuristics and a one-time nudge**
  (`stuck_detector.py`): thresholds `action_observation=4`, `action_error=3`,
  `monologue=3`, `alternating_pattern=6`. It nudges before declaring `STUCK`.
- ⚠️ **The issue→PR resolver is closed.** V0's `openhands/resolver/` was deleted
  2026-04-23; what runs today is `ghcr.io/openhands/enterprise-server`. Their PR
  sweep, as preserved in the archive, is **comment-only**: it builds
  `failed_jobs = {'actions': [], 'merge conflict': []}`, deletes its own prior
  comment, and posts ``@OpenHands please fix the merge conflicts on PR #N``. The
  loop closes through a webhook, not in-process.
- ⚠️ **No input-side sanitization at all** — issue titles, bodies, and comments
  are interpolated straight into `issue_prompt.j2`. Mitigation is entirely
  output-side: three regex rails plus a *self-reported* `security_risk` on the
  tool call, with `NeverConfirm` as the default.

#### SWE-agent and mini-SWE-agent — superseded by their own README

[SWE-agent](https://github.com/SWE-agent/SWE-agent) (20,045★, MIT) is in
maintenance mode. [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent)
(6,386★) is the live project, and **its rejected-design list is the most useful
artifact in this section**, because Phoebe has made the opposite choice on the
central one:

| Rejected                       | Their stated rationale (verbatim)                                                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stateful shell sessions        | *"Executes actions with `subprocess.run` — every action is completely independent… Seriously, this is a big deal, trust me."* Reasons: **(1)** *"It's not obvious when a command has terminated"*; **(2)** *"Particularly bad commands from the LM can kill the shell session. Then what?"*; **(3)** *"Interrupting a command running in a shell session can also mess up the shell itself."* |
| Custom tools / ACI             | *"Want it to do something specific like opening a PR? **Just tell the LM to figure it out** rather than spending time to implement it in the agent."*                                                                                                            |
| History processors             | *"Completely linear history… there's no difference between the trajectory and the messages that you pass on to the LM."*                                                                                                                                       |

Those three failure modes are what a persistent-worktree-in-a-long-lived-
container orchestrator inherits. §5.1 answers it.

Worth taking from SWE-agent regardless: **three orthogonal budget knobs**
(`per_instance_cost_limit`, `total_cost_limit`, `per_instance_call_limit`, `0`
disables each) with the **remaining budget pushed down into retry attempts**;
Pydantic config with `extra="forbid"` **plus an auto-correct table** so typos
are hard errors with a suggested fix; and
[SWE-ReX](https://github.com/SWE-agent/SWE-ReX)'s discriminated-union
`DeploymentConfig` (`Local | Docker | Modal | Fargate | Remote | Daytona`) where
`--env.deployment.type=modal` swaps the entire execution substrate with no
agent-code change. ⚠️ SWE-ReX is ~5 months idle with no announcement.

#### [Aider](https://github.com/Aider-AI/aider) — 48,129★, Apache-2.0, slowing

Best context construction in the space. `aider/repomap.py` builds a
`MultiDiGraph` of tree-sitter tags (`referencer → definer`) and runs
**personalized PageRank**; the weight heuristics are the real IP (`×10` if the
identifier appeared in the user's message; `×10` if snake/camelCase **and**
`len ≥ 8`; `×0.1` if it starts with `_`; `×0.1` if defined in >5 places; `×50`
if the referencing file is already in chat), with token budget hit by **binary
search** over ranked-tag count. Adding a language is adding one `.scm` file.

Bounded reflection loop: apply → auto-commit → lint → feed lint errors back as
the *next user message* → shell → test → feed test errors back, hard-bounded at
`max_reflections = 3` (a class attribute, not a CLI flag). Note it **appends**
errors to context; Goose does the opposite and **resets history** on retry.

⚠️ Headless landmines if anyone builds on it: open issue
[#5552](https://github.com/Aider-AI/aider/issues/5552) — *"Aider exits with code
0 on fatal API Connection errors, breaking headless automation"* — fix
unmerged; docs say `--yes` while `args.py` defines `--yes-always`; the Python
API is explicitly *"not officially supported or documented."* No GitHub
automation whatsoever.

#### Brief coverage

- **[Sweep](https://github.com/sweepai/sweep)** (7,701★, abandoned 2024) is the
  **closest prior art to Phoebe that ever shipped**. `sweepai/api.py` is a
  webhook router with `GITHUB_LABEL_NAME` defaulting to `sweep` and
  `case "issues", "labeled"`. Its
  [`on_failing_github_actions.py`](https://github.com/sweepai/sweep/blob/main/sweepai/handlers/on_failing_github_actions.py)
  still has the best CI-repair loop in the survey: `GHA_MAX_EDIT_ATTEMPTS = 10`,
  a **`main_passing` baseline guard** so it won't chase failures already broken
  on base, **mid-loop token refresh at 59 minutes**, a PR re-sync every
  iteration (*"IMPORTANT: resync PR otherwise you'll fetch old GHA runs"*), and
  a two-stage log pipeline that prompts with the *previous* iteration's logs so
  the model can see whether it is making progress.
- **[Agentless](https://github.com/OpenAutoCoder/Agentless)** (2,092★, stale
  ~20 months) — see §3.4; still the canonical repro-test-first reference.
- **[Cline](https://github.com/cline/cline)** (66,019★, Apache-2.0, active) has
  the strongest headless surface of the IDE-native agents: `cline --json`
  (NDJSON), `--zen` (fire to a background hub daemon and exit), `--retries`, a
  cron scheduler, and persistent agent teams. **Steal:** its checkpoint
  mechanism (`sdk/packages/core/src/hooks/checkpoint-hooks.ts`) — `git stash
  create` (no working-tree mutation) plus a synthetic **3-parent commit** built
  through a throwaway `GIT_INDEX_FILE`, kept reachable under private refs
  `refs/cline/checkpoints/{sessionId}/{runCount}`. Per-step rollback that never
  touches project git. ⚠️ `maxRequests` is dead — budget is now `--timeout` and
  `--retries`.
- **[OpenCode](https://github.com/anomalyco/opencode)** (196,240★, MIT) is the
  substrate the market is consolidating on (Kilo vendors it; Roomote drives it).
  Three things matter: `opencode serve` + a generated SDK is the best *external
  orchestrator* control surface that exists (`POST
  /session/:id/prompt_async`, `GET /session/status`, `/fork`, `/revert`, OpenAPI
  at `/doc`); first-class typed worktree primitives with an event bus; and the
  best permission model in the cohort, including **`doom_loop`** (*"the same
  tool call repeats 3 times with identical input"*) — the cheapest AFK safety
  valve found anywhere and nobody else has it.
- **[open-swe](https://github.com/langchain-ai/open-swe)** (10,537★, MIT) —
  three LangGraph graphs with deterministic thread IDs so follow-ups route to
  the same running agent; pluggable cloud sandbox per task; git/`gh` inside the
  sandbox authenticate through a proxy with **runtime-minted App installation
  tokens** (`GH_TOKEN=dummy gh`); fail-closed `ALLOWED_GITHUB_ORGS` /
  `ALLOWED_GITHUB_REPOS`. It subscribes to check-run events specifically for CI
  auto-fix on its own PRs.
- **[open-mercato/cezar](https://github.com/open-mercato/cezar)** (146★, MIT) —
  `CEZ_AUTOMATIONS=1` turns on a real poller with `issue.labeled` events and
  `anyLabels`/`excludeLabels` filters, so `ready-for-agent` intake is directly
  expressible. **Steal the idempotency stack**: per-automation
  `cursor{timestamp,tieBreaker}`, `frozenHighWatermark`, per-URL `etags`,
  `backoffUntil`, `consecutiveFailures`, **receipts** (`reserved | launched |
  launch-error`) keyed by `receiptKey`+`eventId`+definition `revision`, and
  `tombstones`. Also **memory-ceiling pausing**: a run crossing `memoryLimitMb`
  is *paused*, freeing the process tree so the queue advances.
- **[vdaubry/bottega](https://github.com/vdaubry/bottega)** (83★, MIT) — the
  best-specified PR agent: every loop has a cap and a "document the persistent
  failure and stop" exit (`gh pr checks` poll max 20; fix iterations max 10;
  conflict rebase + `--force-with-lease` max 3; `UNKNOWN` back off 10 s ×5).
  **It never merges.** Branch name is the join key: `^task\/(\d+)-` regexed out
  of the head branch maps any inbound event back to internal state with no extra
  table. Webhook guard set: HMAC-SHA256 over **raw bytes** with
  `timingSafeEqual`, then "not ready" mapped to **`200 ignored`** so GitHub
  stops retrying.
- Smaller cohort, one line each: **better-symphony** (26★, stale) —
  **label-suffix state machine** (`agent:dev` → `:progress` → `:done|:error`;
  retry = remove `:error`) as a crash-safe claim with no DB. **baton** (20★,
  stale) — hot config reload inside the tick, keeping last-good on parse error.
  **hatice** (154★, stale) — `turnTimeoutMs` **and** a separate `stallTimeoutMs`;
  doesn't open PRs at all. **kobito** (13★, ISC, active) — per-run `notes.md`
  cross-iteration memory, distilled to 1–5 bullets after each commit.
  **[ralph-claude-code](https://github.com/frankbria/ralph-claude-code)** —
  **dual-condition exit** (`completion_indicators >= 2` **AND**
  `EXIT_SIGNAL: true`, so a chatty model can't talk its way out) plus circuit
  breakers `CB_NO_PROGRESS_THRESHOLD=3`, `CB_SAME_ERROR_THRESHOLD=5`,
  `CB_COOLDOWN_MINUTES=30`.

### 3.2 Hosted and commercial agents (docs only — internals unverified)

Everything in this subsection comes from official documentation. No source was
readable; internals are unverified.

#### GitHub Copilot cloud agent

Runs on GitHub Actions with a **59-minute hard cap**. Setup is
`.github/workflows/copilot-setup-steps.yml` with a job that must be named
`copilot-setup-steps`; only `steps`, `permissions`, `runs-on`, `services`,
`snapshot`, and `timeout-minutes` are honored. Notable shipped controls:

- **A default-on egress firewall** with a published allowlist, and
  **blocked-request warnings posted into the PR body/comment** — failure is made
  visible to the human rather than silently swallowed.
- **Hidden-character filtering** on inputs.
- **Single-branch push restriction** — it can only push to `copilot/`-prefixed
  branches.
- Actions require human approval by default; opt-out
  [added 2026-03-13](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/).
- **It cannot approve or merge PRs.**

Copilot Workspace is **sunset** (DNS no longer resolves).

#### OpenAI Codex cloud

Docs at `learn.chatgpt.com/docs/`; the container image
[`openai/codex-universal`](https://github.com/openai/codex-universal) is
published.

- **The agent phase has no internet by default.** When enabled: a domain
  allowlist **plus HTTP-method restriction to GET/HEAD/OPTIONS**.
- **Secrets are available only to setup scripts and are removed before the agent
  phase begins.** This is the single cleanest secret-lifecycle design in the
  survey.
- `.git`, `.agents`, and `.codex` are read-only even inside writable sandboxes.
- **Auto-Review** is a pre-execution policy check.
- `openai/codex-action@v1` exposes `sandbox` and `safety-strategy` inputs;
  `safety-strategy` defaults to **`drop-sudo`** — irreversibly removing sudo
  from the runner's user before invoking the agent — and routes the API key
  through a local proxy so the key never enters the agent's environment.
- Code review **explicitly does not run tests or validate fixes**; it flags
  P0/P1 only. *"Code review rules guide Codex; they don't replace tests, branch
  protections, or required approvals."*

#### Google Jules

Ubuntu VM with a "Run and Snapshot" environment snapshot. **Plan approval is a
first-class lifecycle state** (`AWAITING_PLAN_APPROVAL` +
`sessions:approvePlan`). Intake by labeling an issue `jules`;
`automationMode: AUTO_CREATE_PR`. Published concurrency limits (3/15/60
concurrent, 15/100/300 daily) — rare transparency. CI Fixer shipped 2026-02-19,
Planning Critic 2026-01-26. **No documented egress policy — a real gap** given
everyone else has shipped one.

#### Devin (docs only)

Billing is ACUs with a `max_acu_limit`. **Automations carry per-session ACU
budgets, rate limits, and network policies**, which the docs say are
*"particularly important for automations processing untrusted input"* — an
explicit acknowledgment of the threat model Phoebe currently has no answer to.
Playbooks (`.devin.md`) have optional **Procedure**, **Specifications**
(*"Describe postconditions"*), **Advice**, **Forbidden Actions**, and **Required
from User** sections. *"Without defined validation steps, Devin cannot
confidently complete tasks."* **No programmatic gate, no exit-code contract, no
retry semantics documented.** No branch restriction; it can merge. $/ACU is not
published.

#### Cursor Cloud Agents

`.cursor/environment.json` with `install`/`start`/`terminals`. **Builds** are
bootable snapshots with 90-day retention. **Three secret classes** —
Environment, Runtime (`[REDACTED]` in outputs, transcripts, *and* commits), and
Build. **HSM-backed Ed25519 commit signing.** Network modes: allow-all,
default+allowlist, allowlist-only.

#### Anthropic

[`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action)
(8,600★, MIT, near-daily releases) is the most useful readable artifact:

- **Input sanitization** stripping HTML comments, invisible characters, markdown
  image alt text, hidden HTML attributes, and HTML entities.
- **Base-branch restoration** of `.claude/`, `.mcp.json`, `.claude.json`,
  `.gitmodules`, `.ripgreprc`, `CLAUDE.md`, `CLAUDE.local.md`, `.husky/` — with
  the honest documented residual that *"everything else—including
  `package.json`, lockfiles, and formatter config—comes from the PR head."*
- `validateBranchName()` with explicit rejects for leading `-` (option
  injection), `..`, `//`, `.lock`, `@{`, and all git calls via `execFileSync`
  with **no shell**.
- **It deliberately does not open the PR**, and tells the model *"You cannot
  submit formal GitHub PR reviews, approve, or merge PRs (security reasons)."*
- bubblewrap PID-namespace isolation, with the honest scoping statement that it
  *"reduces but does not eliminate prompt injection risk."*
- A hard-won lesson worth internalizing: unquoted `--allowedTools Bash(gh:*)`
  was silently widening to `Bash(*)`.

Claude Code on the web ships auto-fix PRs reacting to CI failures and review
comments — **and documents the limitation that "GitHub does not emit a webhook
when the base branch advances," so it cannot react to conflicts.** That sentence
is the load-bearing citation for §6.1.

Cloud environments: network levels None/Trusted/Full/Custom with **403 +
`x-deny-reason: host_not_allowed`**, and a **GitHub proxy restricting `git push`
to the session's current branch and pinning allowed GraphQL operations even if
you supply your own `GH_TOKEN`**. Routines are fully autonomous with a
`claude/` branch prefix always accepted and other branches rejected if
protected; the API `/fire` payload is **wrapped in `<routine-fire-payload>`
labeled untrusted**; and the docs carry the honest caveat that *"A green
status… does not mean the task in your prompt succeeded."*

#### Others

**Amp (Sourcegraph)** — orbs billed **$0.08–$1.32/hr per minute, free when
paused**; `.agents/setup` / `.agents/resume`; *"Amp does not ask for approval
before running tools."* No public repo. **Factory** — Droid Computers are
**persistent**; Droid Shield is a **secret-leak guard scanning only newly added
lines and blocking the git operation** (not an injection guard). **Terragon**
— **shut down and open-sourced**
([terragon-labs/terragon-oss](https://github.com/terragon-labs/terragon-oss),
255★): multi-agent CLI support, sandbox container per repo copy, auto branches
and PRs, automations on new issues/PRs. A near-exact Phoebe analogue, and the
strongest available signal that *standalone hosted* orchestration is
commercially hard while self-hosted is defensible.

### 3.3 Fleet, session, and worktree managers

**Anthropic now ships Phoebe's core loop first-party.** Claude Code has a
per-user **supervisor daemon** (`~/.claude/daemon/roster.json`,
`~/.claude/jobs/<id>/state.json`, `CLAUDE_JOB_DIR`, a pre-warmed worker, ~1h
idle reap), background sessions with **automatic worktree isolation** into
`.claude/worktrees/<session-id>/`, and `claude attach|logs|stop|respawn|rm`.

The detail worth copying: **deletion that refuses.** `claude rm` keeps a
worktree that has uncommitted or unpushed work, and refuses outright if another
session claims it. Phoebe's `removeWorktree` in `src/git-model.ts` runs
unconditionally in a `finally`.

Also first-party: `WorktreeCreate`/`WorktreeRemove` hooks (stdout must be the
path and nothing else), and agent teams with file-locked task claims, real
dependency ordering, a `TeammateIdle` exit-2 feedback loop, and an explicit
anti-permission-laundering rule.

#### Dead or moved

vibe-kanban **sunset** 2026-04-24 at 27.7k★. Crystal → **Nimbalyst** (new repo;
stars did not carry). Gitpod Classic PAYG **EOL 2025-10-15** → Ona, with
`.gitpod.yml` deprecated in favor of `devcontainer.json`. DevPod **dormant**.
uzi **abandoned**. `parruda/claude-swarm` **404s** — the gem tarball is the only
primary source left.

#### Mechanisms worth stealing

- **Conductor** — a published JSON Schema for its config; `scripts.archive` and
  `git.archive_on_merge` (*"archive"* as the lifecycle noun, rather than
  "delete"); **10 contiguous ports per workspace via `$CONDUCTOR_PORT`**;
  SIGHUP-then-SIGKILL-after-200 ms.
- **Nimbalyst** — **`git cherry`** for unique-commits-ahead and **`git
  merge-tree`** to *simulate a conflict before touching the repo*. That second
  one is directly applicable to Phoebe's `conflicts` janitor, which currently
  learns about conflicts from GitHub's `mergeable` field.
- **Claude Squad** — pause = commit + detach tmux + remove worktree **but keep
  the branch**.
- **container-use (Dagger)** — the agent's work is exposed as a **git remote
  named `container-use`** backed by a bare fork repo, so review is `git
  checkout <branch>`; merges run with `-c core.hooksPath=…` so the user's hooks
  never fire on agent commits; and **`setup_commands` run before the source dir
  is mounted**, specifically so the install layer caches.
- **Backlog.md** — **`<!-- SECTION:X:BEGIN/END -->` and `<!-- AC:BEGIN -->`
  idempotently-editable comment blocks** inside issue bodies, plus a versioned
  `<!-- backlog.md-instructions-version: X.Y.Z -->` marker. This is a strict
  superset of Phoebe's hidden-HTML-comment watermarks and would let the sweep
  *edit* a region rather than append. Also read-time readiness where duplicate
  dependency IDs resolve to `unresolved` and are **never** treated as satisfied.
- **workmux** (2,111★, richest worktree manager) — `"<global>"` as a list
  element for config merge; **`pre_merge` can abort the merge**; `workmux
  resurrect` reopens with `--continue`; and an explicit written argument against
  putting installs in `post_create`.
- **gwm-cli** — a **TOFU ledger keyed on `(origin URL, sha256(config))`**, with
  guards running immediately after copies. **gtr** — `git gtr trust`.
- **Deterministic port allocation by hashing the branch name**
  (claude-worktree-hooks).

#### Git primitives Phoebe does not use

- **`gc.worktreePruneExpire`** — default `3.months.ago`. A crashed container's
  stale worktree metadata lingers for three months by default.
- **`git worktree lock`** — blocks pruning; `remove` then needs `--force`
  twice. The correct primitive for "an agent is live in here."
- **`git worktree repair`** — fixes worktree/gitdir back-pointers after the
  parent clone moves. Relevant to volume remounts.

#### Devcontainer spec

The **prebuild seam** is `updateContentCommand` — the only lifecycle hook both
prebuild-cached and re-run on refresh, and `waitFor` defaults to it. Lifecycle
commands **accumulate** across the image label, every Feature, and
`devcontainer.json`. `dependsOn` (hard) vs `installsAfter` (soft). CLI
`--id-label` is the container identity handle; `--override-config`;
`--mount-git-worktree-common-dir` (requires `git worktree add --relative-paths`);
`devcontainer up --prebuild`; `.devcontainer-lock.json` + `--frozen-lockfile`.
⚠️ `stop` and `down` are still unimplemented.

#### Protocols

**ACP** spun out of Zed into
[`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol),
with an architectural inversion worth noting: the *agent* calls `fs/*` and
`terminal/*` back on the *client*. Its `session/load` and `session/cancel` map
onto exactly the two capabilities Phoebe lacks. **AG-UI**'s
`StateSnapshot`/`StateDelta` pair formalizes what `status-v2.json` +
`events-v1/` already does informally.

`coder/agentapi` is the minimal control surface worth copying if Phoebe ever
exposes one: `GET /status` → `"stable" | "running"`, `GET /events` as SSE.

### 3.4 Verification, trust, and evaluation

#### The SWE-bench grading contract

Read from `SWE-bench/SWE-bench@main`. Note the 2026 restructure — most published
descriptions of this harness are stale.

The whole semantic model, from the `get_eval_tests_report()` docstring:

```
- Fail-Pass (F2P) + P: Success (Resolution)
- Pass-Pass (P2P) + P: Success (Maintenance)
- Fail-Pass (F2P) + F: Failure
- Pass-Pass (P2P) + F: Failure
```

`PASS_TO_FAIL` is collected but explicitly **"Not considered"** in scoring.
Resolution is ternary internally (`RESOLVED_FULL` / `RESOLVED_PARTIAL` /
`RESOLVED_NO`) and binary externally — `resolved: True` only on `FULL`.

**The anti-reward-hacking primitive**, from `test_passed`/`test_failed`:
a test is **passed** if present in the status map and in `{PASSED, XFAIL}`; it
is **failed** if in `{FAILED, ERROR}` **or absent from the map entirely**. A
test that silently vanishes counts as a failure. You cannot pass by deleting or
renaming the test.

Ancillary mechanisms worth lifting:

- **Sentinel-delimited log parsing.** `>>>>> Start Test Output` /
  `>>>>> End Test Output` bracket the region; four failure codes
  (`Patch Apply Failed`, `Reset Failed`, `Tests Errored`, `Tests Timed Out`)
  cause a fail-closed `({}, False)`. Only text *between* the sentinels reaches
  the parser. Don't parse whole CI logs — have the gate emit its own delimiters.
- **The patch-application ladder**: `git apply --verbose` → `--3way` →
  `--reject` → `patch --batch --forward --fuzz=5 -p1`. Two hard-won details:
  **reset between attempts** (`git checkout -- . ; git clean -fd`, because
  `--reject` leaves partial state that makes every later command fail), and a
  **reverse-apply check as the last resort** (`git apply --check --reverse`,
  because the chain can leave the patch fully applied while each command still
  exited non-zero).
- **Tamper detection**: `git -c core.fileMode=false diff` before and after the
  eval script, logging *"Git diff changed after running eval script"*. It
  records rather than fails, but it is exactly the signal an orchestrator wants.
- **Timeout is a verdict**, not an infra error — `--timeout` defaults to 1800 s
  and `TESTS_TIMEOUT` is one of the four fail-closed codes.

#### Repro-test-first — only Agentless enforces it

[Agentless](https://github.com/OpenAutoCoder/Agentless) (stale, still canonical)
generates 40 reproduction-test samples per issue, materializes each **as a
patch** (`diff --git a/reproduce_bug.py`) so it is separable from the fix, then
— the step nobody else does — **runs them against the UNFIXED tree with
`apply_model_patch=False` and discards every test that doesn't actually
reproduce**. Surviving tests are AST-normalized (`ast.parse` → strip
comments/docstrings → `ast.unparse` → rename to `test_func`) so identical
samples collapse, then majority-voted.

Two further inversions worth noting: regression tests are selected as a
**denylist** (*"identify the tests that should not be run after applying the
patch… as the original functionality may change"*), and acceptance is
**relative** — patches that *tie* the minimum failing-regression count are
accepted, not only those at absolute zero.

The 40× sampling is benchmark-grade, not per-PR budget. **The one piece that is
per-PR-cheap is the pre-patch execution filter**, and it is a one-line check.

Everyone else merely *prompts* for repro-first. SWE-agent's `submit` command is
the strongest prompt-level version: the first `submit` stages the diff, prints a
review checklist with `{{diff}}` interpolated, increments a stage counter in
`/root/.swe-agent-env`, and exits 0 — requiring a second `submit`. The `-f`
bypass is **deliberately hidden from the model**. The shipped checklist's items
2 and 3 are the operationally important ones: *"Remove your reproduction script"*
and *"If you have modified any TEST files, please revert them"* — the two things
that most often pollute an auto-opened PR.

#### Self-verification loops that ship

| System                     | Mechanism                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Claude Code `/goal`        | A separate small-model evaluator after **every** turn; a "no" verdict's reason becomes guidance and another turn starts     |
| Claude Code Stop hook      | Exit code **2** on `Stop` prevents turn end; overridden after **8 consecutive blocks**                                      |
| Claude Code code review    | *"a verification step checks candidates against actual code behavior to filter out false positives"*, then dedupe and rank  |
| OpenHands `/code-review`   | An anti-hallucination **GROUNDING** block; *"prefer 'I could not locate X' over 'X is missing'"*                            |
| Aider                      | Lint/test failure re-injected as the next user turn, `max_reflections = 3`                                                  |
| Agentless                  | Execution-based, **no LLM critic**: regression-count-tie + repro-pass + majority vote                                       |
| Codex review               | LLM review only, **no execution**                                                                                          |

`/goal` is the most Phoebe-shaped primitive: documented as *"a wrapper around a
session-scoped prompt-based Stop hook"*, evaluated by a small fast model (Haiku
by default). Its two published constraints are the interesting part — the
condition is capped at **4,000 characters**, and the evaluator **does not call
tools**, so *"it can only judge what Claude has already surfaced in the
conversation."* The recommended way to bound it is to write `or stop after 20
turns` into the condition itself.

Two artifacts worth copying outright:

- **A third severity bucket.** 🔴 Important / 🟡 Nit / 🟣 **Pre-existing** (bug
  present but not introduced by this PR). Underrated for auto-merge gating: it
  stops the agent being blocked by debt it didn't create.
- **Machine-readable severity in a `neutral` check run.** The check run is
  *always* `neutral` so it never blocks branch protection; the merge script
  reads the tally itself:
  ```
  gh api repos/OWNER/REPO/check-runs/ID --jq '.output.text | split("bughunter-severity: ")[1] | split(" -->")[0] | fromjson'
  # -> {"normal": 2, "nit": 1, "pre_existing": 0}
  ```
  **This is the exact shape Phoebe's auto-merge script wants**: the reviewer
  never blocks, the orchestrator decides.

And an anti-pattern warning worth quoting, from Anthropic's own best-practices
page: *"A reviewer prompted to find gaps will usually report some, even when the
work is sound … Chasing every finding leads to over-engineering."*

#### Verifier isolation — the strongest new idea in evaluation infra

[Harbor](https://github.com/harbor-framework/harbor) (the renamed
Terminal-Bench harness, 4.1k★, v0.21.0 2026-08-10) shipped **separate verifier
sandboxes** on 2026-05-15:

```toml
artifacts = ["/tmp/configured-artifact.txt"]

[verifier]
timeout_sec = 60.0
environment_mode = "separate"

[verifier.environment]
network_mode = "no-network"
cpus = 1
memory_mb = 2048
```

Three stated justifications, only one of which is security: different resource
configs; *"lets users pre-bake dependencies into a verifier image to avoid flaky
package installation"*; and *"an additional security boundary between the agent
and the verification process."* The stated constraint is equally important:
*"verification is limited to copied artifacts, not full container state"* — the
task must explicitly write what the verifier needs.

There is a whole `examples/tasks/network-policy-matrix/` tree exercising
`offline-agent-online-verifier` and `online-agent-offline-verifier`. Network
policy is independently settable per phase.

#### Coverage, mutation, and flake handling — the industry ships all of it advisory

- **Codecov** `coverage.status.patch` with `target: auto` is the closest
  off-the-shelf "the agent's new lines are tested" gate. **`informational: true`
  (default `false`) is the shadow-mode dial.** ⚠️ Two official pages disagree on
  the patch `threshold` default (0% vs 5%).
- **StrykerJS** `thresholds` default `{high: 80, low: 60, break: null}` —
  **`break: null` means Stryker never exits 1.** Live datapoint: OpenHands ships
  `stryker.config.mjs` with no `thresholds` block, so an agent vendor runs
  mutation testing advisory-only on its own repo.
- **Flake handling**: pytest-rerunfailures has **`--fail-on-flaky`**; Datadog
  Auto Test Retries defaults to *enabled* with 5 retries per test and
  **`DD_CIVISIBILITY_TOTAL_FLAKY_RETRY_COUNT=1000` as a per-run circuit
  breaker**; **Buildkite Test Engine distinguishes `enabled` / `muted` /
  `skipped`, where a muted test still runs and still reports, it just doesn't
  fail the build.** That distinction is the right shape for Phoebe's poison-unit
  quarantine — silent skipping loses the signal that the unit is still poisoned.
- **`git bisect --run`** already defines the exit-code contract Phoebe would
  otherwise reinvent: **0 = good, 1–124 & 126–127 = bad, 125 = untestable/skip,
  128–255 = abort.** A generated reproduction script *is* a `bisect run`
  predicate, and `exit 125` is the standard "environment couldn't build" escape
  hatch.

#### Trajectory evaluation you can run in CI on the orchestrator itself

[`UKGovernmentBEIS/inspect_ai`](https://github.com/UKGovernmentBEIS/inspect_ai)
(live) is the most CI-shaped option. Two features matter:

- **Reducers** — `at_least`, `pass_at`, `pass_k`, `mean_score` — express "solves
  it 3 of 5 times" instead of a coin flip.
- **`inspect eval-set`** makes a nondeterministic eval survivable in CI: a
  durable `log_dir` is **mandatory** (*"provides a durable record of which tasks
  are completed so that you can run the eval set as many times as is required to
  finish all of the work"*), with `--retry-attempts` default 10 and
  `--retry-wait` default 30 s exponential.

[`langchain-ai/openevals`](https://github.com/langchain-ai/openevals) is the only
OSS library with first-class **trajectory** evaluators:
`create_trajectory_match_evaluator(trajectory_match_mode=...)` with `strict` /
`unordered` / `superset` / `subset` modes. For Phoebe: `"superset"` = "the agent
must have run the gate and opened the PR; extra exploration fine"; `"subset"` =
"the agent must not have touched deploy tooling." Both are assertions **without
an LLM judge** — the cheapest possible CI regression test for orchestrator
behavior.

The most novel pattern here is OpenHands' own production loop
(`plugins/qa-changes/scripts/evaluate_qa_changes.py`): on PR merge/close it
loads a trace ID carried as a CI artifact from the *original* agent run, fetches
the PR's comments and final state, and opens a **child span on the original
trace** scored by an engagement heuristic (0.3 for producing a report, up to 0.2
scaled by human reply length, 0.3 if the PR merged). **This is outcome telemetry
joined back to the trajectory**, not an offline benchmark — and Phoebe already
has the PR outcomes.

### 3.5 Prompt injection and untrusted input

#### [gh-aw's `sanitize_content_core.cjs`](https://github.com/github/gh-aw) — the reference implementation

1,616 lines, and the best shipped answer to "sanitize issue bodies before
feeding them to an agent." The `hardenUnicodeText` pipeline, in order:

```js
result = result.normalize("NFC");
result = decodeHtmlEntities(result);
result = result.replace(/[\u00AD\u034F\u200B-\u200F\u2060-\u2064\uFEFF]/g, "");   // zero-width, soft hyphen, directional
result = result.replace(/\uDB40[\uDC00-\uDC7F]/g, "");                          // Unicode Tag Chars, Plane 14
result = result.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");                    // bidi overrides / isolates
result = result.replace(/[\uFF01-\uFF5E]/g, c => /* fullwidth -> ASCII */);
result = result.normalize("NFKC");
result = result.replace(HOMOGLYPH_REGEX, c => HOMOGLYPH_MAP[c]);                // Unicode TR#39 confusables
```

Order is load-bearing: NFC first; entity-decode **before** stripping (so
`&#8203;` can't smuggle a zero-width); NFKC **after** fullwidth folding;
homoglyph mapping last.

Two design details worth lifting even if the code isn't:

- **`applyToNonCodeRegions`** — sanitization skips fenced code blocks so
  legitimate code samples survive, and **`balanceCodeRegions` runs last to
  repair fences broken by truncation**, because otherwise truncation itself
  becomes an injection vector.
- **Markdown link titles as a channel**, from the in-code rationale: *"a
  steganographic injection channel analogous to HTML comments… invisible in
  GitHub's rendered markdown (shown only as hover-tooltips) but reaches the AI
  model verbatim."* Most sanitizers strip HTML comments and stop.

The full threat list to port: HTML comments, markdown link titles, zero-width
characters, Plane-14 tag characters, bidi overrides, fullwidth homoglyphs, ANSI
escapes, `@mentions`, `#123` cross-references, bot triggers (capped at 10), and
`{{ }}` template delimiters. **That last one matters directly**: Phoebe's
`src/prompt.ts` uses `{{KEY}}` substitution, and while the marker pass makes
substituted values inert, an issue body containing `{{...}}` is worth
neutralizing explicitly.

#### gh-aw's trust model — the closest published analogue to Phoebe's `vouch`

`tools.github.min-integrity` is a **total order**: `merged > approved >
unapproved > none`, defaulting to `approved` on public repos. Three design
points:

1. It is an ordering, not a boolean.
2. Filtering happens at the **gateway, before the AI engine sees it** — not in
   the prompt.
3. It emits a structured `DIFC_FILTERED` audit event.

And the evidence that the boolean form doesn't hold up: **`lockdown` is
deprecated**, with `lockdown: true` now simply meaning `min-integrity:
approved`. Phoebe's `.github/VOUCHED.td` produces advisory `vouch:*` labels and
the real gate is `ready-for-agent` — a boolean. This is the documented upgrade
path.

#### Safe Outputs — the structural answer

The gh-aw agent job **holds no GitHub credentials at all**. It is read-only and
sandboxed, and emits typed *requests* as structured JSON. A separate
`safe_outputs` job with compiler-computed least-privilege permissions validates
and applies them, with count caps: create-issue **1**, add-comment **1**,
add-labels **3**, close-pull-request **10**. With no `safe-outputs:` block at
all, the default is **only `create-issue`, `max: 1`**. Scoping via `target-repo`,
`allowed-repos` globs, `allowed-base-branches`, `allowed-branches`, and
`staged: true` for dry-run.

**An injected instruction cannot exfiltrate or vandalize if the agent process
holds no token and every write is schema-validated and count-capped by a
separate job.** Sanitization is defense-in-depth on top of this, not a
substitute.

Layered on top: **threat detection** as a distinct job (default **on** whenever
safe outputs exist) that scans for prompt injection, secret leakage, and
malicious patches, and **blocks all safe-output jobs on detection** —
fail-safe, so an infra failure blocks writes rather than allowing them. And an
**egress firewall** (`sandbox.agent: awf` by default) where disabling requires
a **static literal justification string ≥20 characters** that the compiler
rejects if you pass an expression or a boolean, retained for audit.

#### Supply chain — the sharpest unresolved risk

`claude-code-action`'s own `docs/security.md` states it plainly: **`package.json`
and lockfiles come from the PR head**; only a fixed allowlist of agent-config
files is restored from base. This applies directly to Phoebe, which runs a
tenant's own `installCommand`/`checkCommand`/`testCommand` on branches whose
content the agent (or an injected instruction) authored.

Ecosystem hardening now shipping: **npm v12** `allowScripts`, `--allow-git`,
`--allow-remote` (lifecycle scripts opt-in); **pnpm v11** `allowBuilds`,
`strictDepBuilds`, and **`minimumReleaseAge` defaulting to 1440 minutes**.

#### Trigger authorization

The convergent industry answer is **repository permission level**:
`claude-code-action` requires write access; gh-aw's `roles:` defaults to
`[admin, maintainer, write]`; OpenHands requires a label **plus** a same-repo
head so forks never see secrets.

**For Phoebe this has a specific consequence**: the `ready-for-agent` label
should be authorized on **who applied the label**, not who opened the issue.
GitHub's `labeled` event carries `sender`; the check is a
`repos/{owner}/{repo}/collaborators/{user}/permission` lookup. This is the one
place Phoebe's polling design differs materially from every workflow-triggered
system surveyed — polling sees the label's *presence*, not its *provenance*.

### 3.6 PR-fleet operations

#### Renovate — the load-bearing finding

All defaults from `renovatebot/renovate@main` `lib/config/options/index.ts`,
release 44.24.3 (2026-08-11): `prHourlyLimit` **2**, `prConcurrentLimit`
**10**, `branchConcurrentLimit` **null** (inherits from `prConcurrentLimit`),
`commitHourlyLimit` **0** (unlimited), `rebaseWhen` **`auto`**,
`internalChecksFilter` **`strict`**, `platformAutomerge` **`true`**.
(⚠️ `stabilityDays` **no longer exists** — it is a migration shim into
`minimumReleaseAge`.)

**The single most transferable finding in this section**, from
`docs/usage/configuration-options.md`:

> *"`prHourlyLimit` only limits PR creation. Renovate can still rebase existing
> branches, which triggers additional CI runs. `commitHourlyLimit` limits both
> branch creation and automatic rebasing, giving you stricter control over CI
> usage."*

**Rate-limit the commits, not the PRs.** Any "how do you run a bot PR fleet"
answer that reaches for concurrency limits is reaching for the wrong knob,
because rebases dominate CI cost.

Enforcement detail worth copying: `getPrHourlyCount` counts PRs created since
`DateTime.utc().startOf('hour')` — a **wall-clock `:00`–`:59` bucket, not a
rolling window** — and `getConcurrentPrsCount` counts open PRs *among branches
this run would touch*, not all open PRs. For grouped branches, `calcLimit()`
takes the **lowest** member limit, but **any member with `0` or `null` makes the
whole branch unlimited**.

`rebaseWhen: auto` resolves as: `automerge === true` → `behind-base-branch`;
else `keepUpdated` label → `behind-base-branch`; else platform force-rebase →
`behind-base-branch`; **else `conflicted`** (the cheapest option). And
`shouldReuseExistingBranch()` never rebases a human-modified branch — human
commits are sacred, with `rebaseLabel` as the explicit override, **removed after
use**.

**The Dependency Dashboard is the rate-limit escape hatch**, and its protocol is
exactly Phoebe's watermark idiom: HTML comments inside markdown checkboxes.
`- [x] <!-- unlimit-branch=BRANCH -->`, `<!-- approve-branch=BRANCH -->`,
`<!-- rebase-all-open-prs -->`. Checking a box sets `dependencyDashboardCheck`,
which **bypasses every rate limit and every `rebaseWhen` skip**. Rendered
sections include *pending approval*, *awaiting schedule*, *rate-limited*,
*errored/retry*, *manually-edited*, *pending status checks*, and *blocked by
closed PR* — a taxonomy Phoebe's status page could adopt wholesale.

Also worth noting: `internalChecksFilter: flexible` is documented as causing
**"flapping" of pull requests** (a PR at `1.0.3` downgraded to `1.0.2` once it
passes the age gate). Strict is the default for a reason.

#### Dependabot

`open-pull-requests-limit` **default 5**, version-updates only —
*"**Security update pull requests are not subject to this limit and do not count
toward it.**"*

**The 2026 change that matters**: a **default 3-day cooldown on version
updates, applied even when `cooldown` is not configured** (docs commit
2026-07-15; feature flag `dependabot-cooldown-default-days`). Age-gating the
input is now the industry default position, not an optimization.

🔴 **`@dependabot merge`, `squash and merge`, `cancel merge`, `close`, and
`reopen` were removed on 2026-07-15.** The GHES 3.21 release note is explicit:
*"Dependabot comment commands that duplicate functionality native to the GitHub
platform are closing down… Instead, use the equivalent built-in features of
GitHub directly."* **Any Phoebe surface that duplicates a native GitHub
primitive is now swimming against GitHub's stated direction.**

Other transferable details: `schedule` has **"By default, Dependabot randomly
assigns a time"** — jitter as a CI-smoothing default. And *"If a pull request has
not been merged for 30 days, Dependabot will stop rebasing"* — a bounded-effort
rule Phoebe's `conflicts` janitor lacks.

#### Merge queues — five vendors, one taxonomy

**Two distinct conflict classes; conflating them is the most common analysis
error.**

**(a) Semantic conflict** (PRs merge cleanly but the *combination* breaks). This
is what merge queues exist for, and **nobody serializes** — all five
optimistically speculate on a chained state and punish on failure:

| Product   | Speculation unit                                    | On failure                                                                        |
| --------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| GitHub    | `main/pr-N` = base + PRs 1..N, up to `max_entries_to_build` | **Eject failing PR; recreate downstream temp branches without it.** No bisection. |
| Mergify   | batch of `batch_size`, up to `max_parallel_checks`   | **Recursive split (bisection)**, min 2 parts, until the culprit is isolated       |
| Trunk     | batch ~4, predictive-tested against projected trunk  | **Binary bisection**; downstream enters *Pending Failure*, then re-scheduled       |
| Aviator   | draft "bot PR" per batch, `batch_size` default 1     | **Bisection into two half-batches**; a failing predecessor triggers a queue reset |
| Graphite  | `gtmq_` temp branch per stack, N in parallel         | **Full parallel isolation (default)** or optional bisection                       |

Cost model: serial rebase is O(N) CI runs at O(N) latency; optimistic chaining
is O(N) runs at O(1) latency bounded by the concurrency dial; batching is
O(N/batch_size) in the happy path but O(batch_size · log) whenever a batch
fails. **So batching is a bet on a low failure rate, which is exactly wrong for
a high-volume bot fleet with a flaky suite.**

GitHub's **`HEADGREEN`** grouping strategy (vs `ALLGREEN`) is the cheapest
happy path and the only strategy needing no bisection, because it never claims
per-PR correctness. Its documented motivation is flake tolerance: *"useful if
you have intermittent test failures, but don't want false negatives to hold up
the queue."*

Mergify's **`queue_conditions` vs `merge_conditions`** split is the two-step-CI
lever — *"requirements to be accepted into the queue"* vs *"requirements to be
merged once it reaches the front"*. Their own arithmetic: *"For 5 PRs with a
30-minute pre-merge suite, that's 30 minutes instead of 2.5 hours."*

**(b) Textual git conflict** — the actual case for a bot fleet: N PRs all
touching `package-lock.json` / `go.sum` / `Cargo.lock`. **No merge queue solves
this.** GitHub explicitly dequeues on *"conflicts with the base branch."* The
queue hands the problem back to the bot, and the only mechanism is serial
regeneration. **The levers are all upstream**: cap the fleet, cap the *commit*
rate, collapse the PR count (`group:all`), and age-gate the input. The queue is
the last 5%.

#### GitHub primitives Phoebe's sweep should be using

Verified by live GraphQL introspection against the production schema:

- **`PullRequestReviewThread`**: `isResolved`, **`isOutdated`**, `isCollapsed`,
  `resolvedBy`, `viewerCanResolve`. Mutations `resolveReviewThread` /
  `unresolveReviewThread`. `isOutdated` lets the `reviews` janitor distinguish
  *"thread on code that no longer exists"* from *"live objection"* — a
  distinction Phoebe's timestamp watermark cannot make.
- **`minimizeComment` / `unminimizeComment`** with `ReportedContentClassifiers`:
  `SPAM`, `ABUSE`, `OFF_TOPIC`, **`OUTDATED`**, `DUPLICATE`, **`RESOLVED`**,
  `LOW_QUALITY`. **This is the sanctioned anti-comment-spam mechanism** —
  minimize superseded bot comments as `OUTDATED`/`RESOLVED` rather than deleting
  them. Preserves the audit trail, collapses the UI.
- **`MergeStateStatus`**: `DIRTY`, `UNKNOWN`, `BLOCKED`, `BEHIND`, `UNSTABLE`,
  `HAS_HOOKS`, `CLEAN`. **`MergeableState`**: `MERGEABLE`, `CONFLICTING`,
  `UNKNOWN`. `DIRTY`/`CONFLICTING` is the conflicts sweep; `UNSTABLE` is the
  checks sweep; `BEHIND` is needs-update; **`UNKNOWN` means re-poll, GitHub is
  still computing** — a real source of flaky orchestrator logic.
- `MergeQueueEntry` carries a **`solo`** flag (*"Does this pull request need to
  be deployed on its own"*) and `estimatedTimeToMerge`.

#### AI review bots — four anti-spam mechanisms

From [`qodo-ai/pr-agent`](https://github.com/qodo-ai/pr-agent)'s
`configuration.toml`, the best-documented primary source; the taxonomy
generalizes across CodeRabbit, Greptile, Diamond, and cubic:

1. **One persistent comment, updated in place** (`persistent_comment=true`).
2. **Comment fingerprinting** via an invisible HTML marker so re-runs skip
   already-posted inline comments (`persistent_inline_comments`).
3. **A hard findings cap** (`num_max_findings=3`) plus a **score threshold**
   (`th_high=9`, `th_medium=7`) — not "report everything above zero."
4. **Fold on self-review** (`fold_suggestions_on_self_review=true`) — collapse
   suggestions once the author has reviewed, so the bot yields to the human.

Also note `repo_context_from_default_branch=true`, described as *"trusts only
default-branch content."* That is a **prompt-injection control**, not a
convenience — the same idea as `claude-code-action`'s base-branch restoration.

#### Cross-repo campaigns

**Sourcegraph Batch Changes** fans a spec across N repos and tracks changeset
state in a reconciliation controller. The durable idea: **the campaign object is
separate from the changesets**, so "close all of them," "re-run against new
HEAD," and "what's the merge rate" are first-class queries rather than a loop
over PR numbers.

**OpenRewrite / Moderne** are the deterministic counterpart — AST transforms
over Lossless Semantic Trees, where a no-op recipe produces a zero-byte diff.
**Positioning Phoebe against OpenRewrite would be a category error.** The
defensible claim is that Phoebe is the layer that *invokes* recipes where they
exist and reasons where they don't.

### 3.7 Sandboxing and isolation

This section is unusual in that it is **empirically tested on this machine**
(Docker 29.6.2, kernel 7.1.4, uid 10001, default seccomp) rather than only read.

**What works inside Phoebe's container today:**

- **Landlock works.** ABI 9, **0.08–0.09 ms** to apply, inherited across
  `execve`, TCP port rules functional.
- **Nested seccomp-BPF works.**

**What does not:**

- **`unshare(CLONE_NEWUSER)` is EPERM**, blocked by Docker's default seccomp
  profile — verified against moby source (the `clone` argument filter is
  `SCMP_CMP_MASKED_EQ` on `0x7E020000`). **Docker's own documentation is wrong**
  in claiming `CLONE_NEWUSER` is exempt.
- Therefore **bubblewrap, gVisor, Firecracker, Kata, libkrun, Anthropic's
  `sandbox-runtime`, and Codex's Linux sandbox all cannot run as shipped inside
  Phoebe's container.** (`sandbox-runtime`'s `enableWeakerNestedSandbox` swaps
  `--proc` for `--bind /proc /proc`, re-exposing exactly the sibling-process
  information Phoebe's 0711 non-dumpable trick protects.)

**The working Landlock recipe**, with two gotchas found the hard way:
`/dev` must be writable or `git init` fails on `/dev/null`; and granting
`/proc/self` **but not `/proc`** blocks reading a sibling's
`/proc/<pid>/environ` while leaving git fully functional. There is **no viable
Node-native binding** (npm `node-seccomp` abandoned 2022; npm `landlock` is a
toy), so this needs a small Rust or Go wrapper doing
`prctl(NO_NEW_PRIVS)` → landlock → seccomp → `execve`.

**Vendor divergence worth knowing about**: Codex **demoted Landlock to legacy
and vendored bubblewrap** (2026-02-03 → 2026-05-06) because Landlock cannot
express restricted-*read*. Its always-deny seccomp set is `ptrace`,
`process_vm_readv`, `process_vm_writev`, `io_uring_setup`, `io_uring_enter`,
`io_uring_register` (io_uring bypasses syscall filters entirely). It also
filters `CODEX_*` from dotenv so a repo `.env` cannot reconfigure the sandbox.
**Cursor built onto Landlock in the same month Codex left it** (2026-02-18:
Landlock v3 + seccomp + userns + overlayfs) — and Cursor's is the better
template for Phoebe, since bubblewrap is unavailable anyway.

**OpenHands has no OS-level sandbox at all** (grep for
`gvisor|runsc|e2b|seccomp|landlock` → 0 hits).

Two flags on the hosted-sandbox providers: **Daytona is dead and ran
`Privileged: gpuIndex == nil`** — every non-GPU sandbox was a privileged Docker
container while marketing claimed a dedicated kernel. **Fly.io did not migrate
off Firecracker** (Cloud Hypervisor is GPU-only). gVisor needs `CAP_SYS_ADMIN`
(`runsc/sandbox/sandbox.go:1170`); the nesting issue has been open since 2020.

**Egress ladder**, from weakest to enforceable: `HTTP_PROXY` is advisory only
(any binary can ignore it). The enforceable combination is seccomp-restricting
`socket()` to AF_INET/AF_INET6 + Landlock-pinning connect to the proxy port + a
local SNI/CONNECT-filtering proxy (Squid `peek step1` + `splice` needs no MITM).
⚠️ **UDP and DNS remain open below Landlock ABI 10.** Note also that Copilot's
firewall mechanism is undisclosed and its default allowlist includes writable
package registries, so it is a *noise* filter, not an anti-exfiltration
boundary.

Finally: **GitHub App installation tokens (1 hour, per-repo, narrowed
permissions) are strictly better than a shared long-lived `GH_TOKEN`**, and
rulesets add `block force pushes` plus push rules that can block `**/.env`.

### 3.8 Observability and control plane

- **OTel GenAI semconv split out** into
  `open-telemetry/semantic-conventions-genai` (created 2026-05-05, 240★,
  **zero releases**, everything badged Development — but a conformance runner
  exists). Agent spans are `create_agent` / `invoke_agent` / `execute_tool`;
  metrics include `gen_ai.invoke_agent.duration|inference_calls|tool_calls`.
  ⚠️ **OTel GenAI has no cost attribute.** OpenInference does (`llm.cost.*`).
- **Hard spend caps are rare.** Claude Code's `--max-budget-usd` (v2.1.217+,
  counts subagents, emits "Budget limit reached") and Devin's `max_acu_limit`
  are the only real kill switches found. Codex has a weighted-token
  `RolloutBudget` that only *injects reminders*. **OpenHands has a
  `max_budget_per_task` field with no enforcement site** (grep `BudgetExceeded`
  → nothing).
- **Claude Code emits spans** behind `CLAUDE_CODE_ENABLE_TELEMETRY=1` +
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` + `OTEL_TRACES_EXPORTER`, as a tree
  `claude_code.interaction` → `llm_request`/`tool` — **and it propagates
  `TRACEPARENT` into subprocesses and reads inbound trace context.** So the
  cheap win is *propagating* a traceparent into the child, not instrumenting
  Phoebe.
- **Resumability designs:** Claude Code writes
  `~/.claude/projects/<escaped-cwd>/<uuid>.jsonl` with a **`parentUuid`
  parent-pointer tree** plus `file-history-snapshot` behind `/rewind`. Codex
  writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuidv7>.jsonl` with an
  explicit **persist-allowlist policy** (`codex-rs/rollout/src/policy.rs`, 60+
  event types excluded as transient) and a **`reverse_jsonl_scanner.rs`**
  tail-first reader. Phoebe's `events-v1/` journal has neither a persist policy
  nor a tail-first reader.
- **Human-in-the-loop:** OpenHands' `CancellationToken` is deliberately a
  `threading.Event` rather than asyncio, *"usable from both the event-loop
  thread and thread-pool workers"*, and **`WAITING_FOR_CONFIRMATION` is a
  first-class execution status** with a `respond_to_confirmation` endpoint.
  opencode exposes `fork`, `abort`, `revert`/`unrevert`; Cursor exposes
  `POST /v1/agents/{id}/runs/{runId}/cancel`.
- **Journal design worth borrowing:** OpenHands' `DiagnosticEvent` carries an
  explicit **`schema_version` int** and an **`insert_id` idempotency key** — the
  same role as Phoebe's `(runtimeId, eventId)` dedupe, but versioned.

---

## 4. Patterns worth adopting

Ranked by value/effort. Each names real files in this tree.

### 4.1 Capture cost from the stream you already parse, then cap it

**Pattern.** Read `usage` and `total_cost_usd` off the terminal `result` event,
carry them on `AgentRunResult`, emit them on the `WorkOutcomeEvent`, and enforce
a per-run and per-day cap.

**Who does it.** Claude Code's `--max-budget-usd` (counts subagents, emits
"Budget limit reached") and Devin's `max_acu_limit` are the only real hard caps
in the industry; SWE-agent has **three orthogonal knobs**
(`per_instance_cost_limit`, `total_cost_limit`, `per_instance_call_limit`, `0`
disables each) with the remaining budget **pushed down into retry attempts**;
gh-aw has `max-ai-credits` (1000/run) and `max-daily-ai-credits` (5000/day) with
`GH_AW_DEFAULT_*` org overrides. Amp bills orbs per minute and **free when
paused**. Counterexample: OpenHands ships a `max_budget_per_task` field with no
enforcement site.

**Why it fits.** Phoebe runs unattended overnight across a fleet. A wedged unit
burning tokens for 45 minutes (`PHOEBE_RUN_TIMEOUT_MS` default 2,700,000) is
currently invisible until the bill arrives. And the data is *already flowing
through the parser* — `parseClaudeStreamLine` matches the exact object that
carries it and returns only the `result` string.

**What it touches.** `src/providers/providers.ts` (all three
`parseStreamLine`s — Codex and Cursor emit usage too); the `AgentEvent` union in
`src/providers/types.ts`; `AgentRunResult` in `src/providers/run-agent.ts`;
`WorkOutcomeEvent` in `src/status-contract.ts` plus the schema in `contracts/`;
`src/main.ts` for the cap check; `docs/configuration.md` for two new
`PHOEBE_*` vars.

**Effort/risk.** Small / low. The capture half is a few lines and pure gain. The
cap half needs a schema version bump. Note that a per-day cap needs state across
cycles, which the stateless loop deliberately lacks — the natural home is the
status journal, not memory.

### 4.2 Make the verification gate real

**Pattern.** The engine runs `checkCommand`/`testCommand` itself after the agent
finishes, in a separate environment from the one the agent had.

**Who does it.** SWE-bench's grading contract is the reference (§3.4): two-sided
acceptance (F2P **and** P2P), **absence counts as failure**, fail-closed on
ambiguity, timeout as a verdict, tree snapshot before and after. Harbor shipped
**separate verifier sandboxes** on 2026-05-15 with a `no-network` verifier
environment and an explicit artifact manifest. cezar runs shell check steps with
`onFail: {retry: <step-id>, max: N}` and appends failing output to the retried
prompt. Goose's `retry.checks` requires exit 0 and **resets the agent's message
history on each retry** (Aider does the opposite and appends).

**Why it fits.** `src/verification.ts` is honest about what it is — a reader of
an agent-written JSON file, falling back to `unknown` — but an agent that has
`--dangerously-skip-permissions` can write that file without running anything.
The fallback protects against *absence*, not against *fabrication*. Phoebe
already shells out with `SHELL_COMMAND_TIMEOUT_MS = 600_000` for install/test in
other paths, so the machinery exists.

**What it touches.** `src/verification.ts` (add an execute path alongside the
read path); the `Io.shell` seam; `src/main.ts` around
`runAgentInWorktree`; `src/config/types.ts` for a `verifyMode:
"agent" | "engine" | "both"` switch. Keeping the agent-report path as a
*secondary* signal is worthwhile — a disagreement between the two is itself a
high-value event.

**Effort/risk.** Medium / low. Ship it in shadow mode first and only compare —
**the observed industry default is advisory-first** (OpenHands ships Stryker
with `break: null`; Codecov ships `informational: true` for exactly this
reason). Sequencing the engine gate *after* the agent's own run costs wall-clock
time on the critical path; that tradeoff belongs in `docs/performance.md`.

### 4.3 Sanitize untrusted issue and comment text

**Pattern.** Run issue bodies and comments through a normalization and
neutralization pipeline before they reach the prompt, and wrap them in explicit
untrusted-content delimiters.

**Who does it.** gh-aw's `sanitize_content_core.cjs` is the reference
implementation (§3.5) — full pipeline, ordering rationale, and the
markdown-link-title channel most sanitizers miss. `claude-code-action` strips
HTML comments, invisible characters, markdown image alt text, hidden HTML
attributes, and HTML entities. Copilot does hidden-character filtering. Claude
Code Routines wraps its API payload in `<routine-fire-payload>` **labeled
untrusted**. `pr-agent` sets `repo_context_from_default_branch=true` for the same
reason. Counterexample: OpenHands does none of it.

**Why it fits.** `prompts/issues-prompt.md` line 1 splices the issue body and
every comment verbatim and undelimited into a prompt for an agent with its
permission gate off and an unscoped `GH_TOKEN` in its environment. This is the
single highest-severity finding in the repo read, and it is also among the
cheapest to fix. Note `{{ }}` neutralization specifically — Phoebe's own prompt
templating uses that delimiter.

**What it touches.** `src/prompt.ts` (a `sanitizeUntrusted()` applied to shell-
splice output, or better, a new `` !untrusted`cmd` `` splice form so the
distinction is explicit at the template level); `prompts/issues-prompt.md` and
any other prompt with a `gh issue view` / `gh pr view` splice; `docs/trust.md`.

**Effort/risk.** Small / low. The main risk is over-stripping legitimate content
— which is exactly why gh-aw's `applyToNonCodeRegions` + `balanceCodeRegions`
design matters: sanitize outside fenced blocks, then repair fences broken by
truncation.

### 4.4 Rate-limit commits, not PRs

**Pattern.** Bound the number of *branch pushes per hour*, not the number of
open PRs, because rebases and fix-pushes dominate CI cost.

**Who does it.** Renovate's `commitHourlyLimit`, with the rationale stated
explicitly in its own docs (§3.6). Dependabot has no equivalent and bounds only
fleet size. Renovate also uses a **wall-clock hour bucket**, not a rolling
window — cheaper and adequate.

**Why it fits.** Phoebe's three janitors push to existing PR branches on every
sweep. A tenant with 20 open Phoebe PRs and a red main branch will regenerate
and push repeatedly, each push a full CI run, with nothing in the engine
bounding it. The existing controls (`PHOEBE_MAX_CONCURRENT_AGENTS`,
`PHOEBE_POLL_INTERVAL_MS` default 300,000) bound *agent* concurrency, not
*push* rate.

**What it touches.** `src/git-model.ts` `pushBranch` is the single choke point;
a counter in the status journal (so it survives restarts) plus a check in
`src/main.ts` before unit selection. `docs/configuration.md` for the new var.
The natural companion is Renovate's `keepUpdatedLabel` idea: an opt-in per-PR
label that exempts a specific PR from the cap.

**Effort/risk.** Small / low. The one design decision is what a rate-limited
cycle does — skip the unit (starves it, consistent with the documented
starvation tradeoff in `docs/work-kinds.md`) or pick a different kind.

### 4.5 Landlock + seccomp wrapper around the agent child

**Pattern.** A tiny setuid-free wrapper binary that applies
`prctl(NO_NEW_PRIVS)` → Landlock ruleset → seccomp filter → `execve` of the
agent CLI.

**Who does it.** Cursor (2026-02-18: Landlock v3 + seccomp + userns +
overlayfs), Kilo Code's `packages/kilo-sandbox` (bubblewrap/seatbelt + network
relay + mutation protocol), Codex's `codex-rs/sandboxing` (now bubblewrap-first,
Landlock legacy), `deer` (Anthropic Sandbox Runtime + a host-side MITM auth
proxy so the sandbox never holds the real token).

**Why it fits.** This is the concrete form of open issue **#12** ("A2: Split
trusted supervisor from untrusted executor"). The empirical result is the
decisive input: **Landlock works in Phoebe's container at 0.08 ms, and
bubblewrap/gVisor/sandbox-runtime do not** — so the design space is smaller than
it looks and the answer is already picked. It closes three named risks at once:
the cross-tenant `.env` read documented in `docs/trust.md`, worktree escape, and
(with the port rule) the first rung of egress control.

**What it touches.** `src/providers/run-agent.ts` `defaultSpawn` is the single
insertion point — the wrapper becomes `file` and the current `file` becomes
`args[0]`. `SpawnAgent` is already an injectable seam for tests. Plus a new
build stage in `templates/container/Dockerfile` for the Rust/Go wrapper, and
`docs/trust.md`.

**Effort/risk.** Medium-high / medium. It introduces a compiled artifact into a
TypeScript repo. Two known gotchas: `/dev` must be writable or `git init` fails
on `/dev/null`, and granting `/proc/self` **but not `/proc`** is the rule that
blocks sibling-environ reads while leaving git working. Landlock cannot express
restricted-*read* (this is why Codex left it), so read-side confinement stays
coarse.

**Related but separately valuable:** **Route A** — run the engine as in-container
root and `setuid` per tenant — closes the cross-tenant `.env` risk **under
Docker's default seccomp**, and is easier than the rootless-userns "model B"
sketched in `docs/trust.md`, which needs `seccomp=unconfined`.

### 4.6 Minimize superseded comments; resolve threads the agent fixed

**Pattern.** After a successful fix push, call `resolveReviewThread` on threads
the agent addressed and `minimizeComment(classifier: OUTDATED)` on the bot's own
superseded comments.

**Who does it.** These are GitHub's sanctioned primitives, verified live in the
production GraphQL schema (§3.6). `pr-agent`'s four anti-spam mechanisms
(persistent comment, fingerprinting, findings cap, fold-on-self-review) are the
prose version of the same instinct.

**Why it fits.** Phoebe's watermarks (`phoebe-reviews-handled` and friends) stop
it re-processing, but the *human-visible* artifact of a long-running janitor is
an accumulating column of stale bot comments. `docs/trust.md`'s
"comment-spam failure mode" (also recorded in the fork's operational memory) is
this exact problem. Minimizing preserves the audit trail, which deleting does
not.

**What it touches.** `src/github.ts` (two new GraphQL mutations — the REST
client will need a GraphQL path if it doesn't have one); the `reviews` janitor
in `src/kinds/`. `isOutdated` on `PullRequestReviewThread` is worth reading at
the same time: it lets the janitor skip threads on code that no longer exists.

**Effort/risk.** Small / low.

### 4.7 Propagate `TRACEPARENT` into the agent child

**Pattern.** Generate a span ID per work unit, set `TRACEPARENT` in the agent's
environment, and let the agent CLI's own instrumentation hang its spans off it.

**Who does it.** Claude Code both **reads inbound trace context and propagates
`TRACEPARENT` into subprocesses**, emitting a `claude_code.interaction` →
`llm_request`/`tool` tree. Goose emits `gen_ai.*` attributes with full OTLP
plumbing.

**Why it fits.** Phoebe has zero OTel and adding real instrumentation is a
project. This is not that: it is two environment-variable lines that make the
*agent's* existing telemetry attributable to a Phoebe unit, for free. It is the
highest ratio in the doc.

**What it touches.** `src/agent-env.ts` — add `TRACEPARENT` to `BASE_ALLOWLIST`
and generate the value per unit in `src/main.ts`. ⚠️ Note that
`BASE_ALLOWLIST` is a *deny-by-default* list, so a `TRACEPARENT` inherited from
the environment is currently stripped; this is both why the change is needed and
why it is safe.

**Effort/risk.** Trivial / low. ⚠️ Claude Code's span export is behind a beta
flag, so verify it is still gated the same way before documenting it.

### 4.8 Repro-test-must-fail-first

**Pattern.** For an `issues` unit that produces a test, run the new test against
the *pre-change* tree. If it passes there, it does not prove anything — discard
it and tell the agent.

**Who does it.** Only Agentless *enforces* it (§3.4). SWE-agent, Claude Code,
Codex, and Devin all merely prompt for it.

**Why it fits.** It is the cheapest available differentiator on verification
quality, it is a single extra command, and it composes with 4.2 — the engine is
already going to have a second worktree checkout to run gates in.

**What it touches.** `src/kinds/` (the `issues` producer), reusing the
`git worktree` machinery in `src/git-model.ts` against `origin/HEAD`, plus a
prompt change in `prompts/issues-prompt.md`.

**Effort/risk.** Medium / low. The hard part is deciding *which* new tests to
run pre-patch; the cheap heuristic is "test files added or modified in this
unit's diff." `git bisect --run`'s exit-code contract (§3.4) gives the
untestable case (`exit 125`) a standard meaning for free.

### 4.9 Worktree lifecycle primitives

**Pattern.** `git worktree lock` while a unit is live; `git worktree repair`
after a volume remount; a tightened `gc.worktreePruneExpire`; and refuse to
remove a worktree with uncommitted or unpushed work.

**Who does it.** Claude Code's `claude rm` **refuses** to delete a worktree with
uncommitted or unpushed work and refuses outright if another session claims it.
ao's workspace adapter carries the invariant *"Never force-delete dirty
worktrees."* Nimbalyst calls `git worktree prune` from three separate sites.

**Why it fits.** `src/git-model.ts` `removeWorktree` runs unconditionally in a
`finally`. On the happy path that is right; after a crash mid-push, it discards
the only copy of the work. `gc.worktreePruneExpire` defaults to `3.months.ago`,
so a crashed container's stale metadata lingers for a quarter.

**What it touches.** `src/git-model.ts` only.

**Effort/risk.** Small / low. Interacts with the crash-loop fallback in
`bootstrap/crash-loop.ts` — a locked worktree that outlives its engine needs an
unlock path, or the lock becomes the new leak.

### 4.10 Typed park reasons and head-SHA-pinned approval recency

**Pattern.** When a unit stops without completing, record a *typed* reason
(`verify_failed` / `verify_timeout` / `verify_dirty` / `verify_head_changed`)
rather than a free-text failure. And treat an approval posted against a stale
head SHA as *not an approval*.

**Who does it.** geserdugarov's typed park reasons; sandman's approval-recency
rule, where a new head SHA resets the review budget both intra- and
inter-session. sandman names the failure this prevents: *a stale approval
strands the run at PR-merge after a back-merge.*

**Why it fits.** Phoebe's quarantine counts consecutive failures per
`(kind, id, trigger)` without distinguishing *why*. A unit failing on
`verify_timeout` three times is a different problem from one failing on
`verify_head_changed` three times, and only the first should count toward
quarantine. The approval-recency bug is one Phoebe will hit as soon as
auto-merge is live, since the `conflicts` janitor pushes new head SHAs to
already-approved PRs by design.

**What it touches.** `src/quarantine.ts` (key the counter on the reason as
well); the `WorkOutcomeEvent` shape and `contracts/`; the merge-readiness check
wherever `reviewDecision` is consulted in `src/github.ts`.

**Effort/risk.** Small / low. Requires a status-contract schema bump.

### Honorable mentions

- **`git merge-tree` to simulate a conflict** before touching the repo
  (Nimbalyst) — lets the `conflicts` janitor confirm a real conflict rather than
  trusting GitHub's `mergeable`, which also returns `UNKNOWN` while computing.
- **Sweep's `main_passing` baseline guard** — never chase a CI failure that was
  already red on base. Directly applicable to the `checks` janitor, and
  battle-tested in production in 2024.
- **Mid-loop token refresh at 59 minutes** (Sweep) — relevant the moment Phoebe
  moves to App installation tokens, which expire at exactly 1 hour.
- **`doom_loop`** (OpenCode) — abort when the same tool call repeats 3 times
  with identical input. The cheapest AFK safety valve found anywhere.
- **Dual-condition exit** (ralph-claude-code) — require both a structural signal
  and an explicit `EXIT_SIGNAL: true`, so a chatty model cannot talk its way to
  "done."
- **`<!-- SECTION:X:BEGIN/END -->` editable regions** (Backlog.md) — a strict
  superset of Phoebe's watermark comments that would let the sweep *edit* a
  region instead of appending.
- **Two timers, not one** (symphony, hatice): `turn_timeout` (slow) is a
  different failure from `stall_timeout` (no progress). Phoebe has only
  `runWithDeadline`.
- **`min-integrity` as a total order** — the documented upgrade path for
  Phoebe's boolean `ready-for-agent` gate, with gh-aw's deprecation of boolean
  `lockdown` as evidence the boolean form doesn't survive contact.
- **Label-provenance authorization** (§3.5) — check the permission of whoever
  applied `ready-for-agent`, not the issue author.

---

## 5. Patterns worth rejecting

### 5.1 Stateless one-shot execution (mini-SWE-agent's model)

mini-SWE-agent argues, first-party and in writing, that persistent shell
sessions are a mistake: *"Executes actions with `subprocess.run` — every action
is completely independent… Seriously, this is a big deal, trust me."*

**Reject, but answer it.** Phoebe's worktree is not a persistent *shell*; it is a
persistent *filesystem*, and the agent CLIs it drives already run each tool call
as an independent process. Two of mini's three named failure modes ("it's not
obvious when a command has terminated"; "interrupting a command can mess up the
shell") are properties of a long-lived PTY, which Phoebe does not have. The
third — "bad commands from the LM can kill the session" — is real and is exactly
what `AGENT_KILL_GRACE_MS` and `runWithDeadline` exist for.

But mini is optimizing for benchmark reproducibility across thousands of
one-shot instances, where per-instance container setup is the dominant cost and
carrying state is pure liability. Phoebe optimizes for one repo over months,
where warm installs are the dominant cost. Different objective, different
answer. This tradeoff deserves a paragraph in `docs/architecture.md` rather than
a code change.

### 5.2 Webhook-driven intake

Every hosted system uses webhooks; gh-aw compiles to Actions; Roomote, open-swe,
and bottega are all event-driven.

**Reject.** Polling is the correct choice for a self-hosted multi-tenant box:
no public ingress, no GitHub App registration, no webhook-secret rotation, no
delivery-retry semantics to get wrong, and no `pull_request_target` "pwn
request" class at all. It also **enables §6.1** — the base-branch-advanced event
that no webhook system can see. The cost is latency
(`PHOEBE_POLL_INTERVAL_MS` default 300,000) and API quota, and ao's 30-second
ETag-conditioned polling shows the quota half is solvable.

### 5.3 Merge queues as the answer to conflicting bot PRs

**Reject as a *primary* mechanism.** §3.6(b) is the finding: merge queues solve
ordering and semantic correctness; **no merge queue solves textual conflict**.
GitHub explicitly dequeues on *"conflicts with the base branch."* For a fleet of
Phoebe PRs all touching a lockfile, the queue hands the problem straight back.

Phoebe's `conflicts` janitor **is** the right primitive. A merge queue is worth
recommending to tenants as a downstream complement — and if one is in play,
`HEADGREEN` over `ALLGREEN` (cheaper, flake-tolerant) — but it is not the
answer to the question it appears to answer.

### 5.4 Batched speculative CI

Mergify, Trunk, Aviator, and Graphite all batch and then bisect on failure.

**Reject.** The cost model is `O(N/batch_size)` in the happy path but
`O(batch_size · log)` on failure. **Batching is a bet on a low failure rate**,
and an AFK agent fleet against a real test suite is the opposite of that. Trunk
and Aviator both default `batch_size` to small numbers (4 and 1) for exactly
this reason.

### 5.5 Comment commands as a control surface

`@dependabot merge`, `squash and merge`, `cancel merge`, `close`, and `reopen`
were **removed on 2026-07-15** with an explicit rationale: commands *"that
duplicate functionality native to the GitHub platform are closing down…
Instead, use the equivalent built-in features of GitHub directly."*

**Reject anything that duplicates a native primitive.** Phoebe's label-driven
control surface is fine — labels have no native equivalent. But a
`@phoebe merge` command would be building against GitHub's stated direction, and
native auto-merge plus `enablePullRequestAutoMerge` is the sanctioned path.

Note also Dependabot's warning that ignore preferences set by comment are
**stored centrally and invisible in the config file** — a class of state Phoebe's
GitHub-as-database model should stay away from. Phoebe's markers are at least
visible in the PR.

### 5.6 An LLM critic as the primary gate

Codex's code review explicitly does not run tests. Anthropic's own
best-practices page warns: *"A reviewer prompted to find gaps will usually
report some, even when the work is sound … Chasing every finding leads to
over-engineering."*

**Reject as a gate; accept as a signal.** Agentless's execution-based selection
(repro-pass + regression-count-tie + majority vote, **no LLM critic**) is the
model. If Phoebe adds a reviewer, it should use the neutral-check-run +
machine-readable-severity-tally shape (§3.4) so it never blocks branch
protection and the orchestrator decides.

### 5.7 A database for orchestrator state

ao uses SQLite with CDC; Roomote uses Postgres + Redis + BullMQ.

**Reject.** Phoebe's GitHub-as-database choice (marker comments, labels,
watermarks) survives volume loss, is human-inspectable, and needs no migration
story — and **openai/symphony independently reached the same conclusion**,
specifying no orchestrator DB and re-deriving state from tracker plus filesystem
on restart. Two convergent designs from opposite directions is a strong signal.
The gaps are narrow (a per-day cost counter, a commit-rate bucket) and the
existing `events-v1/` journal is the right home for both.

### 5.8 Hosted sandbox providers as the isolation story

E2B, Modal, Daytona, and friends are attractive because Roomote and open-swe
delegate to them.

**Reject.** It contradicts the single-container design outright, and the
diligence is worse than it looks: **Daytona is dead and ran `Privileged:
gpuIndex == nil`** — every non-GPU sandbox was a privileged Docker container
while its marketing claimed a dedicated kernel. In-container Landlock (§4.5) is
0.08 ms, needs no vendor, and no network round-trip.

---

## 6. Gaps nobody has filled

### 6.1 Conflict sweeping is structurally unavailable to webhook systems

Anthropic states it outright in their own docs: **"GitHub does not emit a
webhook when the base branch advances."**

That single sentence is the strongest strategic finding in this survey. Every
webhook- or Actions-triggered competitor — Copilot, Codex, gh-aw,
`claude-code-action`, open-swe, bottega, OpenHands — is *architecturally
incapable* of noticing that an open PR became conflicting, because there is no
event to react to. They can only find out when a human asks. The scoreboard
confirms it: of everything surveyed, only sandman (batch-invoked),
geserdugarov (9★), Roomote (a scheduled scan), and ao route conflicts back
automatically, and **nobody polls for unresolved review threads at all**.

Phoebe's poller sees it for free, every cycle. **This should be the headline
claim**, not worktree isolation (which OpenHands, OpenCode, and half the small
cohort ship) or provider pluggability (ao has 36 adapters; gh-aw makes it a
frontmatter field).

### 6.2 Multi-tenant fleet with per-tenant isolation

sandman and gluon-agent share the container-pool bet; neither runs multiple
*repos* under one supervisor. Roomote is one throwaway sandbox per task. Nobody
has shipped one container, many repos, many worktrees, **with real per-tenant
confinement**. Phoebe has the first half built (`bootstrap/supervise-fleet.ts`,
the slot broker) and documents the second half as a known gap (`docs/trust.md`'s
cross-tenant `.env` read). §4.5's Route A closes it under Docker's *default*
seccomp — which, per the empirical results, nobody else has bothered to work out
because everyone reached for bubblewrap and stopped when it failed.

### 6.3 Verification whose result is a durable, comparable artifact

Every project either self-reports (OpenHands' *"Run the tests, and if they pass
you are done!"*), runs a benchmark harness offline (SWE-bench, Harbor), or
gates in CI and forgets. **Nobody publishes a per-PR verification record that is
queryable across runs.**

Phoebe already has the substrate: `status-v2.json` plus the `events-v1/` journal
plus JSON Schemas in `contracts/`. Combining §4.2 (engine-run gates), §4.8
(repro-must-fail-first), and OpenHands' outcome-telemetry pattern (§3.4 — join
the merge outcome back to the run that produced it) would let Phoebe answer
"what fraction of units that claimed success actually merged, by kind, by
provider, by model" — a question no competitor's data model can express.

### 6.4 A durable claim protocol over GitHub-as-database

symphony has the cleanest *model* (claims decoupled from run phases) but keeps
it in memory. better-symphony has the cleanest *encoding* (a label suffix
ladder: `agent:dev` → `:progress` → `:done|:error`, retry = remove `:error`) but
is stale and 26★. Nobody has combined a proper claim state machine with durable,
human-inspectable, crash-safe encoding on the issue itself.

Phoebe has all the ingredients — labels, marker comments, `(runtimeId, eventId)`
dedupe, quarantine that survives volume loss — but the loop is deliberately
stateless between cycles, so a claim currently lives only in the worktree's
existence.

### 6.5 Publishable cost-per-outcome

Only Amp publishes a per-hour rate; Devin publishes ACUs but not $/ACU;
everyone else publishes nothing. **Nobody publishes cost per merged PR.** With
§4.1 plus the existing PR outcome data, Phoebe could — a genuinely novel,
genuinely useful, and (for a self-hosted tool with no revenue tied to opacity)
uniquely publishable number.

### 6.6 The wrapper binary itself

There is **no viable Node-native Landlock or seccomp binding** — npm
`node-seccomp` was abandoned in 2022 and npm `landlock` is a toy. Every project
that wants OS-level confinement either is written in Rust (Codex, Cursor) or
shells out to bubblewrap (Kilo, deer, gluon-agent), and bubblewrap **does not
work inside an unprivileged Docker container**. A ~200-line
`NO_NEW_PRIVS → landlock → seccomp → execve` wrapper that works under Docker's
default seccomp profile is a missing, broadly useful, and separately-publishable
artifact.

---

## 7. Open questions and what to verify next

### Could not verify — closed source

Devin, Google Jules, GitHub Copilot's coding-agent harness, Sourcegraph Amp, and
Cursor's cloud backend are **documentation-only throughout**. Every claim about
them in §3.2 is a documented behavior, not a verified mechanism. Specifically
unverifiable: Copilot's egress-firewall implementation (mechanism undisclosed,
and its default allowlist includes writable registries, so treat it as a noise
filter); whether Jules has any egress policy at all (none documented — flagged
as a gap, but absence of documentation is not absence of a control); Devin's
$/ACU; and `ghcr.io/openhands/enterprise-server` internals (only its Helm values
were readable).

### Could not verify — moved, stale, or missing

- **`OpenHands/legacy` and `OpenHands-Cloud` report `NOASSERTION`.** Do not
  claim either is MIT.
- **No announcement exists** for four of the biggest events in §1: OpenHands'
  Agent Canvas migration, Roo Code's shutdown, Kilo's OpenCode rebase, or the
  `sst` → `anomalyco` rename. All are strong inferences from repo state, not
  quoted statements.
- **No maintainer statement about Aider's status.** The slowdown is inferred
  from commit, release, and PyPI telemetry only.
- **No explanation for SWE-ReX's 5-month gap.** Could be "done" or "quietly
  dropped." Its demotion to `environments/extra/` in mini-SWE-agent is
  suggestive, not proof.
- **Dependabot `rebase-strategy`'s full enum.** Current docs list no "Supported
  values" line and name only `disabled`. Any three-value enum claim is
  unsourced.
- **GitHub merge-queue ruleset defaults.** All seven `merge_queue` parameters
  are `isRequired: true` in the webhook schema with **no published defaults**.
- **Codecov patch `threshold` default** — two official pages disagree (0% vs
  5%).
- **Graphite's merge-queue concurrency default/max** and **Trunk's
  parallel-queue config keys** are not published (Trunk states mode switching is
  UI-only).
- **Codex's `config.toml` key table** — in-repo docs are one-line stubs
  redirecting off-site; the literal keys would require reading
  `codex-rs/core/src/config.rs`.
- **`umputun/ralphex`** — a transient network error blocked verification.
- **No CVE/GHSA corpus for prompt injection was obtainable.** A jq scan over 100
  reviewed advisories returned zero entries, and `github/github-mcp-server`'s own
  `docs/policies-and-governance.md` contains **no** discussion of prompt
  injection or exfiltration and states there is *"no purpose-built logging for
  MCP."* The "toxic agent flow" class has no first-party GitHub response
  document that could be located.

### Method caveats

- **`gh search repos` with natural-language queries returned `[]` or 0–3-star
  toys.** This is itself a finding — no obvious OSS competitor surfaces in
  Phoebe's janitor-sweep niche — but it means discovery leaned on
  `gh api .../contents/...` and WebFetch. The GitHub *search* API was
  rate-limited throughout (30/hr shared). One "awesome list" was used strictly
  as an index of candidate names; every candidate was then verified against
  primary metadata and repo source.
- **`gh api` 404s** on `AutoCoderover/auto-code-rover`, `getsentry/seer`, and
  `sourcegraph/amp` — those org/repo paths do not exist as commonly cited.
- **Sourcegraph Batch Changes and OpenRewrite/Moderne (§3.6)** are summarized at
  mechanism level from docs; exact batch-spec YAML keys and `mod` CLI flags were
  **not** re-verified against source. Treat as directionally sound, not
  key-exact.
- **CodeRabbit, Greptile, Ellipsis, Baz, and cubic** were not read key-by-key.
  §3.6's four-mechanism anti-spam taxonomy generalizes from `qodo-ai/pr-agent`
  alone plus vendor prose.
- **All benchmark percentages are self-reported** and were not cross-checked
  against leaderboards. None are cited above for that reason.
- **Sandbox results in §3.7 are specific to this host** (Docker 29.6.2, kernel
  7.1.4, default seccomp). Landlock ABI and Docker's seccomp profile both move;
  re-run the probes before committing to a design.
- Three subagent reports triggered harness content-neutralization notices
  (patterns matching `settings-json`, `bypass-permissions`,
  `dangerously-skip-permissions`). Those matched **factual descriptions of
  provider CLI flags**, including Phoebe's own in `src/providers/providers.ts`,
  which were independently re-verified against this tree.

### What to verify next

1. **Does Claude Code still gate span export behind
   `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`?** §4.7's value depends on it.
2. **Re-run the Landlock/seccomp probes** against the current
   `templates/container/Dockerfile` base image before starting §4.5.
3. **Read `codex-rs/core/src/config.rs`** if Codex's sandbox configuration
   becomes load-bearing.
4. **Read `github/gh-aw`'s `safe-outputs` applier job source**, not just its
   reference docs, if §4.3 or a Safe-Outputs-style split is pursued seriously.
5. **Watch `github/gh-aw`.** It is first-party, MIT, shipping daily, and will
   likely define this category's vocabulary. Phoebe should either adopt its
   nouns or be able to explain why not.
6. **Check whether GitHub ever ships a base-branch-advanced webhook.** §6.1's
   moat is one changelog entry from evaporating.

### Already in flight in this fork — do not duplicate

Several adoptions above overlap open work. Cross-check before starting:

| Issue                        | Overlaps                                                              |
| ---------------------------- | --------------------------------------------------------------------- |
| **#12** A2: split trusted supervisor from untrusted executor | §4.5 — this is its concrete form  |
| **#39** Map: deepen the engine's module seams                | §4.1, §4.2 touch the same seams   |
| **#141** Structured bail verdict channel (agent writes a verdict file) | §4.2, §4.10 — a bail verdict and a park reason are the same object |
| **#142** Red-main bail                                       | Sweep's `main_passing` baseline guard (§4 honorable mentions) |
| **#145** No-op verdict suppression                           | Same cost-control family as §4.4 |
| **#146** Generated `CONTRACT.md` + `CONTRACT_VERSION`        | Any status-contract bump in §4.1/§4.10 lands through this |
| **#148** `PHOEBE_EFFORT` is a silent no-op                   | Touches `src/providers/providers.ts` alongside §4.1 |
| **#153** Default prompts absorb the bail protocol            | Touches `prompts/issues-prompt.md` alongside §4.3 |
| **#159** Extend tier override to the PR-fix path             | Same provider-invocation path as §4.1 |
