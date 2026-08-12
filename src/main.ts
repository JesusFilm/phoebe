// Phoebe orchestration engine — an away-from-keyboard (AFK) worker loop.
//
// This module is the composition root (`runEngine`) plus the generic cycle
// loop (`runLoop`). Every work kind owns its whole lifecycle — fetch, select,
// run — behind `src/kinds/kind.ts`'s `WorkKind`/`KindHandle` interface; the
// loop below never sees a kind's own `Data`/`Unit` shape, only `UnitRef`,
// `Gathered`, and `Plan`. See docs/architecture.md for the full design.
//
// The `runEngine({ config, argv })` export is the loop entry point invoked by
// src/commands/engine.ts after it resolves the consumer's phoebe.config.ts.
// Recognised argv flags:
//
//   (no flags)              # persistent poll loop
//   --run-once               # one unit of the first one-shot-eligible kind
//   --dry-run --run-once     # host-side selection preview
//
// Work-unit execution is refused outside the container marker
// (src/execution-gate.ts).

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { validateWorkOrder, type PhoebeConfig } from "./config/index.ts";
import type { BranchRef } from "./branded.ts";
import { createGitHub, defaultGhRun, type GitHub } from "./github.ts";
import { buildAgentEnv, generateTraceparent } from "./agent-env.ts";
import { installDrainSignal, REF_CHANGE_DRAIN_SIGNAL, type DrainSignal } from "./drain.ts";
import { BrokerDisconnectedError, createSlotClient, type SlotClient } from "./slot-client.ts";
import { RunTimeoutError, runWithDeadline } from "./run-timeout.ts";
import { ensureLabels, phoebeLabelSet } from "./ensure-labels.ts";
import {
  EXECUTION_REFUSED_MESSAGE,
  executionDecision,
  isInsideContainer,
} from "./execution-gate.ts";
import { createPhoebeLog } from "./phoebe-log.ts";
import {
  addWorktreeForExistingBranch,
  addWorktreeForNewBranch,
  commitCount,
  ensureClone,
  fetchOrigin as gitFetchOrigin,
  originBranchSha as gitOriginBranchSha,
  pushBranch,
  removeWorktree,
  worktreeDirForBranch,
} from "./git-model.ts";
import { pushBudgetExhausted, recordPush } from "./push-rate-limit.ts";
import { dailyCostBudgetExhausted } from "./cost-cap.ts";
import { runAgent } from "./providers/run-agent.ts";
import type { AgentUsage } from "./providers/types.ts";
import { selectProvider } from "./providers/select.ts";
import { classifyTier } from "./tier.ts";
import {
  assertPromptFilesExist,
  buildDefaultPromptArgs,
  loadPromptTemplate as loadPromptTemplateFromRoot,
  renderPrompt,
} from "./prompt.ts";
import { buildRuntimeContractContext } from "./runtime-contract-context.ts";
import { createRuntimeStatusReporter } from "./runtime-status.ts";
import { createQuarantine } from "./quarantine.ts";
import { ghStackExtensionInstallArgs, nativeStackGitConfig, type StackConfig } from "./stack.ts";
import { gatherCycleContext } from "./cycle.ts";
import {
  boxKind,
  gatherFetchPhase,
  oneShotEligible,
  pickFirstIdleReason,
  pickFirstPlan,
  RUN_ONCE_NOTHING_MESSAGE,
  type AgentRunner,
  type GitOps,
  type Io,
  type KindDeps,
  type KindHandle,
  type Prompts,
  type Shell,
  type UnitRef,
} from "./kinds/kind.ts";
import { createConflictsKind } from "./kinds/conflicts.ts";
import { createChecksKind } from "./kinds/checks.ts";
import { createReviewsKind } from "./kinds/reviews.ts";
import {
  buildIssueQueue,
  createIssuesKind,
  createResearchKind,
  reclaimStaleClaims,
} from "./kinds/producer.ts";

const DEFAULT_POLL_INTERVAL_MS = 300_000;
// Never let a git child process block the persistent loop forever (rate-limit
// backoff, credential prompt, network partition). Configured toolchain commands
// (install/test) get a longer leash. `gh` calls carry their own timeout default,
// set on the `github` client built in `runEngine` (src/github.ts).
const CHILD_PROCESS_TIMEOUT_MS = 120_000;
const SHELL_COMMAND_TIMEOUT_MS = 600_000;

function gitInWorktree(
  dir: string,
  args: readonly string[],
  opts?: { stdio?: "inherit" | "ignore" | "pipe" },
): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    ...(opts?.stdio ? { stdio: opts.stdio } : {}),
  }) as unknown as string;
}

/** Run a configured toolchain command (a shell string) inside a worktree, to completion. */
function runShellCommand(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: "inherit", timeout: SHELL_COMMAND_TIMEOUT_MS });
}

/**
 * Run a configured toolchain command to completion, capturing its exit code
 * and combined stdout+stderr instead of inheriting stdio (#166) — the
 * engine's own verification run, so it must observe a nonzero exit or a
 * timeout as a result rather than an exception. `spawnSync` (not `execSync`)
 * because it reports a killed-by-timeout command via `signal`, not a thrown
 * error, and returns stdout/stderr together instead of losing stderr to the
 * parent's inherited stream.
 */
function runShellCommandCapture(
  command: string,
  cwd: string,
): { exitCode: number; output: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: SHELL_COMMAND_TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    return { exitCode: 1, output: `${output}${result.error.message}` };
  }
  if (result.signal) {
    return { exitCode: 124, output: `${output}\nkilled by ${result.signal} (timeout).` };
  }
  return { exitCode: result.status ?? 1, output };
}

/** Shell executor for prompt !`...` expansion — captures stdout. */
function promptShell(cwd: string): (command: string) => string {
  return (command) =>
    execSync(command, { cwd, encoding: "utf8", timeout: SHELL_COMMAND_TIMEOUT_MS });
}

function buildShell(): Shell {
  return { run: runShellCommand, capture: runShellCommandCapture };
}

// ---------------------------------------------------------------------------
// Generic unit-ref helpers — the loop's vocabulary. No knowledge of any
// kind's own `Unit` shape lives past this point.
// ---------------------------------------------------------------------------

type WorkRef = {
  kind: UnitRef["kind"];
  issueNumber?: number;
  pullRequestNumber?: number;
  branch?: string;
};

function workRefFromRef(ref: UnitRef): WorkRef {
  const base: WorkRef = { kind: ref.kind, ...(ref.branch ? { branch: ref.branch } : {}) };
  return ref.target.type === "pr"
    ? { ...base, pullRequestNumber: ref.target.number }
    : { ...base, issueNumber: ref.target.number };
}

/**
 * The `lifecycle.reason` prefix for a "draining" transition — distinguishes a
 * ref-change drain (`phoebe boot`'s reconcile watch, REF_CHANGE_DRAIN_SIGNAL)
 * from a plain container stop (SIGTERM), so an operator reading the status
 * snapshot can tell "about to relaunch on the new commit" from "shutting
 * down" (#23).
 */
function drainReason(drain: DrainSignal, detail: string): string {
  const cause = drain.signal === REF_CHANGE_DRAIN_SIGNAL ? "Engine ref changed" : "Drain requested";
  return `${cause} — ${detail}`;
}

/**
 * Drive the Phoebe worker loop until it exits (persistent mode) or completes
 * one unit (`--run-once`). Called by src/commands/engine.ts after it resolves
 * the consumer's phoebe.config.ts; the caller passes argv with `--config
 * <path>` already stripped so this only sees engine-level flags.
 */
export async function runEngine(opts: {
  config: PhoebeConfig;
  argv?: readonly string[];
}): Promise<void> {
  const { config } = opts;
  const argv = opts.argv ?? process.argv.slice(2);

  // Whole-unit wall-clock budget (#72): the agent phase — the async, hang-prone
  // step — runs under this deadline, so a hung unit releases its #59 slot within
  // a known ceiling instead of starving the fleet. `PHOEBE_RUN_TIMEOUT_MS` is
  // already folded into `config.runTimeoutMs` by the env overlay (#56).
  const RUN_TIMEOUT_MS = config.runTimeoutMs;

  const inContainer = isInsideContainer();
  // On the host only selection/--dry-run runs, against the local checkout; in
  // the container all git state lives in the private clone on the named volume.
  const repoDir = inContainer ? config.paths.repoDir : process.cwd();
  const worktreesDir = config.paths.worktreesDir;

  // One process per tenant (#62): every line this engine prints carries its
  // slug, so a host log collector multiplexing N repos onto one container's
  // stdout can attribute each line back to a repo.
  const { phoebeLog, phoebeError } = createPhoebeLog(config.repoSlug);

  // Every `gh` call the engine makes goes through this one client (#41/#50).
  const github: GitHub = createGitHub({
    repoSlug: config.repoSlug,
    timeoutMs: CHILD_PROCESS_TIMEOUT_MS,
  });

  const workOrder = validateWorkOrder(config.workOrder);

  // Before anything else, and before a dry run too: a prompt this tenant cannot
  // load is a startup failure, not a surprise weeks later when the first unit of
  // that kind is dispatched (#164). Scoped to the validated `workOrder` — only
  // the kinds this tenant can actually dispatch need a prompt.
  assertPromptFilesExist(config, process.cwd(), workOrder);

  const stackConfig: StackConfig = {
    blockedByPattern: config.blockedByPattern,
    blockerSource: config.blockerSource,
    branchPrefix: config.branchPrefix,
    stackMode: config.stackMode,
  };

  // ---------------------------------------------------------------------------
  // `io` construction — every impure capability a kind factory closes over.
  // This is the ONLY place in the engine that spawns `git`/`gh` child processes
  // or reads prompt files off disk; every kind reaches them only through `io`.
  // ---------------------------------------------------------------------------

  /** `gh <args> -R <repoSlug>` — the one raw escape hatch left, kept for `ensure-labels.ts`'s injection point. */
  function gh(args: string[], ghOpts?: { input?: string }): void {
    defaultGhRun([...args, "-R", config.repoSlug], {
      stdio: "inherit",
      ...(ghOpts?.input !== undefined ? { input: ghOpts.input } : {}),
    });
  }

  function buildGitOps(): GitOps {
    return {
      fetchOrigin: () => gitFetchOrigin(repoDir),
      originBranchSha: (branch: BranchRef) => gitOriginBranchSha(repoDir, branch),
      prepareWorktree: (prepareOpts: { branch: BranchRef; baseRef?: string }) => {
        const worktreeDir = worktreeDirForBranch(worktreesDir, prepareOpts.branch);
        removeWorktree(repoDir, worktreeDir);
        if (prepareOpts.baseRef) {
          addWorktreeForNewBranch({
            repoDir,
            worktreeDir,
            branch: prepareOpts.branch,
            baseRef: prepareOpts.baseRef,
          });
        } else {
          addWorktreeForExistingBranch({ repoDir, worktreeDir, branch: prepareOpts.branch });
        }
        return worktreeDir;
      },
      removeWorktree: (worktreeDir: string) => removeWorktree(repoDir, worktreeDir),
      // #168: every kind's push funnels through this one binding — the choke
      // point where a push is counted toward the hourly budget the loop checks
      // before selection, below.
      pushBranch: (worktreeDir: string, branch: BranchRef) => {
        pushBranch(worktreeDir, branch);
        recordPush(config.paths.stateDir, new Date());
      },
      commitCount: (worktreeDir: string, range: string) => commitCount(worktreeDir, range),
      gitInWorktree,
    };
  }

  function buildPrompts(): Prompts {
    return {
      load: (relativePath: string) => loadPromptTemplateFromRoot(relativePath, process.cwd()),
      defaultArgs: () => buildDefaultPromptArgs(config),
      render: (template, args, worktreeDir) =>
        renderPrompt(template, args, promptShell(worktreeDir)),
    };
  }

  /**
   * Bound the *agent phase* by the run budget (#72) — the one phase where a hang
   * is abortable (the agent respects the `AbortSignal`); install/test run via
   * `execSync` outside this deadline. On expiry the deadline aborts the signal,
   * `runAgent` kills the child, and a `RunTimeoutError` propagates — caught at
   * the unit boundary (the loop logs it, releases the #59 slot in `finally`,
   * and continues; #75 counts it toward quarantine).
   */
  async function runAgentInWorktree(agentOpts: {
    worktreeDir: string;
    prompt: string;
    labels?: readonly string[];
  }): Promise<{ exitCode: number; usage?: AgentUsage; costUsd?: number }> {
    const tier = classifyTier(agentOpts.labels ?? []);
    const { provider, model, effort } = selectProvider({ config, env: process.env, tier });
    // #170: one trace per agent run, so the agent CLI's own spans (e.g.
    // Claude Code's `claude_code.interaction` tree) are attributable to this
    // Phoebe unit instead of landing in an unrelated or absent trace.
    const env = buildAgentEnv({
      parentEnv: { ...process.env, TRACEPARENT: generateTraceparent() },
      provider: provider.name,
      providerEnv: config.providerEnv,
    });
    const { exitCode, usage, costUsd } = await runWithDeadline({
      ms: RUN_TIMEOUT_MS,
      work: (signal) =>
        runAgent({
          provider,
          model,
          effort,
          prompt: agentOpts.prompt,
          cwd: agentOpts.worktreeDir,
          env,
          signal,
        }),
    });
    if (exitCode !== 0) {
      phoebeLog(`Agent exited with code ${exitCode}.`);
    }
    return {
      exitCode,
      ...(usage !== undefined ? { usage } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }

  function buildAgentRunner(): AgentRunner {
    return { run: runAgentInWorktree };
  }

  // Built ahead of `io` (rather than beside the rest of the loop setup below)
  // solely so `quarantine`'s `report` can route a quarantine/un-quarantine
  // line through the one status rail (#70/#60) instead of a bare log call.
  const selectedProvider = selectProvider({ config, env: process.env });
  const contractContext = buildRuntimeContractContext({
    config,
    providerName: selectedProvider.provider.name,
    model: selectedProvider.model,
    runtimeRoot: process.cwd(),
    env: process.env,
  });
  const status = createRuntimeStatusReporter({
    ...(inContainer ? { stateDir: config.paths.stateDir } : {}),
    ...(process.env["PHOEBE_RUNTIME_ID"] ? { runtimeId: process.env["PHOEBE_RUNTIME_ID"] } : {}),
    ...contractContext,
    onWriteError: (error) =>
      phoebeError(
        `Runtime telemetry write failed — ${
          error instanceof Error ? error.message : String(error)
        }. Work will continue.`,
      ),
  });

  const io: Io = {
    github,
    git: buildGitOps(),
    agent: buildAgentRunner(),
    prompts: buildPrompts(),
    shell: buildShell(),
    quarantine: createQuarantine({ github, config, log: phoebeLog, report: status.record }),
  };

  const kindDeps: KindDeps = { config, io };

  const kindHandles: readonly KindHandle[] = [
    boxKind(createConflictsKind(kindDeps)),
    boxKind(createChecksKind(kindDeps)),
    boxKind(createReviewsKind(kindDeps)),
    boxKind(createIssuesKind(kindDeps)),
    boxKind(createResearchKind(kindDeps)),
  ];

  /**
   * One-time, native-mode-only setup on the private clone: pre-set the
   * non-interactive git config gh-stack and cascade-rebase expect, then install
   * the gh-stack extension. Idempotent and best-effort — `gh extension install`
   * errors when the extension is already present, which we swallow. Run at boot
   * (guarded by `stackMode === 'native'`) rather than baked into the image, so the
   * default banner/off image carries no gh-stack dependency and needs no
   * build-time network or auth to install it.
   */
  function prepareNativeStackTooling(): void {
    for (const args of nativeStackGitConfig()) {
      gitInWorktree(repoDir, [...args]);
    }
    try {
      github.installStackExtension();
    } catch (error) {
      phoebeError(
        `gh-stack extension not installed (already present, or offline at boot). ` +
          `Native stacking needs it — install with \`gh ${ghStackExtensionInstallArgs().join(" ")}\`. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  /** The PR a just-finished unit is now known by — direct for PR-keyed kinds, resolved for issue-keyed ones. */
  function pullRequestNumberAfterWork(ref: UnitRef): number | undefined {
    if (ref.target.type === "pr") {
      return ref.target.number;
    }
    if (!ref.branch) {
      return undefined;
    }
    try {
      return github.prNumberForHead(ref.branch, "open");
    } catch (error) {
      phoebeError(
        `Could not resolve the PR link for ${ref.branch} — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  async function runLoop({
    runOnce,
    dryRun,
    pollIntervalMs,
    drain,
    status,
    slotClient,
  }: {
    runOnce: boolean;
    dryRun: boolean;
    pollIntervalMs: number;
    drain: DrainSignal;
    status: ReturnType<typeof createRuntimeStatusReporter>;
    slotClient: SlotClient | null;
  }): Promise<void> {
    while (true) {
      if (drain.requested) {
        status.record({
          kind: "draining",
          reason: drainReason(drain, "starting no new work unit."),
        });
        break;
      }

      status.record({ kind: "selecting" });
      const runtimeId = status.snapshot().runtime.runtimeId;
      const ctx = await gatherCycleContext(
        { config, io, runtimeId, error: phoebeError },
        kindHandles,
      );

      // #15/#13 per-cycle self-recovery and stack maintenance: every kind's own
      // `sweep` runs against the ctx just gathered, container + non-dry-run only,
      // before selection — the loop stays ignorant of which kinds have one.
      // #69's auto-un-stick sweep lives beside these for the same reason but is
      // not one of them — one label query across all kinds, not a per-kind hook.
      if (inContainer && !dryRun) {
        io.quarantine.sweepUnstuck();
        for (const kind of kindHandles) {
          await kind.sweep?.(ctx);
        }
      }

      // #20: publish the resolved `issues` lookahead — every eligible issue in
      // selection order with its full blocker set, not just the one about to be
      // picked — so an observer can see what comes after `activeWork`.
      status.setQueue(
        buildIssueQueue(
          ctx.pools.ready,
          ctx.blockerStates,
          stackConfig,
          config.priorityLabelPrefix,
          process.env["PHOEBE_BASE"],
          ctx.nativeBlockers,
        ),
      );

      // #165: a spent daily cost budget idles the whole cycle rather than
      // narrowing kinds the way the hourly push budget does below — every kind
      // can spend on an agent run (not just the janitor ones the push budget
      // targets), so the only hard stop that actually caps the fleet's daily
      // bill is skipping selection entirely until the UTC day rolls over.
      const dailyCostCap = config.dailyCostCapUsd;
      if (dailyCostBudgetExhausted(config.paths.stateDir, dailyCostCap, new Date())) {
        const reason = `Daily cost cap ($${dailyCostCap.toFixed(2)}, PHOEBE_DAILY_COST_CAP_USD) reached — idling until the UTC day rolls over.`;
        phoebeLog(reason);
        status.record({ kind: "idle", reason });
        if (runOnce || dryRun) break;
        await drain.wait(pollIntervalMs);
        continue;
      }

      const orderedKinds = workOrder
        .map((name) => kindHandles.find((k) => k.name === name))
        .filter((k): k is KindHandle => k !== undefined);

      // #168: a spent hourly push budget excludes the janitor kinds
      // (conflicts/checks/reviews — the ones that push to *existing* PR
      // branches on every sweep, the cost driver this bounds) from selection
      // for the rest of the hour, reusing the same one-shot-eligible filter
      // `--run-once` already uses. Falling through to the producer kinds
      // (issues/research) rather than idling the whole cycle is the
      // deliberate choice: it caps PR-churn cost without also starving
      // brand-new issue pickup behind it (see docs/work-kinds.md's
      // starvation tradeoff, which this reuses rather than duplicates).
      const pushBudgetSpent = pushBudgetExhausted(
        config.paths.stateDir,
        config.maxPushesPerHour,
        new Date(),
      );
      if (pushBudgetSpent) {
        phoebeLog(
          `Push budget spent (${config.maxPushesPerHour}/hour) — skipping conflicts/checks/reviews this cycle.`,
        );
      }
      const fetchKinds = runOnce || pushBudgetSpent ? oneShotEligible(orderedKinds) : orderedKinds;

      const gathered = await gatherFetchPhase(fetchKinds, ctx, {
        secrets: contractContext.secrets,
        record: status.record,
      });
      if (gathered === null) {
        // A quota/rate-limit GitHub failure somewhere in this cycle's fetch
        // phase (#162) — most notably a 403 off the reviews kind's identity
        // check when the configured credential's rate limit is exhausted.
        // `gatherFetchPhase` already recorded the backoff; skip to the next
        // poll exactly as an idle cycle would, discarding whatever this cycle
        // gathered (the next cycle refetches cleanly).
        if (runOnce || dryRun) break;
        await drain.wait(pollIntervalMs);
        continue;
      }

      const picked = pickFirstPlan(gathered, ctx);

      if (!picked) {
        const idleReason = runOnce ? RUN_ONCE_NOTHING_MESSAGE : pickFirstIdleReason(gathered);
        status.record({ kind: "idle", reason: idleReason ?? "No work this cycle — idle." });
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
        status.record({
          kind: "draining",
          reason: drainReason(drain, "starting no new work unit."),
        });
        break;
      }

      const decision = executionDecision({ dryRun, inContainer });
      if (decision === "dry-run") {
        status.record({ kind: "idle", reason: `Would execute: ${picked.describe()}.` });
        break;
      }
      if (decision === "refuse") {
        status.record({ kind: "engine-failed", error: EXECUTION_REFUSED_MESSAGE });
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
            phoebeError(`${error.message} — stopping this engine.`);
            break;
          }
          throw error;
        }
      }
      status.record({ kind: "work-started", work: workRefFromRef(picked.ref) });
      try {
        const { exitCode: agentExitCode, verification, usage, costUsd } = await picked.execute(ctx);
        const pullRequestNumber = pullRequestNumberAfterWork(picked.ref);
        const resourceExtras = {
          ...(usage !== undefined ? { usage } : {}),
          ...(costUsd !== undefined ? { costUsd } : {}),
        };
        // #165: a run that reports a cost above `runCostCapUsd` is recorded as a
        // failure even on a clean agent exit — the spend already happened (the
        // stream only reports cost on the terminal event, so nothing short of
        // killing the child mid-run could have stopped it), but flagging it
        // loudly and routing it through the same retryable-failure path as a
        // nonzero exit means a unit that repeatedly blows the cap rides the
        // existing quarantine machinery instead of burning tokens forever.
        const runCostCap = config.runCostCapUsd;
        const capExceeded = runCostCap > 0 && costUsd !== undefined && costUsd > runCostCap;
        if (agentExitCode !== null && agentExitCode !== 0) {
          status.record({
            kind: "work-failed",
            error: new Error(`Agent exited with code ${agentExitCode}.`),
            ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
            ...(verification ? { verification } : {}),
            resources: {
              agentExitCode,
              ...resourceExtras,
              summary: "The work unit completed its cleanup after a nonzero agent exit.",
            },
          });
        } else if (capExceeded) {
          status.record({
            kind: "work-failed",
            error: new Error(
              `Agent run failed its per-run cost cap: cost $${costUsd.toFixed(2)} exceeded the ` +
                `$${runCostCap.toFixed(2)} PHOEBE_RUN_COST_CAP_USD limit.`,
            ),
            ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
            ...(verification ? { verification } : {}),
            resources: {
              ...(agentExitCode !== null ? { agentExitCode } : {}),
              ...resourceExtras,
              summary: "The work unit exceeded its per-run cost cap.",
            },
          });
        } else {
          status.record({
            kind: "work-completed",
            ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
            ...(verification ? { verification } : {}),
            ...(agentExitCode === null
              ? {}
              : {
                  resources: {
                    agentExitCode,
                    ...resourceExtras,
                    summary: "The work unit completed after a successful agent run.",
                  },
                }),
          });
        }
      } catch (error) {
        if (error instanceof RunTimeoutError) {
          // A whole-unit timeout (#72): the agent was killed, the slot releases in
          // `finally`, and the engine survives (never told to the supervisor, #60
          // orthogonality). #75/#68 layer the poison-unit quarantine on this event —
          // consecutive timeouts on the same unit, at K, get a `phoebe:quarantined`
          // label + escalation comment so a genuinely poisonous unit stops being
          // re-picked forever.
          status.record({ kind: "work-timed-out", elapsedMs: error.elapsedMs });
          io.quarantine.record(picked.ref, "timed-out", {
            signature: "timeout",
            reason: "timed out",
            belowThresholdNote: () => "",
          });
        } else {
          // A non-timeout failure: clear the current unit and record the error so
          // `phoebe list` shows it (the durable record is still the per-work-kind
          // watermark/failure-comment on GitHub; this is the at-a-glance snapshot).
          status.record({ kind: "work-failed", error });
        }
        if (runOnce) {
          throw error;
        }
        // A failed unit must not kill the daemon — `prepareWorktree` clears any
        // stale worktree on the next attempt.
        phoebeError(
          `Failed executing ${picked.describe()} — ${error instanceof Error ? error.message : String(error)}`,
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
        status.record({
          kind: "draining",
          reason: drainReason(drain, "the in-flight unit finished."),
        });
        break;
      }
    }
  }

  const runOnce = argv.includes("--run-once");
  const dryRun = argv.includes("--dry-run");
  const rawPollIntervalMs = Number(process.env["PHOEBE_POLL_INTERVAL_MS"]);
  const pollIntervalMs =
    Number.isFinite(rawPollIntervalMs) && rawPollIntervalMs > 0
      ? rawPollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
  phoebeLog(
    runOnce
      ? "Run-once mode — will work at most one unit of the first one-shot-eligible kind in WORK_ORDER, then exit."
      : `Persistent mode — idle poll every ${pollIntervalMs}ms. SIGTERM drains: finish the current unit, then exit 0.`,
  );
  if (dryRun) {
    phoebeLog("Dry-run — selection only, nothing executes.");
  }

  // Bootstrap the private clone every work unit fetches/worktrees against. Only
  // in the container (on the host repoDir is the cwd, already a repo) and never
  // for --dry-run (selection uses the GitHub API, not a local clone). No-op once
  // the clone exists, so it's safe on every daemon restart.
  if (inContainer && !dryRun) {
    ensureClone({ repoUrl: config.repoUrl, repoDir });
    // Native stacking needs the gh-stack extension + non-interactive git config
    // on the clone. Guarded so banner/off runs pull in no gh-stack dependency.
    if (config.stackMode === "native") {
      prepareNativeStackTooling();
    }
    // #67: create every Phoebe-owned label before anything writes it. Once per
    // process, not per write — `gh label create --force` is idempotent, so
    // this is safe on every daemon restart, and it must land before the
    // startup reclaim below, which flips `processingLabel`/`readyLabel`.
    ensureLabels(phoebeLabelSet(config), gh);
    // #15 startup self-recovery: a fresh process start is proof any claim this
    // persisted runtime id still holds is dead (it cannot still be mid-run),
    // so reclaim those unconditionally rather than waiting out the lease TTL.
    await reclaimStaleClaims(kindDeps, {
      runtimeId: status.snapshot().runtime.runtimeId,
      forceOwnReclaim: true,
    });
  }

  // `phoebe boot` stops the engine with SIGTERM (container shutdown, and later a
  // config/ref change). Drain gracefully rather than dying mid-unit: finish the
  // unit in flight, start no new one, then return (exit 0). The wait below wakes
  // early on drain so an idle poll-sleep does not stall shutdown.
  // The supervisor's concurrency broker (#59): when this engine was forked with
  // an IPC channel, `slotClient` requests a slot per work unit and blocks until
  // the supervisor grants one. A standalone engine (no channel) gets null here
  // and runs unbrokered — it is already serialized to one unit.
  const slotClient = createSlotClient({
    send: process.send?.bind(process),
    on: (event, listener) => {
      process.on(event, listener);
    },
    off: (event, listener) => {
      process.off(event, listener);
    },
    connected: process.connected,
  });

  const drain = installDrainSignal(process, ["SIGTERM", REF_CHANGE_DRAIN_SIGNAL]);
  let failed = false;
  try {
    await runLoop({ runOnce, dryRun, pollIntervalMs, drain, status, slotClient });
  } catch (error) {
    failed = true;
    status.record({ kind: "engine-failed", error });
    throw error;
  } finally {
    if (!failed) status.record({ kind: "stopped" });
    drain.dispose();
  }
}
