// The work-kind contract (#303/#348/#349): one self-contained definition
// object per kind — name, prompt, eligibility, reporting, and the
// `fetch`/`select`/`run` triple — registered at boot and walked by the engine.
// After registration the engine cannot tell a built-in from a tenant-authored
// kind: `workOrder`, `workKinds` override blocks, `PHOEBE_<KIND>_*` env vars,
// quarantine, slots, deadlines, and the prompt-existence check all apply
// uniformly. Every shape in this file is judged against that sentence.
//
// Everything a kind can reach arrives on `ctx`. That is not a style choice but
// a loading constraint: tenant configs (and the kind modules they point at) are
// loaded from a container mount with no reachable `node_modules`, so kind code
// can never value-import engine helpers — type-only imports of this module's
// types (re-exported through the `phoebe-agent` package) are the whole surface
// a tenant author gets, and `satisfies WorkKindDefinition<G, U>` is how a
// tenant module types itself. `defineWorkKind` is a *value* and therefore an
// in-engine convenience for built-ins only.

import type { BranchRef, PrNumber, Sha } from "../branded.ts";
import type { PhoebeConfig } from "../config-schema.ts";
import type { Feature } from "../feature-branch.ts";
import type { CycleGitHubClient, GitHubClient } from "../github-client.ts";
import type { BlockerPrState, Issue } from "../orchestrator.ts";

/**
 * The one structural window the engine has into an otherwise opaque unit: the
 * GitHub object the timeout/quarantine write path escalates on. Optional by
 * design (docs/research/slack-responder-sketch.md): a unit without one still
 * gets in-memory timeout counting, but no GitHub escalation — a defined
 * degraded behavior the engine logs, not a crash. All five built-ins set it.
 */
export type WorkUnitGitHubTarget = { objectType: "issue" | "pr"; id: number };

/**
 * What every work unit must structurally satisfy. The payload beyond these two
 * fields is kind-defined and opaque to the engine.
 *
 * The `ref` contract: a non-empty single-line string, stable across cycles for
 * the same logical unit, unique within its kind. Every engine consumer —
 * quarantine, slot logs, idle reports — keys `(kind, ref)`. Built-ins use
 * `pr:123` / `issue:88` as convention; no grammar is mandated and nothing may
 * parse a ref.
 */
export type WorkUnitShape = {
  ref: string;
  github?: WorkUnitGitHubTarget;
};

/** One rule that turned units away this cycle, in the kind's own words. */
export type WorkKindSkip = {
  /**
   * A kind-owned free string, rendered verbatim in the idle report as
   * `"<count> <noun> skipped (<reason>)"`.
   */
  reason: string;
  count: number;
};

export type WorkKindSelection<U> = {
  /** The unit this kind would work, or null when none qualify. */
  unit: U | null;
  skipped: WorkKindSkip[];
  /**
   * Units the kind had to choose from. `0` ⇒ the kind reports nothing this
   * cycle; `> 0` with no pick ⇒ the engine synthesizes the one
   * engine-owned skip reason, `none-workable`.
   */
  total: number;
};

/**
 * The engine-owned shared stack facility (#348 Q6): the cycle-scoped
 * issue-body read-through cache and the blocker-state index. Kinds contribute
 * during `fetch` and read during `select`; the cross-kind body-derived blocker
 * merge stays engine-owned and runs after every fetch, so `blockerStates()` is
 * complete by select time whatever the gather order.
 */
export type CycleServices = {
  /**
   * The issue's body via the cycle cache — fetched at most once per cycle, and
   * `null` when it could not be read (the caller must drop that candidate).
   * Reads also feed the engine's body-derived blocker merge.
   */
  issueBody(issueNumber: number): string | null;
  /** Fetch-time contribution: the engine builds blocker states from these. */
  registerIssues(issues: readonly Issue[]): void;
  /** Select-time read of the merged blocker-state index. */
  blockerStates(): ReadonlyMap<number, BlockerPrState>;
  /**
   * The live feature this issue belongs to (#341), or `null` when it belongs to
   * none — no opted-in ancestor, a retired feature, or a failed read, which a
   * caller treats alike: an ordinary ticket bound for the default branch. The
   * parent chain is walked at most once per issue per cycle.
   */
  feature(issueNumber: number): Feature | null;
};

/**
 * The GitHub surface a kind sees: the cycle-scoped caching client
 * (`forCycle()` — memoized `openPrs`/`mergeInfo`, since ctx is per-cycle) plus
 * the one deliberately fresh read, `currentMergeInfo`, for the re-check after
 * an agent has run, where a memo taken before the run answers the wrong
 * question.
 */
export type WorkKindGitHub = CycleGitHubClient & Pick<GitHubClient, "currentMergeInfo">;

/**
 * Read-only views of the origin hub (the private clone): freshen it, read a
 * branch head, and ask how far a branch has fallen behind another. What a kind
 * needs for watermark snapshots and main-head comparisons; all mutating git
 * flows stay behind the `agent` helpers.
 */
export type WorkKindOrigin = {
  fetch(): void;
  branchHead(branch: string): Sha;
  /**
   * How many commits `origin/<upstream>` carries that `origin/<branch>` does
   * not — `0` once the branch is current with it. The feature-branch catch-up
   * (#341) asks this: a long-lived branch that has merely fallen behind the
   * default branch conflicts with nothing yet, so no mergeability read would
   * notice it drifting.
   */
  commitsBehind(branch: string, upstream: string): number;
};

/** The engine's clock, injected so kind time is testable and fake-able. */
export type WorkKindClock = {
  now(): Date;
  sleep(ms: number): Promise<void>;
};

/**
 * The per-cycle context every kind function receives — the *entire* API a kind
 * author has (#349). One object built fresh per cycle and per kind; `run`
 * receives the same surface widened to {@link WorkKindRunCtx} once a unit is
 * selected and its workspace prepared.
 *
 * `select` must be pure over `gathered` + the cycle services: it *can* reach
 * `ctx.github`, but must not — gather-all-then-select is what keeps a later
 * kind's view consistent with an earlier one's (the #290 hazard class).
 */
export type WorkKindCtx = {
  /** This kind's registered name. */
  kind: string;
  /** The full resolved config, compile-time readonly — trusted as the tenant. */
  config: Readonly<PhoebeConfig>;
  /**
   * Extra fields from this kind's `workKinds.custom.<name>` wrapper entry,
   * passed through unvalidated — the kind validates. `undefined` for built-ins
   * and inline/path-sugar declarations.
   */
  options: unknown;
  /** The engine's environment (read-only by convention). */
  env: Readonly<NodeJS.ProcessEnv>;
  github: WorkKindGitHub;
  origin: WorkKindOrigin;
  cycle: CycleServices;
  clock: WorkKindClock;
  /** Log with the uniform `[phoebe][<kind> <ref>]` prefix (ref once known). */
  log(message: string): void;
};

/**
 * The workspace `run` receives, keyed by the definition's declared `workspace`
 * field. The engine prepares and removes it; kinds never create workspaces
 * themselves. Both members carry a `dir` because an agent needs a cwd whatever
 * the mode — what differs is what is in it:
 *
 * - `worktree` — a git worktree of the default branch, off the tenant's
 *   private clone. Repo context and a branch to commit on.
 * - `scratch` — one empty directory, no clone and no git state (#358). What a
 *   kind that only needs somewhere to write files wants: drafts, a generated
 *   report, a fetch-and-transform pass. Nothing stops such a kind from reaching
 *   git through `ctx.agent`'s workflow helpers, which build their own
 *   branch-specific worktrees; the mode governs the workspace the *engine*
 *   prepares, not what the kind may do.
 *
 * Either mode is materialized the first time `dir` is read, so a kind that
 * builds its own worktrees (as all five built-ins do) pays nothing for a
 * workspace it never uses, and only a materialized one is removed afterwards.
 *
 * A discriminated union so a later mode can carry fields these two do not
 * without retyping the kinds already written — `readonly`, the read-only view
 * of the tenant clone, is the member the Slack-responder sketch named next.
 */
export type WorkspaceHandle = { mode: "worktree"; dir: string } | { mode: "scratch"; dir: string };

/** The declarable workspace modes — {@link WorkspaceHandle}'s discriminant. */
export type WorkspaceMode = WorkspaceHandle["mode"];

/**
 * What one agent-over-a-PR-branch pass produced, handed to
 * {@link AgentHelpers.prWorkflow}'s `onResult`. `push()` publishes the
 * worktree's commits to the PR branch — the one write the workflow shape owns.
 */
export type AgentWorkflowOutcome = {
  worktreeDir: string;
  branch: BranchRef;
  originShaBefore: Sha;
  originShaAfter: Sha;
  localCommitCount: number;
  push: () => void;
};

/**
 * The sanctioned agent-spawning machinery (#349 Q2): `run` is the contract —
 * provider ladder, prompt render, env allowlist, and the run deadline are
 * engine-fixed — and the two skeletons the built-ins share cross the boundary
 * as conveniences in the same namespace, so a prompt-only producer is a kind
 * whose `run` is one `issueWorkflow` call.
 *
 * The deadline covers the whole `run` (#359): each helper passes the outer
 * `ctx.signal` to the agent subprocess, so the process is killed when the
 * budget expires wherever in the `run` the call sits.
 */
export type AgentHelpers = {
  /**
   * Spawn one agent child: select the provider for this kind, render the
   * prompt (`promptFile` defaults to the definition's), build the allowlisted
   * env, and run inside `worktreeDir` (defaults to the prepared workspace).
   * `promptArgs` merge over the standard config-derived set.
   */
  run(opts?: {
    worktreeDir?: string;
    promptFile?: string;
    promptArgs?: Record<string, string>;
  }): Promise<void>;
  /**
   * The PR-fix skeleton (the three janitors' shared shape): snapshot origin,
   * prepare a worktree on the PR branch, install, optionally prime the tree,
   * run the agent, re-snapshot, then hand `onResult` the outcome. The worktree
   * is always removed. `primeBlockerMerges` merges the given blocker PRs and
   * then `baseBranch` into the tree before the agent, tolerating conflicts
   * (they are what the agent is there for). `baseBranch` defaults to the
   * default branch and should be the PR's own base — for a feature member
   * that is the feature branch, and merging the default branch there would
   * resolve a conflict GitHub never reported (#392).
   */
  prWorkflow(opts: {
    pr: { prNumber: PrNumber; headRefName: BranchRef };
    promptFile?: string;
    promptArgs: Record<string, string>;
    primeBlockerMerges?: readonly PrNumber[];
    baseBranch?: string;
    beforeAgent?: (worktreeDir: string) => void;
    onResult: (outcome: AgentWorkflowOutcome) => void | Promise<void>;
  }): Promise<void>;
  /**
   * The issue-producer skeleton: branch off the resolved base, run the prompt,
   * and — only when the agent left commits — credit the issue author, push,
   * and open (or follow up on) a PR, stacking it natively when blocked.
   * When `featureIssueNumber` is set the PR targets the feature branch instead
   * of the default branch.
   */
  issueWorkflow(opts: {
    issueNumber: number;
    issueTitle: string;
    worktreeBase: string;
    stacked: boolean;
    promptFile?: string;
    blockerIssueNumber?: number;
    blockerPrNumber?: PrNumber;
    featureIssueNumber?: number;
  }): Promise<void>;
  /**
   * The no-agent merge attempt: merge the given blocker PRs and then
   * `baseBranch` into `branch`, pushing on success. `"conflicted"` means
   * real conflicts remain in the tree (bring in an agent); `"failed"` means
   * the merge could not even start or finish.
   *
   * `baseBranch` defaults to the default branch, which is the base of every
   * PR the janitors saw before the feature arm (#341). A feature member is
   * based on the feature branch, and catching it up with the default branch
   * instead pushes commits its reviewer never asked for while leaving the
   * conflict GitHub reported in place (#392) — so pass the PR's own base.
   */
  cleanMerge(
    branch: BranchRef,
    blockerPrNumbers?: readonly PrNumber[],
    baseBranch?: string,
  ): "pushed" | "conflicted" | "failed";
};

/** {@link WorkKindCtx} widened for `run`, once the workspace exists. */
export type WorkKindRunCtx = WorkKindCtx & {
  workspace: WorkspaceHandle;
  agent: AgentHelpers;
  /**
   * Fires when the unit's wall-clock budget expires (#359). Cooperative kinds
   * poll `signal.aborted` or pass it to async operations to stop early; the
   * engine races the budget against `run` regardless, so the slot is released
   * and quarantine accounting runs even when a kind does not honour the signal.
   */
  signal: AbortSignal;
};

export type WorkKindReport<G, U> = {
  /** The idle-report noun for this tenant's units, e.g. `"failing-CI PR(s)"`. */
  noun: string;
  /** One line naming a unit, e.g. `"checks fix for PR #7 (<branch>)"`. */
  describe(unit: U): string;
  /**
   * The idle line for the engine-synthesized `none-workable` case — the kind
   * had units and selected none. Omitted ⇒
   * `"<total> <noun> but none workable this cycle."`.
   */
  idle?(gathered: G, total: number, ctx: WorkKindCtx): string;
};

/**
 * One work kind, whole. The generic parameters are the kind's private
 * vocabulary — `G` is whatever `fetch` gathers, `U` its unit payload — and the
 * registry stores definitions type-erased: the engine never knows `G`/`U`.
 *
 * The failure contract (adopted from docs/research/cycle-record-seam.md):
 * per-unit errors are absorbed inside the kind's `fetch` (warn, drop); a
 * thrown `fetch` propagates, kills the cycle, and the bootstrapper's restart
 * loop is the recovery — identically for custom kinds. `run` returns void;
 * throw = failure. All kind-specific consequences (push, failure comment,
 * watermark) stay inside the kind; the engine's interest is limited to unit
 * events, quarantine, and duration.
 */
export type WorkKindDefinition<G = unknown, U extends WorkUnitShape = WorkUnitShape> = {
  name: string;
  /** May a unit of this kind run under `--run-once`? */
  oneShotEligible: boolean;
  /**
   * The kind's prompt template path, resolved against the runtime root like
   * every prompt (absolute paths as-is). Built-ins default this from the
   * tenant's `promptFiles` keys — which are thereby *overrides* — and a custom
   * kind's value is the only source. Every scheduled kind's prompt is
   * boot-checked for existence.
   */
  promptFile: string;
  /** Which workspace the engine prepares for `run` (see {@link WorkspaceHandle}). */
  workspace: WorkspaceMode;
  /**
   * Definition-level agent defaults, sitting at the repo-defaults rung of the
   * resolution ladder: per-kind env → `workKinds` block → global env → these →
   * repo defaults.
   */
  model?: string;
  effort?: string;
  report: WorkKindReport<G, U>;
  fetch(ctx: WorkKindCtx): Promise<G>;
  select(gathered: G, ctx: WorkKindCtx): WorkKindSelection<U>;
  run(unit: U, ctx: WorkKindRunCtx): Promise<void>;
};

/**
 * A definition as the registry holds it: type-erased. `any` rather than
 * `unknown` because the erased functions must stay callable with the values
 * the registry round-trips through its `unknown` gathered slots.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWorkKindDefinition = WorkKindDefinition<any, any>;

/**
 * Identity typing helper for authoring definitions with inference — in-engine
 * only (it is a value; tenant modules use `satisfies WorkKindDefinition`).
 */
export function defineWorkKind<G, U extends WorkUnitShape>(
  definition: WorkKindDefinition<G, U>,
): WorkKindDefinition<G, U> {
  return definition;
}
