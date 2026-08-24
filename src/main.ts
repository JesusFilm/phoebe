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
import { PROVIDER_NAMES, type PhoebeConfig, type ProviderName } from "./config-schema.ts";
import { detectAppCredentials, mintInstallationToken } from "./gh-app.ts";
import { asBranchRef, asPrNumber, type BranchRef, type PrNumber, type Sha } from "./branded.ts";
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
  buildReviewsHandledComment,
  checksFixFailureComment,
  conflictFixFailureComment,
  followUpPrComment,
  formatFailingChecksForPrompt,
  isReviewSummaryComment,
  issueBranch,
  newestReviewThreadCommentCreatedAt,
  parseIssueNumberFromBranch,
  getMergedBlockerPrNumbers,
  oneShotWorkKinds,
  stackedCatchUpRetractionComment,
  RUN_ONCE_NOTHING_MESSAGE,
  selectFirstWorkUnit,
  unresolvedBlockerNumbers,
  shouldPostChecksFixFailure,
  shouldPostConflictFixFailure,
  validateWorkOrder,
  type BlockerPrState,
  type ChecksCandidate,
  type ChecksFailWatermark,
  type ConflictingPrCandidate,
  type ConflictFailWatermark,
  type Issue,
  type IssueWorkUnit,
  type ReviewsCandidate,
  type StackContext,
  type WorkKindName,
  type WorkUnit,
  type WorkUnitSkip,
} from "./orchestrator.ts";
import {
  createWorkSource,
  type Clock,
  type CycleRecord,
  type WorkSource,
} from "./cycle-work-source.ts";

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

type AgentWorkflowResult = {
  worktreeDir: string;
  branch: BranchRef;
  originShaBefore: Sha;
  originShaAfter: Sha;
  localCommitCount: number;
};

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

/**
 * Why nothing was workable, naming the blockers when there are any — the bare
 * count is indistinguishable from a legitimate wait (#219).
 */
function idleBlockerReason(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
): string {
  const waiting = unresolvedBlockerNumbers(issues, blockerStates, phoebeBase);
  return waiting.length > 0
    ? `(waiting on blockers ${waiting.map((n) => `#${n}`).join(", ")})`
    : "(blocked or waiting on blocker PR)";
}

/** The observability identity of a picked unit: (kind, id) (#73/#75). */
function unitRef(picked: WorkUnit): UnitRef {
  if (picked.kind === "issues" || picked.kind === "research") {
    return { kind: picked.kind, id: String(picked.unit.issue.number) };
  }
  return { kind: picked.kind, id: String(picked.unit.prNumber) };
}

function describeUnit(picked: WorkUnit): string {
  if (picked.kind === "conflicts") {
    const unit = picked.unit;
    return `conflict fix for PR #${unit.prNumber} (${unit.headRefName})`;
  }
  if (picked.kind === "checks") {
    const unit = picked.unit;
    return `checks fix for PR #${unit.prNumber} (${unit.headRefName})`;
  }
  if (picked.kind === "reviews") {
    const unit = picked.unit;
    return `review feedback for PR #${unit.prNumber} (${unit.headRefName})`;
  }
  if (picked.kind === "research") {
    const unit = picked.unit;
    return `research ticket #${unit.issue.number} — base ${unit.resolution.worktreeBase}`;
  }
  const unit = picked.unit;
  return `issue #${unit.issue.number} — base ${unit.resolution.worktreeBase}`;
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
  const defaultBranchRef = asBranchRef(config.defaultBranch);

  const inContainer = isInsideContainer();
  const hub = options.originHub ?? createOriginHub(config, inContainer, git);

  // ---------------------------------------------------------------------------
  // Provider selection (multi-provider ready)
  // ---------------------------------------------------------------------------

  function selectProvider(): { provider: Provider; model: string; effort: string | undefined } {
    const name = env["PHOEBE_AGENT"] ?? config.defaultProvider;
    if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`Unknown PHOEBE_AGENT "${name}". Use one of: ${PROVIDER_NAMES.join(", ")}.`);
    }
    const provider = PROVIDERS[name as ProviderName];
    const model = env["PHOEBE_MODEL"] ?? config.defaultModels[name as ProviderName];
    // Unset (or empty) means "pass no effort flag" — the provider CLI's own
    // default stands. An empty `PHOEBE_EFFORT` is treated as unset so compose's
    // `"${PHOEBE_EFFORT:-}"` passthrough doesn't silently force a blank level.
    const effort = env["PHOEBE_EFFORT"] || config.defaultEfforts[name as ProviderName];
    return { provider, model, effort: effort === "" ? undefined : effort };
  }

  const workOrder = validateWorkOrder(config.workOrder);

  /**
   * Phoebe's own login, resolved when this cycle has not already. Only the
   * `reviews` kind's fetch resolves it, but any kind can reach a comparison
   * against it, and there is deliberately no placeholder to stand in: `""` would
   * be a login like any other, and the login a deleted account does not have used
   * to be `""` too — so Phoebe's own timeout markers could read as foreign
   * activity, or a ghost's comment as Phoebe's. The lookups this covers are rare,
   * so paying for one is cheaper than carrying a value that can lie.
   */
  function resolvePhoebeLogin(cycleLogin: string | undefined): string {
    // `||`, not `??`: an empty login is exactly the placeholder this exists to
    // keep out of a comparison, so it counts as unresolved too.
    return cycleLogin || github.resolveLogin(env["PHOEBE_GH_LOGIN"]);
  }

  // --- Poison-unit quarantine write path (#75) ---------------------------------
  // The read/skip half ships in orchestrator.ts (it filters `phoebe:quarantined`
  // out of selection). This is the missing write half: on a whole-unit timeout,
  // count consecutive timeouts on the unit itself (a GitHub marker) and, at K,
  // apply the label + escalation comment so the poisonous unit stops being
  // re-picked. Kept thin over the GitHub client; the count/threshold policy is
  // pure in quarantine.ts (`decideTimeoutRecord`).

  /**
   * Record one whole-unit timeout toward the poison-unit quarantine (#75): read the
   * latest timeout marker on the unit, post the incremented count, and at K apply
   * `phoebe:quarantined` + the escalation comment so selection starts skipping it.
   * Best-effort — a GitHub write failure here is logged and swallowed so it can
   * never take the daemon down (the timeout itself is already recorded).
   */
  function recordUnitTimeout(
    picked: WorkUnit,
    cycleLogin: string | undefined,
    emit: EmitUnitEvent,
  ): void {
    const ref = unitRef(picked);
    const isIssueKind = picked.kind === "issues" || picked.kind === "research";
    const target: UnitTarget = { objectType: isIssueKind ? "issue" : "pr", id: Number(ref.id) };
    try {
      const login = resolvePhoebeLogin(cycleLogin);
      const k = resolveMaxUnitTimeouts(env, config.maxUnitTimeouts);
      const inputs = isIssueKind
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
        `[phoebe] Could not record timeout toward quarantine for ${ref.kind} #${ref.id} — ` +
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
  // Failure watermarks — snapshot origin state around an agent run
  // ---------------------------------------------------------------------------

  function currentConflictFailureWatermark(branch: BranchRef): ConflictFailWatermark {
    hub.fetch();
    return {
      prHead: hub.branchHead(branch),
      mainHead: hub.branchHead(defaultBranchRef),
    };
  }

  function currentChecksFailureWatermark(branch: BranchRef): ChecksFailWatermark {
    hub.fetch();
    return { prHead: hub.branchHead(branch) };
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

  async function runAgentInWorktree(opts: {
    worktreeDir: string;
    promptFile: string;
    promptArgs: Record<string, string>;
  }): Promise<void> {
    const { provider, model, effort } = selectProvider();
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
   * The shared skeleton behind every PR-fix agent: snapshot origin, prepare a
   * worktree, install, optionally prime the tree, run the agent, then re-snapshot
   * origin and count the host-side commits. Only `onResult` differs per work kind
   * (push vs. failure comment vs. watermark); the worktree is always removed.
   */
  async function runAgentWorkflow(opts: {
    pr: { prNumber: PrNumber; headRefName: BranchRef };
    promptFile: string;
    promptArgs: Record<string, string>;
    beforeAgent?: (worktreeDir: string) => void;
    onResult: (result: AgentWorkflowResult) => void | Promise<void>;
  }): Promise<void> {
    const branch = opts.pr.headRefName;

    hub.fetch();
    const originShaBefore = hub.branchHead(branch);

    const worktreeDir = prepareWorktree({ branch });
    try {
      runShellCommand(config.installCommand, worktreeDir, env);
      opts.beforeAgent?.(worktreeDir);

      await runAgentInWorktree({
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
      });
    } finally {
      hub.removeWorktree(worktreeDir);
    }
  }

  async function runConflictResolutionAgent(
    pr: ConflictingPrCandidate,
    mergedBlockerPrNumbers: readonly PrNumber[],
  ): Promise<void> {
    await runAgentWorkflow({
      pr,
      promptFile: config.promptFiles.conflict,
      promptArgs: {
        PR_NUMBER: String(pr.prNumber),
        PR_BRANCH: pr.headRefName,
        BLOCKER_PR_NUMBERS: mergedBlockerPrNumbers.join(","),
      },
      beforeAgent: (worktreeDir) => attemptBlockerFirstMerges(worktreeDir, mergedBlockerPrNumbers),
      onResult: ({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount }) => {
        const prInfo = github.currentMergeInfo(pr.prNumber);
        if (
          shouldPostConflictFixFailure({
            hostCommitCount: localCommitCount,
            originShaBefore,
            originShaAfter,
            mergeable: prInfo.mergeable,
            mergeStateStatus: prInfo.mergeStateStatus,
          })
        ) {
          console.log(
            `[phoebe] Conflict fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
          );
          github.postPrComment(
            pr.prNumber,
            conflictFixFailureComment(pr.prNumber, currentConflictFailureWatermark(pr.headRefName)),
          );
        } else if (localCommitCount > 0) {
          hub.pushBranch(worktreeDir, branch);
          console.log(`[phoebe] Conflict resolved for PR #${pr.prNumber} — pushed.`);
        } else {
          console.log(
            `[phoebe] Conflict resolved for PR #${pr.prNumber} — already pushed by agent.`,
          );
        }
      },
    });
  }

  async function fixOnePrConflict(pr: ConflictingPrCandidate, ctx: StackContext): Promise<void> {
    console.log(`[phoebe] Conflict fix: PR #${pr.prNumber} (${pr.headRefName}).`);
    hub.fetch();

    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    const body = issueNumber !== null ? (ctx.issueBodies.get(issueNumber) ?? "") : "";
    const mergedBlockerPrNumbers = getMergedBlockerPrNumbers(body, ctx.blockerStates);
    if (mergedBlockerPrNumbers.length > 0) {
      console.log(
        `[phoebe] Stacked catch-up: merging blocker PR(s) ${mergedBlockerPrNumbers.map((n) => `#${n}`).join(", ")} before ${config.defaultBranch}.`,
      );
    }

    const cleanResult = tryCleanMerge(pr.headRefName, mergedBlockerPrNumbers);
    if (cleanResult === "pushed") {
      console.log(`[phoebe] Clean merge for PR #${pr.prNumber} — pushed.`);
      if (mergedBlockerPrNumbers.length > 0) {
        github.postPrComment(pr.prNumber, stackedCatchUpRetractionComment(mergedBlockerPrNumbers));
      }
      return;
    }
    if (cleanResult === "failed") {
      console.log(`[phoebe] Could not start merge for PR #${pr.prNumber} — skipping.`);
      github.postPrComment(
        pr.prNumber,
        conflictFixFailureComment(pr.prNumber, currentConflictFailureWatermark(pr.headRefName)),
      );
      return;
    }

    await runConflictResolutionAgent(pr, mergedBlockerPrNumbers);
  }

  async function runChecksResolutionAgent(pr: ChecksCandidate): Promise<void> {
    await runAgentWorkflow({
      pr,
      promptFile: config.promptFiles.checks,
      promptArgs: {
        PR_NUMBER: String(pr.prNumber),
        PR_BRANCH: pr.headRefName,
        FAILING_CHECKS: formatFailingChecksForPrompt(pr.failingChecks),
      },
      onResult: ({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount }) => {
        if (
          shouldPostChecksFixFailure({
            hostCommitCount: localCommitCount,
            originShaBefore,
            originShaAfter,
          })
        ) {
          console.log(
            `[phoebe] Checks fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
          );
          github.postPrComment(
            pr.prNumber,
            checksFixFailureComment(pr.prNumber, currentChecksFailureWatermark(pr.headRefName)),
          );
        } else if (localCommitCount > 0) {
          hub.pushBranch(worktreeDir, branch);
          console.log(`[phoebe] Checks fixed for PR #${pr.prNumber} — pushed.`);
        } else {
          console.log(`[phoebe] Checks fixed for PR #${pr.prNumber} — already pushed by agent.`);
        }
      },
    });
  }

  async function fixOnePrChecks(pr: ChecksCandidate, ctx: StackContext): Promise<void> {
    console.log(
      `[phoebe] Checks fix: PR #${pr.prNumber} (${pr.headRefName}) — ` +
        `${pr.failingChecks.map((c) => c.name).join(", ")}.`,
    );
    hub.fetch();

    if (pr.mergeStateStatus === "BEHIND") {
      const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
      const body = issueNumber !== null ? (ctx.issueBodies.get(issueNumber) ?? "") : "";
      const mergedBlockerPrNumbers = getMergedBlockerPrNumbers(body, ctx.blockerStates);
      if (mergedBlockerPrNumbers.length > 0) {
        console.log(
          `[phoebe] Behind main — catch-up merging blocker PR(s) ${mergedBlockerPrNumbers.map((n) => `#${n}`).join(", ")} before ${config.defaultBranch}.`,
        );
      } else {
        console.log(`[phoebe] Behind main — catch-up merge for PR #${pr.prNumber}.`);
      }

      const cleanResult = tryCleanMerge(pr.headRefName, mergedBlockerPrNumbers);
      if (cleanResult === "pushed") {
        console.log(
          `[phoebe] Catch-up merge for PR #${pr.prNumber} — pushed; waiting for CI on next cycle.`,
        );
        if (mergedBlockerPrNumbers.length > 0) {
          github.postPrComment(
            pr.prNumber,
            stackedCatchUpRetractionComment(mergedBlockerPrNumbers),
          );
        }
        return;
      }
      if (cleanResult === "conflicted" || cleanResult === "failed") {
        console.log(
          `[phoebe] Catch-up merge conflicted for PR #${pr.prNumber} — deferring to conflicts mode.`,
        );
        return;
      }
    }

    await runChecksResolutionAgent(pr);
  }

  function hasNewReviewSummaryComment(
    prNumber: PrNumber,
    phoebeLogin: string,
    since: string,
  ): boolean {
    return github
      .reviewSummaryComments(prNumber)
      .some(
        (comment) =>
          comment.authorLogin === phoebeLogin &&
          comment.createdAt > since &&
          isReviewSummaryComment(comment.body),
      );
  }

  async function runReviewsResolutionAgent(
    pr: ReviewsCandidate,
    phoebeLogin: string,
  ): Promise<void> {
    const runStartedAt = clock.now().toISOString();
    await runAgentWorkflow({
      pr,
      promptFile: config.promptFiles.reviews,
      promptArgs: {
        PR_NUMBER: String(pr.prNumber),
        PR_BRANCH: pr.headRefName,
      },
      onResult: ({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount }) => {
        if (localCommitCount > 0) {
          hub.pushBranch(worktreeDir, branch);
          console.log(`[phoebe] Review feedback handled for PR #${pr.prNumber} — pushed.`);
        } else if (originShaAfter !== originShaBefore) {
          console.log(
            `[phoebe] Review feedback handled for PR #${pr.prNumber} — already pushed by agent.`,
          );
        }

        const hasSummary = hasNewReviewSummaryComment(pr.prNumber, phoebeLogin, runStartedAt);
        const pushed = localCommitCount > 0 || originShaAfter !== originShaBefore;
        // Watermark only the activity captured before the agent ran (pr.threads is
        // the pre-run snapshot from gatherCycle). Re-fetching here could
        // absorb feedback posted concurrently with the run — marking it handled
        // even though the agent never observed it, so it would never trigger another
        // cycle. Any activity newer than this snapshot correctly re-selects the PR.
        const latestActivityAt = newestReviewThreadCommentCreatedAt(pr.threads);

        if (hasSummary) {
          console.log(`[phoebe] Review summary posted for PR #${pr.prNumber}.`);
        } else if (!pushed) {
          console.log(
            `[phoebe] Review handling for PR #${pr.prNumber} produced no summary or push.`,
          );
        }

        github.postPrComment(
          pr.prNumber,
          buildReviewsHandledComment({
            latestActivityAt,
            failed: !hasSummary && !pushed,
          }),
        );
      },
    });
  }

  async function fixOnePrReviews(pr: ReviewsCandidate, phoebeLogin: string): Promise<void> {
    console.log(`[phoebe] Reviews fix: PR #${pr.prNumber} (${pr.headRefName}).`);
    hub.fetch();
    await runReviewsResolutionAgent(pr, phoebeLogin);
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

    hub.fetch();
    const worktreeDir = prepareWorktree({ branch: agentBranch, baseRef: worktreeBase });
    try {
      runShellCommand(config.installCommand, worktreeDir, env);

      await runAgentInWorktree({
        worktreeDir,
        promptFile,
        promptArgs: { ISSUE_NUMBER: String(issueNumber) },
      });

      const newCommitCount = hub.commitCount(worktreeDir, `${worktreeBase}..HEAD`);

      if (newCommitCount > 0) {
        if (config.creditIssueAuthor) {
          stampIssueAuthorCredit({ issueNumber, worktreeDir, baseRef: worktreeBase });
        }
        hub.pushBranch(worktreeDir, agentBranch);
        const existingPr = github.findIssuePr(issueNumber);
        if (existingPr === null) {
          const prTitle = `Phoebe: ${issueTitle} (#${issueNumber})`;
          const prBody = buildInitialPrBody({
            issueNumber,
            commitCount: newCommitCount,
            ...(stacked && blockerIssueNumber !== undefined && blockerPrNumber !== undefined
              ? { stacked: { blockerIssueNumber, blockerPrNumber } }
              : {}),
          });
          github.createPr({ head: agentBranch, base: prBase, title: prTitle, body: prBody });
        } else {
          console.log(
            `[phoebe] PR #${existingPr} already exists for ${agentBranch} — posting follow-up note.`,
          );
          github.postPrComment(existingPr, followUpPrComment(issueNumber, newCommitCount));
        }
      } else {
        console.log("[phoebe] No commits — skipping PR creation.");
      }
    } finally {
      hub.removeWorktree(worktreeDir);
    }
  }

  // ---------------------------------------------------------------------------
  // Work-unit runners
  // ---------------------------------------------------------------------------

  async function runIssueUnit(unit: IssueWorkUnit): Promise<void> {
    const { issue: target, resolution } = unit;
    console.log(
      `[phoebe] Working #${target.number} — base ${resolution.worktreeBase}` +
        (resolution.stacked ? ` (stacked on #${resolution.blockerIssueNumber})` : "") +
        ".",
    );
    await runOneIssue({
      issueNumber: target.number,
      issueTitle: target.title,
      worktreeBase: resolution.worktreeBase,
      stacked: resolution.stacked,
      promptFile: config.promptFiles.issue,
      blockerIssueNumber: resolution.blockerIssueNumber,
      blockerPrNumber: resolution.blockerPrNumber,
    });
  }

  async function runResearchUnit(unit: IssueWorkUnit): Promise<void> {
    const { issue: target, resolution } = unit;
    console.log(
      `[phoebe] Researching #${target.number} — base ${resolution.worktreeBase}` +
        (resolution.stacked ? ` (stacked on #${resolution.blockerIssueNumber})` : "") +
        ".",
    );
    await runOneIssue({
      issueNumber: target.number,
      issueTitle: target.title,
      worktreeBase: resolution.worktreeBase,
      stacked: resolution.stacked,
      promptFile: config.promptFiles.research,
      blockerIssueNumber: resolution.blockerIssueNumber,
      blockerPrNumber: resolution.blockerPrNumber,
    });
  }

  const workSource: WorkSource = createWorkSource({
    github,
    originHub: hub,
    clock,
    env,
    defaultBranchRef,
  });

  /**
   * How the idle report speaks about each kind: what this tenant calls its units,
   * and — for the kinds whose selector lumps every skip rule into one `ineligible`
   * count — which rules that count covers. `conflicts` reports its two rules apart
   * and so needs no such phrase; `issues` and `research` have no `ineligible`
   * count at all.
   */
  const KIND_REPORT: Record<WorkKindName, { noun: string; ineligibleCause?: string }> = {
    conflicts: { noun: "conflicting PR(s)" },
    checks: {
      noun: "failing-CI PR(s)",
      ineligibleCause: "conflicting, stacked, or watermarked",
    },
    reviews: {
      noun: "review-feedback PR(s)",
      ineligibleCause: "stacked, watermarked, or no new activity",
    },
    issues: { noun: `${config.readyLabel} issue(s)` },
    research: { noun: `${config.researchLabel} ticket(s)` },
  };

  /** One line of the idle report, rendered from one entry of the selection's record. */
  function idleSkipLine(skip: WorkUnitSkip, record: CycleRecord): string {
    const { noun, ineligibleCause } = KIND_REPORT[skip.kind];
    if (skip.reason === "none-workable") {
      if (skip.kind === "issues" || skip.kind === "research") {
        const issues = skip.kind === "issues" ? record.issues : record.researchIssues;
        const reason = idleBlockerReason(issues, record.blockerStates, env["PHOEBE_BASE"]);
        return `${skip.count} ${noun} but none workable this cycle ${reason}.`;
      }
      return `${skip.count} ${noun} but none fixable this cycle.`;
    }
    const cause =
      skip.reason === "stacked-on-blocker"
        ? "stacked on open blocker"
        : skip.reason === "unchanged-watermark"
          ? "unchanged failure watermark"
          : // A kind that has not spelled its rules out names the reason itself.
            (ineligibleCause ?? skip.reason);
    return `${skip.count} ${noun} skipped (${cause}).`;
  }

  /**
   * Explain an idle cycle from the record the selection walk produced, so the
   * report can only ever describe the walk the loop actually made. It stops at
   * the first kind that had units and could work none of them: that kind is why
   * this cycle is idle, and the kinds behind it in `workOrder` would not have run
   * anyway.
   */
  function logIdleCycle(record: CycleRecord, skipped: readonly WorkUnitSkip[]): void {
    for (const skip of skipped) {
      console.log(`[phoebe] ${idleSkipLine(skip, record)}`);
      if (skip.reason === "none-workable") {
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
      const fetchKinds = runOnce ? oneShotWorkKinds(workOrder) : workOrder;
      const record = await workSource.gatherCycle(fetchKinds);
      const { unit: picked, skipped } = selectFirstWorkUnit(record.kindsGathered, {
        issues: record.issues,
        researchIssues: record.researchIssues,
        blockerStates: record.blockerStates,
        conflictingPrs: record.conflictingPrs,
        failingCheckPrs: record.failingCheckPrs,
        reviewActivityPrs: record.reviewActivityPrs,
        issueBodies: record.issueBodies,
        phoebeBase: env["PHOEBE_BASE"],
        phoebeLogin: record.phoebeLogin,
        currentMainHead: record.currentMainHead,
      });

      if (!picked) {
        if (runOnce) {
          console.log(RUN_ONCE_NOTHING_MESSAGE);
        } else {
          logIdleCycle(record, skipped);
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

      const ref = unitRef(picked);
      emitUnitEvent({ unit: ref, event: "started" });
      try {
        const stack = { issueBodies: record.issueBodies, blockerStates: record.blockerStates };
        switch (picked.kind) {
          case "conflicts":
            await fixOnePrConflict(picked.unit, stack);
            break;
          case "checks":
            await fixOnePrChecks(picked.unit, stack);
            break;
          case "reviews":
            await fixOnePrReviews(picked.unit, resolvePhoebeLogin(record.phoebeLogin));
            break;
          case "issues":
            await runIssueUnit(picked.unit);
            break;
          case "research":
            await runResearchUnit(picked.unit);
            break;
        }
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
          recordUnitTimeout(picked, record.phoebeLogin, emitUnitEvent);
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
): Promise<void> {
  // Before anything else, and before a dry run too: a prompt this tenant cannot
  // load is a startup failure, not a surprise weeks later when the first unit of
  // that kind is dispatched (#164). Scoped to the validated work order — only
  // the kinds this tenant can actually dispatch need a prompt. The engine
  // validates the same order again as its own local; both calls are pure.
  assertPromptFilesExist(config, process.cwd(), validateWorkOrder(config.workOrder));

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
