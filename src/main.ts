// Phoebe orchestration engine — an away-from-keyboard (AFK) worker loop.
//
// Picks ready-labelled issues off the configured repo one at a time and
// works each in a git worktree off the container's private clone, on its own
// branch, opening a PR to the default branch. The container is both
// orchestrator and execution environment; agent CLIs run as direct children
// with an allowlisted env. See docs/architecture.md for the full design.
//
// The engine is constructed, not imported: `createEngine` takes this tenant's
// resolved config, its environment and its collaborators and returns
// `{ runLoop }` closing over all of them. Nothing in this module reads `config`
// or `process.env` at import time, so one process (or one test file) can build
// several engines and vary what each is given.
//
// `runEngine(config, argv)` is the process-facing entry point src/cli.ts calls
// after loading the consumer's phoebe.config.ts. It is the only thing here that
// touches argv, `process.env` and the IPC channel; it turns them into the
// factory's inputs. Recognised argv flags:
//
//   (no flags)              # persistent poll loop
//   --run-once              # one unit of the first one-shot-eligible kind
//   --dry-run --run-once    # host-side selection preview
//
// Work-unit execution is refused outside the container marker
// (src/execution-gate.ts).

import { execFileSync, execSync } from "node:child_process";
import type { PhoebeConfig } from "./config-schema.ts";
import { selectProviderForKind } from "./provider-selection.ts";
import { detectAppCredentials, mintInstallationToken } from "./gh-app.ts";
import { asBranchRef, asPrNumber, type BranchRef, type PrNumber } from "./branded.ts";
import {
  createGitHubClient,
  type GitHubClient,
  type QuarantinedUnit,
  type UnitTarget,
} from "./github-client.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { buildShellCommandEnv } from "./shell-env.ts";
import { installDrainSignal, type DrainSignal } from "./drain.ts";
import {
  BrokerDisconnectedError,
  createCredentialClient,
  CredentialLeaseTimedOutError,
  CredentialRefreshBlockedError,
  type CredentialClient,
} from "./credential-client.ts";
import { createSlotClient, type SlotClient } from "./slot-client.ts";
import { RunTimeoutError, resolveRunTimeoutMs, runWithDeadline } from "./run-timeout.ts";
import {
  createEmitUnitEvent,
  STATUS_FILE,
  type EmitUnitEvent,
  type UnitRef,
} from "./unit-event.ts";
import {
  buildQuarantineComment,
  buildUnitTimeoutMarker,
  buildUnstickComment,
  decideAutoUnstick,
  decideTimeoutRecord,
  PHOEBE_QUARANTINE_LABEL,
  resolveMaxUnitTimeouts,
} from "./quarantine.ts";
import { join } from "node:path";
import {
  EXECUTION_REFUSED_MESSAGE,
  executionDecision,
  isInsideContainer,
} from "./execution-gate.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import { createOriginHub, ensureOriginClone, type OriginHub } from "./origin-hub.ts";
import { PROVIDERS } from "./providers/providers.ts";
import { resolveIssueCoAuthorTrailer } from "./co-author.ts";
import { runAgent } from "./providers/run-agent.ts";
import type { Provider } from "./providers/types.ts";
import {
  assertPromptFilesExist,
  buildDefaultPromptArgs,
  loadPromptTemplate as loadPromptTemplateFromRoot,
  renderPrompt,
} from "./prompt.ts";
import {
  buildInitialPrBody,
  followUpPrComment,
  issueBranch,
  stackedPrComment,
  RUN_ONCE_NOTHING_MESSAGE,
  validateWorkOrder,
  type StackedOn,
} from "./orchestrator.ts";
import {
  createWorkSource,
  type Clock,
  type GatheredCycle,
  type WorkSource,
} from "./cycle-work-source.ts";
import type {
  AgentHelpers,
  AgentWorkflowOutcome,
  WorkKindCtx,
  WorkKindRunCtx,
  WorkUnitGitHubTarget,
} from "./work-kinds/definition.ts";
import { buildRegistry, type WorkKindRegistry } from "./work-kinds/registry.ts";
import {
  NONE_WORKABLE,
  oneShotWorkKinds,
  selectFirstWorkUnit,
  type PickedWorkUnit,
  type WorkUnitSkip,
} from "./work-kinds/walk.ts";

// ---------------------------------------------------------------------------
// Credential arm selection
//
// "pat"  — operator supplied GH_TOKEN at startup; no minting attempted.
// "app"  — no GH_TOKEN at startup; engine mints an installation token before
//          each poll cycle so both its own gh calls and child agents can work.
//
// The arm is resolved from the startup snapshot to prevent a programmatically-
// set GH_TOKEN (the minted one) from flipping the arm back to "pat" on the
// next cycle. Logged at first spawn and on any flip so the implicit selector
// is visible to the operator.
// ---------------------------------------------------------------------------

type CredentialArm = "pat" | "app";

const DEFAULT_POLL_INTERVAL_MS = 300_000;

// Never let a gh/git child process block the persistent loop forever (rate-limit
// backoff, credential prompt, network partition). Configured toolchain commands
// (install/test) get a longer leash.
const CHILD_PROCESS_TIMEOUT_MS = 120_000;
const SHELL_COMMAND_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// The shapes the engine speaks in
// ---------------------------------------------------------------------------

// The observed outcome of an automatic (no-agent) merge attempt:
//   "pushed"     — merged cleanly and pushed; the PR is caught up.
//   "conflicted" — real merge conflicts in the tree; an agent must resolve them.
//   "failed"     — could not even start/finish the merge (e.g. worktree setup);
//                  no conflicts were observed.
type CleanMergeOutcome = "pushed" | "conflicted" | "failed";

// ---------------------------------------------------------------------------
// Helpers that hold no engine state
// ---------------------------------------------------------------------------

function gitInWorktree(
  worktreeDir: string,
  args: string[],
  opts?: { stdio?: "inherit" | "ignore" | "pipe" },
): string {
  return execFileSync("git", ["-C", worktreeDir, ...args], {
    encoding: "utf8",
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    ...(opts?.stdio ? { stdio: opts.stdio } : {}),
  }) as unknown as string;
}

/**
 * Run a configured toolchain command (a shell string) inside a worktree, under
 * the engine's own environment — the same one the agent children are built from.
 */
function runShellCommand(command: string, cwd: string, parentEnv: NodeJS.ProcessEnv): void {
  execSync(command, {
    cwd,
    env: buildShellCommandEnv(parentEnv),
    stdio: "inherit",
    timeout: SHELL_COMMAND_TIMEOUT_MS,
  });
}

/** Shell executor for prompt !`...` expansion — captures stdout. */
function promptShell(cwd: string, parentEnv: NodeJS.ProcessEnv): (command: string) => string {
  return (command) =>
    execSync(command, {
      cwd,
      env: buildShellCommandEnv(parentEnv),
      encoding: "utf8",
      timeout: SHELL_COMMAND_TIMEOUT_MS,
    });
}

/** Load a `promptFiles.*` template from the runtime root (process cwd). */
function loadPromptTemplate(relativePath: string): string {
  return loadPromptTemplateFromRoot(relativePath, process.cwd());
}

/** The observability identity of a picked unit: (kind, ref) (#73/#75/#348). */
function unitRefOf(picked: PickedWorkUnit): UnitRef {
  return { kind: picked.kind, id: picked.unit.ref };
}

/** How the kind itself names this unit — the definition owns the words. */
function describeUnit(picked: PickedWorkUnit): string {
  return picked.definition.report.describe(picked.unit);
}

// ---------------------------------------------------------------------------
// What an engine is built from
// ---------------------------------------------------------------------------

const defaultClock: Clock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

/** The flags and interval one run of the loop is shaped by. */
export type EngineRunOptions = {
  /** Work at most one unit of the first one-shot-eligible kind, then return. */
  runOnce: boolean;
  /** Select and report only: nothing executes and nothing is written to GitHub. */
  dryRun: boolean;
  /** How long an idle cycle waits before polling again. */
  pollIntervalMs: number;
};

export type EngineOptions = {
  /** This tenant's resolved config — passed in, never read from a module-level holder. */
  config: PhoebeConfig;
  /**
   * The assembled work-kind registry (#303): built-ins plus this tenant's
   * custom kinds. Defaults to built-ins only — the CLI path assembles the full
   * registry (custom kind modules load asynchronously) and passes it in.
   */
  registry?: WorkKindRegistry;
  /**
   * The engine's environment. Pass the live `process.env` in production: the
   * loop rewrites `GH_TOKEN` on it in place at each credential lease, and the
   * `gh` client and the agent children read it back out.
   */
  env: NodeJS.ProcessEnv;
  /** Defaults to a `gh`-backed client; a cycle test hands in a double instead. */
  github?: GitHubClient;
  /**
   * Defaults to the real `git` subprocess runner (src/git-model.ts). A cycle
   * test hands in a stub so the two failure watermarks are substitutable
   * without touching git paths directly. Ignored when `originHub` is given.
   */
  git?: GitRunner;
  /**
   * The origin hub for this tenant. Defaults to one built from `config` and
   * `git`. A caller that has already constructed the hub (e.g. to ensure the
   * clone before handing off) passes it here to avoid a second construction.
   */
  originHub?: OriginHub;
  /** Defaults to real time. */
  clock?: Clock;
  /** The SIGTERM drain: finish the unit in flight, start no new one. */
  drain: DrainSignal;
  /** The bootstrapper's concurrency broker (#59), or null when unbrokered. */
  slotClient: SlotClient | null;
  /** The bootstrapper's credential lease (#211/#205), or null when unbrokered. */
  credentialClient: CredentialClient | null;
  /** Per-unit observability (#73): the tagged log line and the status snapshot. */
  emitUnitEvent: EmitUnitEvent;
  /**
   * How this engine runs. Held here rather than passed to `runLoop` so a caller
   * has one mechanism to learn instead of two.
   */
  run: EngineRunOptions;
};

/** One constructed engine. */
export type Engine = {
  runLoop: () => Promise<void>;
};

/**
 * Build one engine: bind this tenant's config, environment and collaborators,
 * and return the loop that runs against them. Everything the loop reaches for
 * is resolved here, which is what makes a cycle testable: no argv, and no
 * environment but the `env` it is handed — which reaches the `gh` client, the
 * agent children and the toolchain shells alike. What it does still read from
 * the ambient process is the pair that locates the working tree: the container
 * marker, and `process.cwd()` (the host repo dir and the prompt root).
 */
export function createEngine(options: EngineOptions): Engine {
  const { config, env, drain, slotClient, credentialClient, emitUnitEvent } = options;
  const { runOnce, dryRun, pollIntervalMs } = options.run;
  const registry = options.registry ?? buildRegistry(config);
  const git = options.git ?? defaultGit;
  const clock = options.clock ?? defaultClock;
  // Every `gh` call the engine makes goes through this client
  // (src/github-client.ts): argv, the `-R <repoSlug>` pin, GraphQL pagination,
  // the merge-state retry and `gh`-error enrichment are all its business, not
  // the loop's. A caller that supplies its own replaces the whole GitHub side.
  const github = options.github ?? createGitHubClient({ config, env });

  const startupGhToken: string | undefined = env["GH_TOKEN"];

  function resolveArm(): CredentialArm {
    return startupGhToken ? "pat" : "app";
  }

  let lastLoggedArm: CredentialArm | null = null;

  function logArmIfChanged(arm: CredentialArm): void {
    if (arm !== lastLoggedArm) {
      console.log(`[phoebe] Credential arm: ${arm}.`);
      lastLoggedArm = arm;
    }
  }

  // Whole-unit wall-clock budget (#72): the agent phase — the async, hang-prone
  // step — runs under this deadline, so a hung unit releases its #59 slot within
  // a known ceiling instead of starving the fleet. Env (`PHOEBE_RUN_TIMEOUT_MS`)
  // overrides the config field.
  const runTimeoutMs = resolveRunTimeoutMs(env, config.runTimeoutMs);
  // Lease budget sent to the supervisor: run timeout plus ten minutes for the
  // install/push phases that follow the agent inside the same unit. Only the
  // child resolves this number — env-over-config precedence lives engine-side,
  // and a supervisor that computed it independently would duplicate and drift.
  const credentialBudgetMs = runTimeoutMs + 10 * 60 * 1000;

  const prBase = config.defaultBranch;

  const inContainer = isInsideContainer();
  const hub = options.originHub ?? createOriginHub(config, inContainer, git);

  // ---------------------------------------------------------------------------
  // Provider selection (multi-provider ready)
  // ---------------------------------------------------------------------------

  /**
   * Which provider CLI, model, and effort one unit of `kind` runs with. The
   * resolution ladder — per-kind env → per-kind config (`workKinds`) → global
   * env → definition defaults → repo defaults — is pure, in
   * provider-selection.ts (#300/#303); this wrapper only maps the resolved
   * name to the actual `Provider`.
   */
  function selectProvider(picked: PickedWorkUnit): {
    provider: Provider;
    model: string;
    effort: string | undefined;
  } {
    const { definition } = picked;
    const selection = selectProviderForKind({
      kind: picked.kind,
      env,
      config,
      definitionDefaults: {
        ...(definition.model !== undefined ? { model: definition.model } : {}),
        ...(definition.effort !== undefined ? { effort: definition.effort } : {}),
      },
    });
    return {
      provider: PROVIDERS[selection.provider],
      model: selection.model,
      effort: selection.effort,
    };
  }

  const workOrder = validateWorkOrder(config.workOrder, [...registry.keys()]);

  /**
   * Phoebe's own login, for the quarantine write path. There is deliberately
   * no placeholder to stand in for an unresolved login: `""` would be a login
   * like any other, and the login a deleted account does not have used to be
   * `""` too — so Phoebe's own timeout markers could read as foreign activity,
   * or a ghost's comment as Phoebe's. The lookups this covers are rare, so
   * paying for one is cheaper than carrying a value that can lie.
   */
  function resolvePhoebeLogin(): string {
    return github.resolveLogin(env["PHOEBE_GH_LOGIN"]);
  }

  // --- Poison-unit quarantine write path (#75) ---------------------------------
  // The read/skip half ships in orchestrator.ts (it filters `phoebe:quarantined`
  // out of selection). This is the missing write half: on a whole-unit timeout,
  // count consecutive timeouts on the unit itself (a GitHub marker) and, at K,
  // apply the label + escalation comment so the poisonous unit stops being
  // re-picked. Kept thin over the GitHub client; the count/threshold policy is
  // pure in quarantine.ts (`decideTimeoutRecord`).

  // Timeout counts for units with no GitHub escalation surface (no `github`
  // target on the unit): counted in memory, keyed `(kind, ref)`, so the
  // degraded path still notices a repeat offender within this process's life.
  const inMemoryTimeoutCounts = new Map<string, number>();

  /**
   * Record one whole-unit timeout toward the poison-unit quarantine (#75): read the
   * latest timeout marker on the unit, post the incremented count, and at K apply
   * `phoebe:quarantined` + the escalation comment so selection starts skipping it.
   * Best-effort — a GitHub write failure here is logged and swallowed so it can
   * never take the daemon down (the timeout itself is already recorded).
   *
   * The write target is the unit's structural `github` field (#352): a unit
   * without one gets in-memory counting and a logged no-escalation-surface
   * degraded behavior instead of a crash.
   */
  function recordUnitTimeout(picked: PickedWorkUnit, emit: EmitUnitEvent): void {
    const ref = unitRefOf(picked);
    const ghTarget: WorkUnitGitHubTarget | undefined = picked.unit.github;
    if (!ghTarget) {
      const key = `${ref.kind} ${ref.id}`;
      const count = (inMemoryTimeoutCounts.get(key) ?? 0) + 1;
      inMemoryTimeoutCounts.set(key, count);
      console.warn(
        `[phoebe] ${ref.kind} ${ref.id} timed out ${count}× — the unit carries no GitHub ` +
          `target, so there is no escalation surface; counting in memory only.`,
      );
      return;
    }
    const target: UnitTarget = ghTarget;
    try {
      const login = resolvePhoebeLogin();
      const k = resolveMaxUnitTimeouts(env, config.maxUnitTimeouts);
      const inputs =
        target.objectType === "issue"
          ? github.issueTimeoutInputs(target.id)
          : github.prTimeoutInputs(asPrNumber(target.id));
      const { count, quarantine } = decideTimeoutRecord({
        comments: inputs.comments,
        phoebeLogin: login,
        extraActivityAt: inputs.extraActivityAt,
        k,
      });
      github.postUnitComment(target, buildUnitTimeoutMarker(count));
      if (quarantine) {
        github.addQuarantineLabel(target);
        github.postUnitComment(
          target,
          buildQuarantineComment({
            kind: ref.kind,
            id: target.id,
            k: count,
            baseline: inputs.baseline,
          }),
        );
        emit({
          unit: ref,
          event: "quarantined",
          detail: `timed out ${count}× — labelled ${PHOEBE_QUARANTINE_LABEL}`,
        });
      }
    } catch (error) {
      console.error(
        `[phoebe] Could not record timeout toward quarantine for ${ref.kind} ${ref.id} — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- Auto-un-stick sweep (#153) ----------------------------------------------
  // The quarantine's second exit — the one the escalation comment promises. Once
  // per cycle, look at every open unit still carrying `phoebe:quarantined`, compare
  // its current content fingerprint against the baseline recorded in that comment,
  // and drop the label when the content has advanced (a push on a PR, a body edit
  // on an issue). Both list queries return comment bodies, so the whole sweep is
  // two `gh` calls per cycle and no per-unit fetch. The decision itself is pure, in
  // quarantine.ts (`decideAutoUnstick`).

  /** How a quarantined unit is named in the sweep's log lines. */
  function describeUnitTarget(target: UnitTarget): string {
    return `${target.objectType === "issue" ? "issue" : "PR"} #${target.id}`;
  }

  /**
   * Why the sweep is running. It decides one thing — which quarantined units are
   * cleared — and the two strings that say so. `content-advanced` is the exit the
   * escalation comment promises; `tenant-disabled` is the blanket clear a disabled
   * tenant gets (#202), because a disabled tenant generates no timeouts, so a
   * label still on a unit is a carry-over from before it was disabled and a
   * re-enabled tenant should start clean rather than hit an immediate skip.
   */
  type UnstickReason = "content-advanced" | "tenant-disabled";

  const UNSTICK_WORDING: Record<UnstickReason, { sweepName: string; because: string }> = {
    "content-advanced": {
      sweepName: "auto-un-stick",
      because: "its content advanced past the quarantine baseline.",
    },
    "tenant-disabled": {
      sweepName: "disabled-tenant",
      because: "tenant is disabled; cleared so it starts fresh when re-enabled.",
    },
  };

  /**
   * Clear the quarantine label from every unit `reason` says has earned it — the
   * ones whose content advanced past their recorded baseline, or all of them when
   * the tenant is disabled. Best-effort, like the write path: one unit's failure
   * is logged and the rest of the sweep continues, and a failure of the whole
   * sweep never stops the cycle — the worst case is a unit staying quarantined a
   * cycle longer, which a human can still fix by hand.
   */
  function sweepQuarantine(reason: UnstickReason): void {
    const { sweepName, because } = UNSTICK_WORDING[reason];
    let quarantined: QuarantinedUnit[];
    try {
      quarantined = [...github.listQuarantinedIssues(), ...github.listQuarantinedPrs()];
    } catch (error) {
      console.error(
        `[phoebe] Could not list quarantined units for the ${sweepName} sweep — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const unit of quarantined) {
      if (
        reason === "content-advanced" &&
        !decideAutoUnstick({ comments: unit.comments, currentBaseline: unit.currentBaseline })
      ) {
        continue;
      }
      const label = describeUnitTarget(unit.target);
      try {
        // Label first: the comment is the audit trail, but the label is what
        // actually re-arms the unit, and a half-applied un-stick should err toward
        // the unit being workable again rather than silently stuck.
        github.removeQuarantineLabel(unit.target);
        github.postUnitComment(unit.target, buildUnstickComment());
        console.log(`[phoebe] Un-quarantined ${label} — ${because}`);
      } catch (error) {
        console.error(
          `[phoebe] Could not un-quarantine ${label} — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * The `Co-authored-by:` trailer crediting `issueNumber`'s author (#198), or
   * null when there is nobody to credit or the lookups fail. A deleted author
   * reads as `null`; the user lookup supplies the numeric id the noreply address
   * needs.
   */
  function issueCoAuthorTrailer(issueNumber: number): string | null {
    return resolveIssueCoAuthorTrailer(issueNumber, {
      issueAuthorLogin: (n) => github.issueAuthorLogin(n),
      lookupUser: (login) => github.lookupUser(login),
    });
  }

  /**
   * Stamp the unit's fresh commits with the issue author's co-author trailer
   * before they are pushed. Best-effort by design: whatever happens here, the
   * commits the agent made are pushed as they stand.
   */
  function stampIssueAuthorCredit(opts: {
    issueNumber: number;
    worktreeDir: string;
    baseRef: string;
  }): void {
    const trailer = issueCoAuthorTrailer(opts.issueNumber);
    if (trailer === null) {
      console.log(`[phoebe] No co-author credit for #${opts.issueNumber} (no creditable author).`);
      return;
    }
    const outcome = hub.appendTrailerToCommits({
      worktreeDir: opts.worktreeDir,
      baseRef: opts.baseRef,
      trailer,
    });
    const detail = {
      rewritten: `added "${trailer}"`,
      nothing: "no commits to credit",
      "skipped-merges": "range holds a merge commit; commits left as the agent made them",
      failed: "rewrite failed and was aborted; commits left as the agent made them",
    }[outcome];
    console.log(`[phoebe] Co-author trailer for #${opts.issueNumber}: ${detail}.`);
  }

  // ---------------------------------------------------------------------------
  // Work-unit execution
  // ---------------------------------------------------------------------------

  function prepareWorktree(opts: { branch: BranchRef; baseRef?: string }): string {
    const worktreeDir = hub.worktreeDirFor(opts.branch);
    hub.removeWorktree(worktreeDir);
    if (opts.baseRef) {
      hub.addWorktreeForNew({ worktreeDir, branch: opts.branch, baseRef: opts.baseRef });
    } else {
      hub.addWorktreeForExisting({ worktreeDir, branch: opts.branch });
    }
    return worktreeDir;
  }

  /**
   * The one place an agent child is actually spawned: select the provider for
   * `opts.kind`, render the prompt, build the allowlisted env, and run the
   * agent inside `opts.worktreeDir` under the #72 run deadline. Every work
   * kind's runner funnels through here.
   */
  async function runAgentInWorktree(opts: {
    picked: PickedWorkUnit;
    worktreeDir: string;
    promptFile: string;
    promptArgs: Record<string, string>;
  }): Promise<void> {
    const { provider, model, effort } = selectProvider(opts.picked);
    // Caller-supplied per-callsite args (ISSUE_NUMBER, PR_NUMBER, …) override
    // the standard config-derived set by key.
    const prompt = renderPrompt(
      loadPromptTemplate(opts.promptFile),
      { ...buildDefaultPromptArgs(config), ...opts.promptArgs },
      promptShell(opts.worktreeDir, env),
    );
    const agentEnv = buildAgentEnv({
      parentEnv: env,
      provider: provider.name,
      providerEnv: config.providerEnv,
    });
    // Bound the *agent phase* by the run budget (#72) — the one phase where a hang
    // is abortable (the agent respects the `AbortSignal`); install/test run via
    // `execSync` outside this deadline. On expiry the deadline aborts the signal,
    // `runAgent` kills the child, and a `RunTimeoutError` propagates — caught at
    // the unit boundary (the daemon logs it, releases the #59 slot in `finally`,
    // and continues; #75 counts it toward quarantine).
    const { exitCode } = await runWithDeadline({
      ms: runTimeoutMs,
      work: (signal) =>
        runAgent({
          provider,
          model,
          effort,
          prompt,
          cwd: opts.worktreeDir,
          env: agentEnv,
          signal,
          tenant: config.repoSlug,
        }),
    });
    if (exitCode !== 0) {
      console.log(`[phoebe] Agent exited with code ${exitCode}.`);
    }
  }

  function tryCleanMerge(
    branch: BranchRef,
    mergedBlockerPrNumbers: readonly PrNumber[] = [],
  ): CleanMergeOutcome {
    let worktreeDir: string;
    try {
      worktreeDir = prepareWorktree({ branch });
    } catch {
      return "failed";
    }

    try {
      for (const blockerPrNumber of mergedBlockerPrNumbers) {
        gitInWorktree(worktreeDir, ["fetch", "origin", `pull/${blockerPrNumber}/head`], {
          stdio: "inherit",
        });
        gitInWorktree(worktreeDir, ["merge", "FETCH_HEAD"], { stdio: "pipe" });
      }
      gitInWorktree(worktreeDir, ["fetch", "origin", config.defaultBranch], { stdio: "inherit" });
      gitInWorktree(worktreeDir, ["merge", `origin/${config.defaultBranch}`], { stdio: "pipe" });
      hub.pushBranch(worktreeDir, branch);
      hub.removeWorktree(worktreeDir);
      return "pushed";
    } catch {
      try {
        const unmerged = gitInWorktree(worktreeDir, ["diff", "--name-only", "--diff-filter=U"]);
        if (unmerged.trim()) {
          gitInWorktree(worktreeDir, ["merge", "--abort"], { stdio: "ignore" });
          hub.removeWorktree(worktreeDir);
          return "conflicted";
        }
      } catch {
        // Fall through to failed.
      }
      try {
        gitInWorktree(worktreeDir, ["merge", "--abort"], { stdio: "ignore" });
      } catch {
        // Best-effort.
      }
      hub.removeWorktree(worktreeDir);
      return "failed";
    }
  }

  /** Blocker-first merge attempt, mirroring `cmd && … || true` hook semantics. */
  function attemptBlockerFirstMerges(
    worktreeDir: string,
    mergedBlockerPrNumbers: readonly PrNumber[],
  ): void {
    try {
      for (const n of mergedBlockerPrNumbers) {
        gitInWorktree(worktreeDir, ["fetch", "origin", `pull/${n}/head`], { stdio: "inherit" });
        gitInWorktree(worktreeDir, ["merge", "FETCH_HEAD"], { stdio: "pipe" });
      }
      gitInWorktree(worktreeDir, ["fetch", "origin", config.defaultBranch], { stdio: "inherit" });
      gitInWorktree(worktreeDir, ["merge", `origin/${config.defaultBranch}`], { stdio: "pipe" });
    } catch {
      // Conflicts stay in the tree for the agent to resolve.
    }
  }

  /**
   * The shared skeleton behind every PR-fix agent (`agent.prWorkflow`):
   * snapshot origin, prepare a worktree on the PR branch, install, optionally
   * prime the tree, run the agent, then re-snapshot origin and count the
   * host-side commits. Only `onResult` differs per work kind (push vs. failure
   * comment vs. watermark); the worktree is always removed.
   */
  async function runAgentWorkflow(opts: {
    picked: PickedWorkUnit;
    pr: { prNumber: PrNumber; headRefName: BranchRef };
    promptFile: string;
    promptArgs: Record<string, string>;
    primeBlockerMerges?: readonly PrNumber[];
    beforeAgent?: (worktreeDir: string) => void;
    onResult: (outcome: AgentWorkflowOutcome) => void | Promise<void>;
  }): Promise<void> {
    const branch = opts.pr.headRefName;

    hub.fetch();
    const originShaBefore = hub.branchHead(branch);

    const worktreeDir = prepareWorktree({ branch });
    try {
      runShellCommand(config.installCommand, worktreeDir, env);
      // Presence, not length: an empty list still primes the tree with the
      // default-branch merge (reproducing the conflict for the agent to solve).
      if (opts.primeBlockerMerges !== undefined) {
        attemptBlockerFirstMerges(worktreeDir, opts.primeBlockerMerges);
      }
      opts.beforeAgent?.(worktreeDir);

      await runAgentInWorktree({
        picked: opts.picked,
        worktreeDir,
        promptFile: opts.promptFile,
        promptArgs: opts.promptArgs,
      });

      hub.fetch();
      const originShaAfter = hub.branchHead(branch);
      const localCommitCount = hub.commitCount(worktreeDir, `origin/${branch}..HEAD`);

      await opts.onResult({
        worktreeDir,
        branch,
        originShaBefore,
        originShaAfter,
        localCommitCount,
        push: () => hub.pushBranch(worktreeDir, branch),
      });
    } finally {
      hub.removeWorktree(worktreeDir);
    }
  }

  /**
   * Put an issue's PR into its blocker PR's native GitHub stack (#311), so
   * merge ordering and post-merge rebase/retarget are GitHub's job. When the
   * PR cannot be stacked — the Stacks API is a public preview and may be
   * absent, or the blocker is not the top of its stack — fall back to the
   * pre-native flow: post the ⛓️ do-not-merge banner (once; follow-up pushes
   * find it in the comments) and retarget the PR onto the default branch.
   * Banner before retarget: if the retarget throws, a PR still targeting the
   * blocker branch with a warning beats one silently mis-based.
   */
  function ensureNativeStack(opts: {
    issueNumber: number;
    existingPr: PrNumber | null;
    stackedOn: StackedOn;
  }): void {
    const { blockerIssueNumber, blockerPrNumber } = opts.stackedOn;
    const prNumber = opts.existingPr ?? github.findIssuePr(opts.issueNumber);
    if (prNumber === null) {
      console.log(`[phoebe] No open PR found for #${opts.issueNumber} — skipping stack setup.`);
      return;
    }
    const outcome = github.stackPrOnto(prNumber, blockerPrNumber);
    if (outcome.stacked) {
      console.log(
        `[phoebe] PR #${prNumber} stacked on PR #${blockerPrNumber} (stack #${outcome.stackNumber}).`,
      );
      return;
    }
    console.log(
      `[phoebe] Native PR stacking unavailable (${outcome.reason}) — using the do-not-merge banner.`,
    );
    const banner = stackedPrComment(blockerIssueNumber, blockerPrNumber);
    if (!github.prCommentBodies(prNumber).includes(banner)) {
      github.postPrComment(prNumber, banner);
    }
    github.retargetPr(prNumber, prBase);
  }

  /**
   * Work a single issue-shaped ticket: branch off the resolved base, run the
   * given prompt, and — only when the agent left commits — push and open (or
   * update) a PR. Shared by the `issues` and `research` kinds; the two differ
   * only in `promptFile`. A research ticket that resolves as an issue-level
   * artifact (comment + close + map update, done by the prompt) leaves no
   * commits, so no PR is opened; one that produces a committed doc does.
   */
  async function runOneIssue(opts: {
    picked: PickedWorkUnit;
    issueNumber: number;
    issueTitle: string;
    worktreeBase: string;
    stacked: boolean;
    promptFile: string;
    blockerIssueNumber?: number;
    blockerPrNumber?: PrNumber;
  }): Promise<void> {
    const { issueNumber, issueTitle, worktreeBase, stacked, promptFile } = opts;
    const { blockerIssueNumber, blockerPrNumber } = opts;
    const agentBranch = issueBranch(issueNumber);
    const stackedOn: StackedOn | null =
      stacked && blockerIssueNumber !== undefined && blockerPrNumber !== undefined
        ? { blockerIssueNumber, blockerPrNumber }
        : null;
    // A stacked PR targets the layer beneath it — the blocker's branch — which
    // is native stacking's shape; `ensureNativeStack` retargets it back onto
    // the default branch when the Stacks API turns out to be unavailable. The
    // agent's own `gh pr create` (issues prompt, step 7) uses the same base.
    const intendedPrBase = stackedOn ? issueBranch(stackedOn.blockerIssueNumber) : prBase;

    hub.fetch();
    const worktreeDir = prepareWorktree({ branch: agentBranch, baseRef: worktreeBase });
    try {
      runShellCommand(config.installCommand, worktreeDir, env);

      await runAgentInWorktree({
        picked: opts.picked,
        worktreeDir,
        promptFile,
        promptArgs: { ISSUE_NUMBER: String(issueNumber), PR_BASE: intendedPrBase },
      });

      const newCommitCount = hub.commitCount(worktreeDir, `${worktreeBase}..HEAD`);

      if (newCommitCount > 0) {
        if (config.creditIssueAuthor) {
          stampIssueAuthorCredit({ issueNumber, worktreeDir, baseRef: worktreeBase });
        }
        hub.pushBranchWithLease(worktreeDir, agentBranch);
        const existingPr = github.findIssuePr(issueNumber);
        if (existingPr === null) {
          const prTitle = `Phoebe: ${issueTitle} (#${issueNumber})`;
          const prBody = buildInitialPrBody({
            issueNumber,
            commitCount: newCommitCount,
            ...(stackedOn ? { stacked: stackedOn } : {}),
          });
          github.createPr({
            head: agentBranch,
            base: intendedPrBase,
            title: prTitle,
            body: prBody,
          });
        } else {
          console.log(
            `[phoebe] PR #${existingPr} already exists for ${agentBranch} — posting follow-up note.`,
          );
          github.postPrComment(existingPr, followUpPrComment(issueNumber, newCommitCount));
        }
        if (stackedOn) {
          ensureNativeStack({ issueNumber, existingPr, stackedOn });
        }
      } else {
        console.log("[phoebe] No commits — skipping PR creation.");
      }
    } finally {
      hub.removeWorktree(worktreeDir);
    }
  }

  // ---------------------------------------------------------------------------
  // The run-ctx machinery: workspace + agent helpers for one picked unit
  // ---------------------------------------------------------------------------

  /**
   * The sanctioned agent machinery, scoped to one picked unit (#349): the
   * low-level spawn (`run`), the two shared skeletons, and the no-agent clean
   * merge. Prompt files default to the definition's own.
   */
  function createAgentHelpers(picked: PickedWorkUnit, workspaceDir: string): AgentHelpers {
    const defaultPromptFile = picked.definition.promptFile;
    return {
      run: (opts = {}) =>
        runAgentInWorktree({
          picked,
          worktreeDir: opts.worktreeDir ?? workspaceDir,
          promptFile: opts.promptFile ?? defaultPromptFile,
          promptArgs: opts.promptArgs ?? {},
        }),
      prWorkflow: (opts) =>
        runAgentWorkflow({
          picked,
          pr: opts.pr,
          promptFile: opts.promptFile ?? defaultPromptFile,
          promptArgs: opts.promptArgs,
          ...(opts.primeBlockerMerges !== undefined
            ? { primeBlockerMerges: opts.primeBlockerMerges }
            : {}),
          ...(opts.beforeAgent !== undefined ? { beforeAgent: opts.beforeAgent } : {}),
          onResult: opts.onResult,
        }),
      issueWorkflow: (opts) =>
        runOneIssue({
          picked,
          issueNumber: opts.issueNumber,
          issueTitle: opts.issueTitle,
          worktreeBase: opts.worktreeBase,
          stacked: opts.stacked,
          promptFile: opts.promptFile ?? defaultPromptFile,
          ...(opts.blockerIssueNumber !== undefined
            ? { blockerIssueNumber: opts.blockerIssueNumber }
            : {}),
          ...(opts.blockerPrNumber !== undefined ? { blockerPrNumber: opts.blockerPrNumber } : {}),
        }),
      cleanMerge: (branch, blockerPrNumbers = []) => tryCleanMerge(branch, blockerPrNumbers),
    };
  }

  /**
   * Execute one picked unit through its definition's `run`: prepare the
   * declared workspace (a scratch worktree off the default branch — the
   * default cwd for a bare `agent.run`; the skeletons make their own
   * branch-specific worktrees), widen the cycle ctx with the workspace and the
   * agent helpers, and hand over. The workspace is always removed.
   */
  async function runPickedUnit(picked: PickedWorkUnit, ctx: WorkKindCtx): Promise<void> {
    const workspaceBranch = asBranchRef(`${config.branchPrefix}workspace`);
    hub.fetch();
    const workspaceDir = prepareWorktree({
      branch: workspaceBranch,
      baseRef: `origin/${config.defaultBranch}`,
    });
    try {
      const runCtx: WorkKindRunCtx = {
        ...ctx,
        log: (message) => console.log(`[phoebe][${picked.kind} ${picked.unit.ref}] ${message}`),
        workspace: { mode: "worktree", dir: workspaceDir },
        agent: createAgentHelpers(picked, workspaceDir),
      };
      await picked.definition.run(picked.unit, runCtx);
    } finally {
      hub.removeWorktree(workspaceDir);
    }
  }

  const workSource: WorkSource = createWorkSource({
    github,
    originHub: hub,
    clock,
    env,
    config,
    registry,
  });

  /** One line of the idle report, rendered from one entry of the selection's record. */
  function idleSkipLine(skip: WorkUnitSkip, cycle: GatheredCycle): string {
    const registered = registry.get(skip.kind);
    const report = registered?.definition.report;
    const noun = report?.noun ?? skip.kind;
    if (skip.reason === NONE_WORKABLE) {
      return (
        report?.idle?.(cycle.record.gathered.get(skip.kind), skip.count, cycle.ctxFor(skip.kind)) ??
        `${skip.count} ${noun} but none workable this cycle.`
      );
    }
    // Kind-owned free-string reasons render verbatim (#348 Q5).
    return `${skip.count} ${noun} skipped (${skip.reason}).`;
  }

  /**
   * Explain an idle cycle from the record the selection walk produced, so the
   * report can only ever describe the walk the loop actually made. It stops at
   * the first kind that had units and could work none of them: that kind is why
   * this cycle is idle, and the kinds behind it in `workOrder` would not have run
   * anyway.
   */
  function logIdleCycle(cycle: GatheredCycle, skipped: readonly WorkUnitSkip[]): void {
    for (const skip of skipped) {
      console.log(`[phoebe] ${idleSkipLine(skip, cycle)}`);
      if (skip.reason === NONE_WORKABLE) {
        return;
      }
    }
    console.log("[phoebe] No work this cycle — idle.");
  }

  /**
   * Drive this engine until it exits: the persistent poll loop, or one unit under
   * `runOnce`. Takes no arguments — the run options, the collaborators and the
   * tenant's config are all closed over.
   */
  async function runLoop(): Promise<void> {
    while (true) {
      if (drain.requested) {
        console.log("[phoebe] Drain requested — starting no new work unit; exiting 0.");
        break;
      }

      // Credential lease — call site 1: top of each poll, before discovery (#211).
      // Without this the idle path dies quietly after an hour: a tenant that cannot
      // list issues or PRs finds no work and simply looks idle. A null client means
      // standalone or PAT arm — proceed with the existing GH_TOKEN unchanged.
      const arm = resolveArm();
      logArmIfChanged(arm);

      // A non-null lease answer is the supervisor handing over the current
      // credential — a rotated PAT re-read from the tenant's `.env` (#205) or a
      // minted installation token. A null answer means "nothing to give: keep
      // what you have" — for an App-arm engine with no supervisor-side mint
      // (solo under boot), fall through to minting inline below.
      let leasedToken: string | null = null;
      if (credentialClient) {
        try {
          leasedToken = await credentialClient.requestLease(credentialBudgetMs);
          if (leasedToken !== null) env["GH_TOKEN"] = leasedToken;
        } catch (error) {
          if (error instanceof BrokerDisconnectedError) {
            console.error(`[phoebe] ${error.message} — stopping this engine.`);
            break;
          }
          if (error instanceof CredentialRefreshBlockedError) {
            console.warn("[phoebe] Credential refresh unavailable — skipping work this cycle.");
            await drain.wait(pollIntervalMs);
            continue;
          }
          if (error instanceof CredentialLeaseTimedOutError) {
            console.warn("[phoebe] Credential lease timed out — skipping work this cycle.");
            await drain.wait(pollIntervalMs);
            continue;
          }
          throw error;
        }
      }
      if (leasedToken === null && arm === "app" && !dryRun) {
        const creds = detectAppCredentials(env);
        if (!creds) {
          console.error("[phoebe] App mode active but GH_APP_ID or GH_APP_PRIVATE_KEY is missing.");
          if (runOnce) break;
          await drain.wait(pollIntervalMs);
          continue;
        }
        const mintResult = await mintInstallationToken(config.repoSlug, creds);
        if (!mintResult.ok) {
          const statusLabel = mintResult.status !== null ? ` HTTP ${mintResult.status}` : "";
          console.error(`[phoebe] App mode mint failed${statusLabel}: ${mintResult.reason}`);
          if (runOnce) break;
          await drain.wait(pollIntervalMs);
          continue;
        }
        // Inject the minted token as GH_TOKEN so all gh calls this cycle use it,
        // and set PHOEBE_GH_LOGIN so resolving Phoebe's login does not have to
        // shell out.
        // Bot git identity is applied as a fallback: existing values win. That is
        // what puts it under the rest of the ladder (#199) — by the time the
        // engine runs, a declared `gitIdentity` and the deployment's env have
        // already been resolved into these vars by `phoebe boot`.
        env["GH_TOKEN"] = mintResult.token;
        env["PHOEBE_GH_LOGIN"] = mintResult.botLogin;
        if (!env["GIT_AUTHOR_NAME"]) {
          env["GIT_AUTHOR_NAME"] = mintResult.botName;
          env["GIT_COMMITTER_NAME"] = mintResult.botName;
        }
        if (!env["GIT_AUTHOR_EMAIL"]) {
          env["GIT_AUTHOR_EMAIL"] = mintResult.botEmail;
          env["GIT_COMMITTER_EMAIL"] = mintResult.botEmail;
        }
      }

      // Disabled short-circuit (#202): if the tenant declares `disabled: true`,
      // start no new work this cycle. Any run already in flight finished before
      // looping back here, satisfying the "drain, don't cancel" contract. Clear
      // any lingering quarantine state so a re-enabled tenant starts clean.
      if (config.disabled) {
        if (!dryRun) {
          sweepQuarantine("tenant-disabled");
        }
        if (runOnce) {
          console.log(
            "[phoebe] Tenant is disabled — no work will be started (`disabled: true` in phoebe.config.ts).",
          );
          break;
        }
        console.log(
          "[phoebe] Tenant is disabled — no new work will be started this cycle. " +
            "Remove `disabled: true` from phoebe.config.ts to re-enable.",
        );
        await drain.wait(pollIntervalMs);
        continue;
      }

      // Auto-un-stick before selecting (#153): a unit whose content advanced since
      // it was quarantined loses the label here, so it is eligible in *this*
      // cycle's fetch rather than the next one. Skipped under `--dry-run`, which
      // must not write to GitHub.
      if (!dryRun) {
        sweepQuarantine("content-advanced");
      }
      const fetchKinds = runOnce ? oneShotWorkKinds(workOrder, registry) : workOrder;
      const cycle = await workSource.gatherCycle(fetchKinds);
      const { unit: picked, skipped } = selectFirstWorkUnit({
        registry,
        kinds: cycle.record.kindsGathered,
        gathered: cycle.record.gathered,
        ctxFor: cycle.ctxFor,
      });

      if (!picked) {
        if (runOnce) {
          console.log(RUN_ONCE_NOTHING_MESSAGE);
        } else {
          logIdleCycle(cycle, skipped);
        }
        if (runOnce || dryRun) break;
        // Interruptible idle poll — a SIGTERM mid-sleep wakes it, the next
        // iteration's drain check breaks, and shutdown does not wait a full cycle.
        await drain.wait(pollIntervalMs);
        continue;
      }

      // A drain that arrived during the fetch/selection above must not let this
      // freshly-picked unit start — "start no new one". The in-flight unit (if any)
      // already finished before we looped back here, so exit now.
      if (drain.requested) {
        console.log("[phoebe] Drain requested before starting the next unit — exiting 0.");
        break;
      }

      const decision = executionDecision({ dryRun, inContainer });
      if (decision === "dry-run") {
        console.log(`[phoebe] Would execute: ${describeUnit(picked)}.`);
        break;
      }
      if (decision === "refuse") {
        console.error(EXECUTION_REFUSED_MESSAGE);
        process.exit(1);
      }

      // Acquire a concurrency slot for the whole unit execution (#59): the
      // supervisor's global cap bounds how many repos run a unit at once. Held
      // through worktree + install + agent + test + push, released in `finally`
      // so timeout, error, and normal completion share one leak-free release
      // path (#72). Standalone (unbrokered) engines skip this entirely.
      if (slotClient) {
        try {
          await slotClient.acquire();
        } catch (error) {
          if (error instanceof BrokerDisconnectedError) {
            // The supervisor's channel closed while we waited for a slot. Stop
            // rather than run unbrokered (which, across a fleet, would bypass the
            // global cap); the supervisor is gone or will respawn us afresh.
            console.error(`[phoebe] ${error.message} — stopping this engine.`);
            break;
          }
          throw error;
        }
      }

      // Credential lease — call site 2: after the slot grant, before the agent
      // spawns (#211). The slot acquire can block arbitrarily long behind the
      // concurrency cap; a lease taken before acquiring would be worthless in a
      // busy fleet. A disconnect or a blocked answer releases the slot and loops —
      // no drain, no kill, no hang.
      if (credentialClient) {
        try {
          const token = await credentialClient.requestLease(credentialBudgetMs);
          if (token !== null) env["GH_TOKEN"] = token;
        } catch (error) {
          slotClient?.release();
          if (error instanceof BrokerDisconnectedError) {
            console.error(`[phoebe] ${error.message} — stopping this engine.`);
            break;
          }
          if (error instanceof CredentialRefreshBlockedError) {
            console.warn(
              `[phoebe] Credential refresh unavailable after slot grant — unit admission blocked.`,
            );
            await drain.wait(pollIntervalMs);
            continue;
          }
          if (error instanceof CredentialLeaseTimedOutError) {
            console.warn(
              `[phoebe] Credential lease timed out after slot grant — unit admission skipped.`,
            );
            await drain.wait(pollIntervalMs);
            continue;
          }
          throw error;
        }
      }

      // A drain that arrived while awaiting the credential lease must not let this
      // unit start — "start no new one". Release the already-acquired slot.
      if (drain.requested) {
        slotClient?.release();
        console.log("[phoebe] Drain requested before starting the next unit — exiting 0.");
        break;
      }

      const ref = unitRefOf(picked);
      emitUnitEvent({ unit: ref, event: "started" });
      try {
        await runPickedUnit(picked, cycle.ctxFor(picked.kind));
        emitUnitEvent({ unit: ref, event: "completed" });
      } catch (error) {
        if (error instanceof RunTimeoutError) {
          // A whole-unit timeout (#72): the agent was killed, the slot releases in
          // `finally`, and the engine survives (never told to the supervisor, #60
          // orthogonality). #75 layers the poison-unit quarantine on this event.
          emitUnitEvent({
            unit: ref,
            event: "timed-out",
            detail: `${Math.round(error.elapsedMs / 1000)}s budget exceeded`,
          });
          // Count this timeout on the unit and, at K consecutive, quarantine it so
          // a genuinely poisonous unit stops being re-picked forever (#75).
          recordUnitTimeout(picked, emitUnitEvent);
        } else {
          // A non-timeout failure: clear the current unit and record the error so
          // `phoebe list` shows it (the durable record is still the per-work-kind
          // watermark/failure-comment on GitHub; this is the at-a-glance snapshot).
          emitUnitEvent({
            unit: ref,
            event: "failed",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        if (runOnce) {
          throw error;
        }
        // A failed unit must not kill the daemon — prepareWorktree clears any
        // stale worktree on the next attempt.
        console.error(
          `[phoebe] Failed executing ${describeUnit(picked)} — ${error instanceof Error ? error.message : String(error)}`,
        );
        await drain.wait(pollIntervalMs);
        continue;
      } finally {
        slotClient?.release();
      }

      if (runOnce) break;
      // Drain requested while the unit ran: it is finished, so exit now rather
      // than picking up another. This is the graceful-drain boundary.
      if (drain.requested) {
        console.log("[phoebe] Finished the in-flight unit under drain — exiting 0.");
        break;
      }
    }
  }

  return { runLoop };
}

// ---------------------------------------------------------------------------
// Process entry point
// ---------------------------------------------------------------------------

/**
 * Build the engine this process's environment describes and run its loop until
 * it exits (persistent mode) or completes one unit (`--run-once`). Called by
 * src/cli.ts with the config it resolved; the CLI passes its argv with
 * `--config <path>` already stripped, so this only sees engine-level flags.
 *
 * This is where the process lives: argv, `process.env` and the IPC channel are
 * read here and handed to `createEngine` as values. The factory reaches for
 * none of them itself, which is what lets a test run a cycle without them.
 */
export async function runEngine(
  config: PhoebeConfig,
  argv: readonly string[] = process.argv.slice(2),
  registry: WorkKindRegistry = buildRegistry(config),
): Promise<void> {
  // Before anything else, and before a dry run too: a prompt this tenant cannot
  // load is a startup failure, not a surprise weeks later when the first unit of
  // that kind is dispatched (#164). Scoped to the validated work order — only
  // the kinds this tenant can actually dispatch need a prompt — and uniform
  // across built-in and custom kinds: each scheduled definition's `promptFile`
  // is checked against the runtime root.
  const workOrder = validateWorkOrder(config.workOrder, [...registry.keys()]);
  assertPromptFilesExist({
    repoSlug: config.repoSlug,
    runtimeRoot: process.cwd(),
    kinds: workOrder.map((kind) => {
      const registered = registry.get(kind);
      if (!registered) throw new Error(`Work kind "${kind}" is not registered.`);
      return { name: kind, promptFile: registered.definition.promptFile };
    }),
  });

  const runOnce = argv.includes("--run-once");
  const dryRun = argv.includes("--dry-run");
  const rawPollIntervalMs = Number(process.env["PHOEBE_POLL_INTERVAL_MS"]);
  const pollIntervalMs =
    Number.isFinite(rawPollIntervalMs) && rawPollIntervalMs > 0
      ? rawPollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;

  console.log(
    runOnce
      ? "[phoebe] Run-once mode — will work at most one unit of the first one-shot-eligible kind in WORK_ORDER, then exit."
      : `[phoebe] Persistent mode — idle poll every ${pollIntervalMs}ms. SIGTERM drains: finish the current unit, then exit 0.`,
  );
  if (dryRun) {
    console.log("[phoebe] Dry-run — selection only, nothing executes.");
  }

  // Bootstrap the private clone every work unit fetches/worktrees against. Only
  // in the container (on the host the cwd is already a repo) and never for
  // --dry-run (selection uses the GitHub API, not a local clone). No-op once
  // the clone exists, so it's safe on every daemon restart. Ahead of the drain
  // latch below, as it was before the engine became a factory: until that latch
  // exists, a SIGTERM mid-clone still kills the process rather than being held
  // until the clone finishes.
  const inContainer = isInsideContainer();
  if (inContainer && !dryRun) {
    ensureOriginClone(config, inContainer);
  }

  // `phoebe boot` stops the engine with SIGTERM (container shutdown, and later a
  // config/ref change). Drain gracefully rather than dying mid-unit: finish the
  // unit in flight, start no new one, then return (exit 0). The loop's idle wait
  // wakes early on drain so an idle poll-sleep does not stall shutdown.
  // The supervisor's concurrency broker (#59): when this engine was forked with
  // an IPC channel, `slotClient` requests a slot per work unit and blocks until
  // the supervisor grants one. A standalone engine (no channel) gets null here
  // and runs unbrokered — it is already serialized to one unit.
  const ipcChannel = {
    send: process.send?.bind(process),
    on: (event: "message" | "disconnect", listener: (message: unknown) => void) => {
      process.on(event, listener);
    },
    off: (event: "message" | "disconnect", listener: (message: unknown) => void) => {
      process.off(event, listener);
    },
    connected: process.connected,
  };
  const slotClient = createSlotClient(ipcChannel);
  // The credential lease client (#211/#205): when this engine was forked with
  // an IPC channel (fleet or supervised solo), `credentialClient` refreshes the
  // credential before each poll and again after each slot grant — a rotated
  // PAT re-read from the tenant's `.env`, or a minted installation token. A
  // null answer means "keep what you have"; only the top-of-poll site backs
  // that with an inline App mint (site 2 then reuses this cycle's token). A
  // standalone engine (no channel) gets null here and runs with its existing
  // GH_TOKEN unchanged.
  const credentialClient = createCredentialClient(ipcChannel);

  // Per-repo observability (#73): one tagged `[phoebe:<slug>]` line per unit
  // event + a `status.json` snapshot in this tenant's state dir, which
  // `phoebe list` reads. The emitter swallows snapshot-write failures, so it is
  // harmless on the host (where the derived state dir may be unwritable).
  const emitUnitEvent = createEmitUnitEvent({
    tenant: config.repoSlug,
    statusPath: join(config.paths.stateDir, STATUS_FILE),
  });

  const drain = installDrainSignal();
  try {
    const engine = createEngine({
      config,
      registry,
      env: process.env,
      drain,
      slotClient,
      credentialClient,
      emitUnitEvent,
      run: { runOnce, dryRun, pollIntervalMs },
    });
    await engine.runLoop();
  } finally {
    drain.dispose();
  }
}
