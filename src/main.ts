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
import { mkdirSync, rmSync } from "node:fs";
import { DEFAULT_PIPELINE_NAME, type PhoebeConfig } from "./config-schema.ts";
import { selectProviderForKind } from "./provider-selection.ts";
import { parsePipelineName, pipelineRow, resolvePollIntervalMs } from "./pipeline-row.ts";
import { detectAppCredentials, mintInstallationToken } from "./gh-app.ts";
import { asBranchRef, asPrNumber, type BranchRef, type PrNumber } from "./branded.ts";
import {
  createGitHubClient,
  type FeatureIntegrationPr,
  type GitHubClient,
  type QuarantinedUnit,
  type StackedPhoebePr,
  type UnitTarget,
} from "./github-client.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { buildInstallCommandEnv, buildPromptShellEnv } from "./shell-env.ts";
import { installDrainSignal, type DrainSignal } from "./drain.ts";
import {
  BrokerDisconnectedError,
  createCredentialClient,
  CredentialLeaseTimedOutError,
  CredentialRefreshBlockedError,
  type CredentialClient,
} from "./credential-client.ts";
import { createSlotClient, type SlotClient } from "./slot-client.ts";
import {
  RunTimeoutError,
  resolveRunTimeoutMs,
  resolveRunTimeoutMsForKind,
  runWithDeadline,
} from "./run-timeout.ts";
import {
  createEmitUnitEvent,
  createEngineLog,
  statusPathFor,
  type EmitUnitEvent,
  type EngineLog,
  type UnitRef,
} from "./unit-event.ts";
import {
  buildQuarantineComment,
  buildUnitTimeoutMarker,
  buildUnstickComment,
  decideAutoUnstick,
  decideTimeoutRecord,
  latestTimeoutMarker,
  loginMismatchWarning,
  PHOEBE_QUARANTINE_LABEL,
  resolveMaxUnproductiveRuns,
} from "./quarantine.ts";
import { join } from "node:path";
import {
  EXECUTION_REFUSED_MESSAGE,
  executionDecision,
  isInsideContainer,
} from "./execution-gate.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import {
  breakOwnLeases,
  createOriginHub,
  ensureOriginClone,
  requiresOriginClone,
  type OriginHub,
} from "./origin-hub.ts";
import { formatLeaseReason, WorktreeLeasedError } from "./worktree-lease.ts";
import { withCloneLock } from "./clone-lock.ts";
import { sweepScope, type SweepScope } from "./sweep-scope.ts";
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
  parseIssueNumberFromBranch,
  stackedPrComment,
  RUN_ONCE_NOTHING_MESSAGE,
  validateWorkOrder,
  type BlockerPrState,
  type Issue,
  type StackedOn,
} from "./orchestrator.ts";
import { featureBranch, resolveFeature, type Feature } from "./feature-branch.ts";
import { memberIssueNumber, withClosesSection } from "./feature-closes.ts";
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
  WorkspaceHandle,
  WorkUnitGitHubTarget,
} from "./work-kinds/definition.ts";
import {
  assertDeclaredEnvPresent,
  declaredEnvKeys,
  missingDeclaredEnv,
  type DeclaringKind,
} from "./work-kinds/declared-env.ts";
import { buildRegistry, type WorkKindRegistry } from "./work-kinds/registry.ts";
import {
  NONE_WORKABLE,
  oneShotWorkKinds,
  registeredKind,
  selectWorkUnits,
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
 * Run a configured toolchain command (a shell string) inside a worktree. The
 * worktree may sit at a PR branch head, so the env drops the engine's own
 * credentials and every key this row's kinds declared — the branch's install
 * hooks run as this child (see shell-env.ts).
 */
function runShellCommand(
  command: string,
  cwd: string,
  parentEnv: NodeJS.ProcessEnv,
  providerKeys: readonly string[],
  declaredKeys: readonly string[],
): void {
  execSync(command, {
    cwd,
    env: buildInstallCommandEnv(parentEnv, providerKeys, declaredKeys),
    stdio: "inherit",
    timeout: SHELL_COMMAND_TIMEOUT_MS,
  });
}

/** Shell executor for prompt !`...` expansion — captures stdout. */
function promptShell(
  cwd: string,
  parentEnv: NodeJS.ProcessEnv,
  providerKeys: readonly string[],
  declaredKeys: readonly string[],
): (command: string) => string {
  return (command) =>
    execSync(command, {
      cwd,
      env: buildPromptShellEnv(parentEnv, providerKeys, declaredKeys),
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
  /**
   * How many units this row may hold in flight at once (#422) — the pipeline's
   * declared `concurrency`. Defaults to 1, which is the serial loop; `runOnce`
   * pins it there whatever the row says.
   */
  concurrency?: number;
};

export type EngineOptions = {
  /** This tenant's resolved config — passed in, never read from a module-level holder. */
  config: PhoebeConfig;
  /**
   * Which pipeline row this engine is (#415/#418). It is the process's identity
   * on disk and in the logs: the stdout tag's third segment, the `state/`
   * subdirectory its snapshot lives in, and the owner stamped on every worktree
   * lease it takes. Defaults to the reserved `work` row, which is what an
   * engine built before pipelines existed already was.
   */
  pipeline?: string;
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
  /**
   * Whether this process may execute work units — the container-marker check
   * (src/execution-gate.ts), which is also what decides whether the origin hub
   * works a private clone or the host repo. Defaults to reading the real
   * marker; a cycle test overrides it to drive an executing run on the host.
   */
  inContainer?: boolean;
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
 * marker (unless `inContainer` is given) and `process.cwd()` (the host repo dir
 * and the prompt root).
 */
export function createEngine(options: EngineOptions): Engine {
  const { config, env, drain, slotClient, credentialClient, emitUnitEvent } = options;
  const { runOnce, dryRun, pollIntervalMs } = options.run;
  // `--run-once` means one unit, so it pins the row's concurrency to 1 rather
  // than honouring a declaration that would have it admit several and then
  // exit after the first (#422).
  const concurrency = runOnce ? 1 : Math.max(1, Math.floor(options.run.concurrency ?? 1));
  const pipeline = options.pipeline ?? DEFAULT_PIPELINE_NAME;
  // Every line this engine writes carries `[phoebe:<slug>:<pipeline>]` (#418).
  // With two processes on one tenant interleaving at the kernel, an untagged
  // line is a line the operator cannot attribute — and the `work` row is tagged
  // like any other so a host parser has one grammar to match, as a prefix.
  const log: EngineLog = createEngineLog(config.repoSlug, pipeline);
  const registry = options.registry ?? buildRegistry(config);
  const git = options.git ?? defaultGit;
  const clock = options.clock ?? defaultClock;
  // Every `gh` call the engine makes goes through this client
  // (src/github-client.ts): argv, the `-R <repoSlug>` pin, GraphQL pagination,
  // the merge-state retry and `gh`-error enrichment are all its business, not
  // the loop's. A caller that supplies its own replaces the whole GitHub side.
  const github = options.github ?? createGitHubClient({ config, env, tag: log.tag });

  const startupGhToken: string | undefined = env["GH_TOKEN"];

  function resolveArm(): CredentialArm {
    return startupGhToken ? "pat" : "app";
  }

  let lastLoggedArm: CredentialArm | null = null;

  function logArmIfChanged(arm: CredentialArm): void {
    if (arm !== lastLoggedArm) {
      log.say(`Credential arm: ${arm}.`);
      lastLoggedArm = arm;
    }
  }

  // Whole-unit wall-clock budget (#72): the agent phase — the async, hang-prone
  // step — runs under this deadline, so a hung unit releases its #59 slot within
  // a known ceiling instead of starving the fleet. Resolved per kind (#415), on
  // the ladder in run-timeout.ts: per-kind env, the kind's `runTimeoutMs`,
  // `PHOEBE_RUN_TIMEOUT_MS`, then the tenant field.
  const runTimeoutMsFor = (kind: string): number =>
    resolveRunTimeoutMsForKind({
      kind,
      env,
      workKinds: config.workKinds,
      configValue: config.runTimeoutMs,
    });
  // Lease budget sent to the supervisor: the longest budget any kind here can
  // claim, plus ten minutes for the install/push phases that follow the agent
  // inside the same unit. Taken across every registered kind rather than the
  // tenant number alone, so a kind that raised its own budget cannot outlive the
  // credential it was handed. Only the child resolves this — env-over-config
  // precedence lives engine-side, and a supervisor that computed it
  // independently would duplicate and drift.
  const credentialBudgetMs =
    Math.max(
      ...[...registry.keys()].map(runTimeoutMsFor),
      resolveRunTimeoutMs(env, config.runTimeoutMs),
    ) +
    10 * 60 * 1000;

  const prBase = config.defaultBranch;

  const inContainer = options.inContainer ?? isInsideContainer();
  const hub =
    options.originHub ??
    createOriginHub(config, inContainer, git, { warn: (line) => log.warn(line) });

  /** This process's lease stamp on any tree it creates (#418). */
  const leaseReason = formatLeaseReason({ pipeline, pid: process.pid });

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

  // Which tracker objects this pipeline's sweeps may touch (#418). Partition by
  // ownership: a sweep repairs an object only when the kind that object belongs
  // to is one this row schedules, which is what gives two processes exactly-once
  // coverage with nothing to elect and nothing to fail over.
  const scope: SweepScope = sweepScope(workOrder, config.researchLabel);

  // Whether any scheduled kind puts a workspace on the clone (#418). A row of
  // `scratch` kinds owns no worktrees, so it has no leases to break at boot and
  // no reason to touch git at all.
  const usesRepoWorkspace = requiresOriginClone(
    workOrder,
    (kind) => registeredKind(registry, kind).definition.workspace,
  );

  /** The scheduled kinds paired with their definitions, for the declared-key rules. */
  const scheduledKinds = (kinds: readonly string[] = workOrder): DeclaringKind[] =>
    kinds.map((kind) => ({ name: kind, definition: registeredKind(registry, kind).definition }));

  /**
   * Every key this row's scheduled kinds declared (#425) — the row's `env`, as
   * the enumerator reports it to the supervisor. The consumer toolchain never
   * sees these: `installCommand` and prompt `!` expansions run with all of them
   * stripped, and only the agent hop reopens, per kind, for `agentEnv`.
   */
  const rowDeclaredEnv = declaredEnvKeys(scheduledKinds());

  /**
   * The kinds this cycle may actually gather: the work order minus any kind
   * whose declared key this row cannot read. Boot already refused that state
   * fatally (`assertDeclaredEnvPresent`), so this is the *hot* arm — a kind
   * switched on against a key nobody added stays off, loudly and once, and the
   * row keeps working everything else.
   */
  const loggedMissingEnv = new Set<string>();
  const schedulableKinds = (kinds: readonly string[]): readonly string[] => {
    const missing = missingDeclaredEnv(scheduledKinds(kinds), env);
    if (missing.length === 0) return kinds;
    for (const { kind, key } of missing) {
      if (loggedMissingEnv.has(`${kind}\0${key}`)) continue;
      loggedMissingEnv.add(`${kind}\0${key}`);
      console.error(
        `[phoebe] Work kind "${kind}" declares ${key}, which this pipeline's env does not ` +
          `hold — the kind stays off until the key is set. Every other kind keeps running.`,
      );
    }
    const off = new Set(missing.map((m) => m.kind));
    return kinds.filter((kind) => !off.has(kind));
  };

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
   * Record one whole-unit timeout toward the poison-unit quarantine (#75) for
   * PR-shaped units (`conflicts`, `checks`, `reviews`). Issue-shaped units are
   * counted by the stranded-unit sweep instead (#367), which owns the counter
   * for anything that carries a queue label. Best-effort — a GitHub write
   * failure here is logged and swallowed so it can never take the daemon down.
   *
   * The write target is the unit's structural `github` field (#352): a unit
   * without one gets in-memory counting and a logged no-escalation-surface
   * degraded behavior instead of a crash.
   */
  function recordUnitTimeout(picked: PickedWorkUnit, emit: EmitUnitEvent): void {
    const ref = unitRefOf(picked);
    const ghTarget: WorkUnitGitHubTarget | undefined = picked.unit.github;
    if (!ghTarget) {
      const key = `${ref.kind}:${ref.id}`;
      const count = (inMemoryTimeoutCounts.get(key) ?? 0) + 1;
      inMemoryTimeoutCounts.set(key, count);
      log.warn(
        `${ref.kind} ${ref.id} timed out ${count}× — the unit carries no GitHub ` +
          `target, so there is no escalation surface; counting in memory only.`,
      );
      return;
    }
    const target: UnitTarget = ghTarget;
    // Issue-shaped units (issues/research) carry processingLabel, which the
    // stranded-unit sweep detects and counts. PR-shaped units do not, so they
    // are counted here on timeout.
    if (target.objectType === "issue") return;
    try {
      // Phoebe's own login, resolved per write rather than cached: there is
      // deliberately no placeholder for an unresolved login (`""` would be a
      // login like any other, and is what a deleted account's login used to
      // read as), so Phoebe's own timeout markers cannot read as foreign
      // activity, nor a ghost's comment as Phoebe's. The lookups this covers
      // are rare, so paying for one beats carrying a value that can lie.
      const login = github.resolveLogin(env["PHOEBE_GH_LOGIN"]);
      const k = resolveMaxUnproductiveRuns(env, config.maxUnproductiveRuns);
      const inputs = github.prTimeoutInputs(asPrNumber(target.id));
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
      log.fail(
        `Could not record timeout toward quarantine for ${ref.kind} ${ref.id} — ` +
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
    // Scoped to what this pipeline schedules (#418): a row of PR janitors does
    // not list quarantined issues, and a row of issue producers does not list
    // quarantined PRs. A row that schedules neither shape lists nothing and the
    // sweep is empty, which is the correct amount of work for it to do.
    if (!scope.issues && !scope.prs) return;
    let quarantined: QuarantinedUnit[];
    try {
      quarantined = [
        ...(scope.issues ? github.listQuarantinedIssues() : []),
        ...(scope.prs ? github.listQuarantinedPrs() : []),
      ];
    } catch (error) {
      log.fail(
        `Could not list quarantined units for the ${sweepName} sweep — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const unit of quarantined) {
      // Never repair an object this pipeline is running (#422).
      if (targetInFlight(unit.target)) continue;
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
        log.say(`Un-quarantined ${label} — ${because}`);
      } catch (error) {
        log.fail(
          `Could not un-quarantine ${label} — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * The live feature a Phoebe issue belongs to, read straight from GitHub.
   * The sweeps run before the cycle's memoized reader exists, and they ask only
   * about the handful of PRs they are about to touch, so the reads are cheap.
   * `undefined` means the graph could not be read — distinct from `null`, which
   * means the graph was read and the issue belongs to no feature. Callers must
   * not treat an unreadable graph as "no feature": doing so can retarget a real
   * feature member onto the default branch on a transient GitHub failure.
   */
  function featureForIssue(issueNumber: number): Feature | null | undefined {
    let unreadable = false;
    const feature = resolveFeature(issueNumber, {
      issueGraphNode: (n) => {
        try {
          return github.issueGraphNode(n);
        } catch (error) {
          unreadable = true;
          log.warn(
            `Could not read feature membership at #${n} — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      },
      featureIntegrationPr: (n) => {
        try {
          return { pr: github.featureIntegrationPr(n) };
        } catch (error) {
          unreadable = true;
          log.warn(
            `Could not read the integration PR for feature #${n} — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      },
    });
    return feature ?? (unreadable ? undefined : null);
  }

  /**
   * Remove each open Phoebe PR that is natively stacked on a blocker branch
   * whose issue closed as completed without the blocker's PR merging. Once
   * that issue is done the stack's bottom layer is dead: GitHub will never
   * merge-and-retarget through it. The fix is to leave the stack and retarget
   * the PR onto the branch it was always bound for so it can merge on its own
   * terms — the default branch, or the feature branch when the PR belongs to a
   * live feature (#383).
   *
   * Mirrors `sweepQuarantine` in style: best-effort, one PR's failure does not
   * stop the rest, never runs under `--dry-run`.
   */
  function sweepStaleNativeStacks(): void {
    // The stacks this repairs are built by the issue producers, in
    // `issueWorkflow`; a row that runs none of them owns none of these PRs (#418).
    if (!scope.issues) return;
    let stackedPrs: StackedPhoebePr[];
    try {
      stackedPrs = github.listNativelyStackedPrs();
    } catch (error) {
      log.fail(
        `Could not list natively stacked PRs for the stale-stack sweep — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const pr of stackedPrs) {
      // Never repair an object this pipeline is running (#422).
      if (targetInFlight({ objectType: "pr", id: pr.number })) continue;
      const blockerIssueNumber = parseIssueNumberFromBranch(pr.baseRefName);
      if (blockerIssueNumber === null) continue;
      let blockerState: BlockerPrState;
      try {
        blockerState = github.blockerPrState(blockerIssueNumber);
      } catch (error) {
        log.fail(
          `Could not read blocker state for #${blockerIssueNumber} (stale-stack sweep) — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!blockerState.blockerCompleted) continue;
      try {
        const outcome = github.unstackPr(pr.number);
        if (!outcome.unstacked) {
          if (outcome.reason !== "not-in-stack") {
            log.fail(`Could not unstack PR #${pr.number} — ${outcome.reason}`);
            continue;
          }
          // PR has a Phoebe-branch base but is no longer in a native stack — its
          // stack was dissolved earlier this cycle (by processing another member)
          // or in a prior cycle. Fall through and retarget it anyway.
        } else {
          log.say(
            `PR #${pr.number} removed from stack #${outcome.stackNumber} — ` +
              `blocker #${blockerIssueNumber} completed without merging its PR.`,
          );
        }
        // A member of a live feature goes back onto the feature branch, never
        // onto the default branch: that is where its work is bound, and where
        // base resolution puts it now that its blocker is done (#383).
        const stackedIssueNumber = parseIssueNumberFromBranch(pr.headRefName);
        const feature = stackedIssueNumber === null ? null : featureForIssue(stackedIssueNumber);
        if (feature === undefined) {
          log.warn(
            `Could not determine feature membership for PR #${pr.number} — ` +
              `leaving its base unchanged until the next sweep.`,
          );
          continue;
        }
        const target = feature ? feature.branch : prBase;
        github.retargetPr(pr.number, target);
        log.say(`PR #${pr.number} retargeted onto ${target}.`);
      } catch (error) {
        log.fail(
          `Could not unstack or retarget PR #${pr.number} — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Keep each live feature's integration PR body listing a `Closes #N` line per
   * member PR that has merged into the feature branch (#341, ticket #380).
   * GitHub honours closing keywords only on a PR bound for the default branch,
   * so this is what makes merging the integration PR close the whole set — at
   * the moment the work actually reaches that branch, and never before.
   *
   * A sweep rather than a post-run hook: a member PR merges long after the run
   * that opened it, usually while Phoebe is doing something else entirely.
   * Best-effort like its neighbours — one feature's failure does not stop the
   * rest, and the whole sweep failing costs a cycle's delay, nothing more.
   */
  function sweepFeatureCloses(): void {
    // A feature's members are issues, so the row that works them is the row that
    // keeps their integration PR's `Closes` block current (#418).
    if (!scope.issues) return;
    let integrationPrs: FeatureIntegrationPr[];
    try {
      integrationPrs = github.listFeatureIntegrationPrs();
    } catch (error) {
      log.fail(
        `Could not list integration PRs for the feature-closes sweep — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const integrationPr of integrationPrs) {
      // Never repair an object this pipeline is running (#422).
      if (targetInFlight({ objectType: "pr", id: integrationPr.number })) continue;
      try {
        const members = github.listMergedMemberPrs(integrationPr.featureIssueNumber);
        const closes = members
          .map(memberIssueNumber)
          .filter((issueNumber): issueNumber is number => issueNumber !== null);
        const update = withClosesSection(integrationPr.body, closes);
        if (!update) continue;
        github.updatePrBody(integrationPr.number, update.body);
        log.say(
          `Integration PR #${integrationPr.number} now closes ` +
            `${update.added.map((n) => `#${n}`).join(", ")} — ` +
            `merged into ${featureBranch(integrationPr.featureIssueNumber)}.`,
        );
      } catch (error) {
        log.fail(
          `Could not maintain the Closes list on integration PR ` +
            `#${integrationPr.number} — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Re-arm every open issue that carries `processingLabel` but has no open or
   * merged Phoebe PR — an issue whose run ended without producing one, whether
   * by crash, kill, or timeout. Best-effort: one issue's failure does not stop
   * the sweep, and a failure of the whole sweep never stops the cycle.
   *
   * Quarantined issues are swept unconditionally — `selectIssue` still filters
   * them, so a re-armed quarantined issue is not picked. By the time
   * `sweepQuarantine` lifts the quarantine label the issue already carries
   * `readyLabel`, so `sweepQuarantine` needs no change.
   */
  function sweepStrandedUnits(): void {
    if (!scope.issues) return;
    let claimed: Issue[];
    try {
      claimed = github.listLabeledIssues(config.processingLabel);
    } catch (error) {
      log.fail(
        `Could not list claimed issues for the stranded-unit sweep — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const issue of claimed) {
      // The one sweep whose double-run does damage: re-arming an issue a sibling
      // pipeline is mid-run on hands the same ticket to two agents. So this
      // filter is per issue rather than per row — the research label is already
      // on every row listed, and it is the only thing that tells the two issue
      // producers' units apart (#418).
      if (!scope.ownsIssue(issue.labels)) continue;
      // And never re-arm an issue this very pipeline is running (#422). An
      // `issues` unit between its claim and its first push is precisely an issue
      // wearing the processing label with no PR yet — the shape this sweep was
      // built to repair. Serial, that state could not coexist with the sweep;
      // with a second unit in flight it can, so the in-flight set is what tells
      // a stranded issue from a live one.
      if (targetInFlight({ objectType: "issue", id: issue.number })) continue;
      const label = `issue #${issue.number}`;
      let hasPr: boolean;
      try {
        const state = github.blockerPrState(issue.number);
        hasPr = state.hasOpenPr || state.hasMergedPr;
      } catch (error) {
        log.fail(
          `Could not check PR state for ${label} in the stranded-unit sweep — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (hasPr) continue;
      try {
        github.removeIssueLabel(issue.number, config.processingLabel);
        if (!issue.labels.includes(config.readyLabel)) {
          github.addIssueLabel(issue.number, config.readyLabel);
        }
        const target: UnitTarget = { objectType: "issue", id: issue.number };
        const login = github.resolveLogin(env["PHOEBE_GH_LOGIN"]);
        const k = resolveMaxUnproductiveRuns(env, config.maxUnproductiveRuns);
        const inputs = github.issueTimeoutInputs(issue.number);
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
              kind: "issues",
              id: issue.number,
              k: count,
              baseline: inputs.baseline,
              cause: "unproductive",
            }),
          );
        }
        log.say(`Re-armed ${label} — stranded with no PR.`);
      } catch (error) {
        log.fail(
          `Could not re-arm ${label} in the stranded-unit sweep — ` +
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
      log.say(`No co-author credit for #${opts.issueNumber} (no creditable author).`);
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
    log.say(`Co-author trailer for #${opts.issueNumber}: ${detail}.`);
  }

  // ---------------------------------------------------------------------------
  // Work-unit execution
  // ---------------------------------------------------------------------------

  /**
   * The plain-directory workspace (#358): one empty directory per kind under
   * the tenant's scratch root, with no clone and no git state. Cleared before
   * it is created, exactly as `prepareWorktree` clears a stale worktree at the
   * same path — the path is derived from the kind and so is stable across
   * runs, which is what makes a directory left behind by a killed run
   * self-healing rather than a leak the next run inherits.
   */
  function prepareScratchDir(kind: string): string {
    // `kind` is always a built-in name (a hardcoded literal from
    // `WORK_KIND_NAMES`) or a custom kind validated against
    // `CUSTOM_WORK_KIND_NAME_RE` at config load, so it is already a safe,
    // collision-free path segment — no further normalization needed.
    const dir = join(config.paths.scratchDir, kind);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Give up a worktree path: drop this pipeline's lease on it, then remove it.
   *
   * Both ends of a tree's life go through here — the clearing that precedes
   * `prepareWorktree` and the teardown that follows a unit — because they are
   * the same act, and because both used to assume this process owned
   * `worktrees/` outright. It no longer does (#418). A tree leased by anyone
   * else ends the attempt with a `WorktreeLeasedError` before the removal that
   * would otherwise take a live agent's tree apart; our own leftover lease,
   * from a run some predecessor was killed in the middle of, is simply
   * dropped — same tree, and this is the run rebuilding it.
   */
  function releaseWorktree(worktreeDir: string): void {
    const lease = hub.worktreeLease(worktreeDir);
    if (lease.locked && lease.pipeline !== pipeline) {
      throw new WorktreeLeasedError(worktreeDir, lease.pipeline);
    }
    if (lease.locked) hub.unlockWorktree(worktreeDir);
    hub.removeWorktree(worktreeDir);
  }

  function prepareWorktree(opts: { branch: BranchRef; baseRef?: string }): string {
    const worktreeDir = hub.worktreeDirFor(opts.branch);
    releaseWorktree(worktreeDir);
    if (opts.baseRef) {
      hub.addWorktreeForNew({ worktreeDir, branch: opts.branch, baseRef: opts.baseRef });
    } else {
      hub.addWorktreeForExisting({ worktreeDir, branch: opts.branch });
    }
    hub.lockWorktree(worktreeDir, leaseReason);
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
    signal: AbortSignal;
  }): Promise<void> {
    const { provider, model, effort } = selectProvider(opts.picked);
    // Caller-supplied per-callsite args (ISSUE_NUMBER, PR_NUMBER, …) override
    // the standard config-derived set by key.
    const prompt = renderPrompt(
      loadPromptTemplate(opts.promptFile),
      { ...buildDefaultPromptArgs(config), ...opts.promptArgs },
      promptShell(opts.worktreeDir, env, Object.values(config.providerEnv), rowDeclaredEnv),
    );
    const agentEnv = buildAgentEnv({
      parentEnv: env,
      provider: provider.name,
      providerEnv: config.providerEnv,
      // The running kind's own opening (#425) — its `agentEnv`, and no sibling
      // kind's: the hole is per definition, not per row.
      ...(opts.picked.definition.agentEnv !== undefined
        ? { agentEnv: opts.picked.definition.agentEnv }
        : {}),
    });
    // The deadline is held by the outer `runPickedUnit` (#359): the signal
    // already fires when the whole-unit budget expires, killing the child and
    // propagating `RunTimeoutError` at the unit boundary.
    const { exitCode } = await runAgent({
      provider,
      model,
      effort,
      prompt,
      cwd: opts.worktreeDir,
      env: agentEnv,
      signal: opts.signal,
      tenant: config.repoSlug,
    });
    if (exitCode !== 0) {
      log.say(`Agent exited with code ${exitCode}.`);
    }
  }

  function tryCleanMerge(
    branch: BranchRef,
    mergedBlockerPrNumbers: readonly PrNumber[] = [],
    baseBranch: string = config.defaultBranch,
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
      gitInWorktree(worktreeDir, ["fetch", "origin", baseBranch], { stdio: "inherit" });
      gitInWorktree(worktreeDir, ["merge", `origin/${baseBranch}`], { stdio: "pipe" });
      hub.pushBranch(worktreeDir, branch);
      releaseWorktree(worktreeDir);
      return "pushed";
    } catch {
      try {
        const unmerged = gitInWorktree(worktreeDir, ["diff", "--name-only", "--diff-filter=U"]);
        if (unmerged.trim()) {
          gitInWorktree(worktreeDir, ["merge", "--abort"], { stdio: "ignore" });
          releaseWorktree(worktreeDir);
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
      releaseWorktree(worktreeDir);
      return "failed";
    }
  }

  /** Blocker-first merge attempt, mirroring `cmd && … || true` hook semantics. */
  function attemptBlockerFirstMerges(
    worktreeDir: string,
    mergedBlockerPrNumbers: readonly PrNumber[],
    baseBranch: string = config.defaultBranch,
  ): void {
    try {
      for (const n of mergedBlockerPrNumbers) {
        gitInWorktree(worktreeDir, ["fetch", "origin", `pull/${n}/head`], { stdio: "inherit" });
        gitInWorktree(worktreeDir, ["merge", "FETCH_HEAD"], { stdio: "pipe" });
      }
      gitInWorktree(worktreeDir, ["fetch", "origin", baseBranch], { stdio: "inherit" });
      gitInWorktree(worktreeDir, ["merge", `origin/${baseBranch}`], { stdio: "pipe" });
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
    baseBranch?: string;
    beforeAgent?: (worktreeDir: string) => void;
    onResult: (outcome: AgentWorkflowOutcome) => void | Promise<void>;
    signal: AbortSignal;
  }): Promise<void> {
    const branch = opts.pr.headRefName;

    hub.fetch();
    const originShaBefore = hub.branchHead(branch);

    const worktreeDir = prepareWorktree({ branch });
    try {
      runShellCommand(
        config.installCommand,
        worktreeDir,
        env,
        Object.values(config.providerEnv),
        rowDeclaredEnv,
      );
      // Presence, not length: an empty list still primes the tree with the
      // base-branch merge (reproducing the conflict for the agent to solve).
      if (opts.primeBlockerMerges !== undefined) {
        attemptBlockerFirstMerges(worktreeDir, opts.primeBlockerMerges, opts.baseBranch);
      }
      opts.beforeAgent?.(worktreeDir);

      await runAgentInWorktree({
        picked: opts.picked,
        worktreeDir,
        promptFile: opts.promptFile,
        promptArgs: opts.promptArgs,
        signal: opts.signal,
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
      releaseWorktree(worktreeDir);
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
   *
   * A feature member gets the banner and no retarget (#383, #376): pointing its
   * PR at the default branch would take the work off the feature branch, which
   * is the whole arm. It waits on its blocker instead — and when that blocker
   * merges, GitHub retargets this PR onto the feature branch with it.
   */
  function ensureNativeStack(opts: {
    issueNumber: number;
    existingPr: PrNumber | null;
    stackedOn: StackedOn;
    featureIssueNumber?: number;
  }): void {
    const { blockerIssueNumber, blockerPrNumber } = opts.stackedOn;
    const prNumber = opts.existingPr ?? github.findIssuePr(opts.issueNumber);
    if (prNumber === null) {
      log.say(`No open PR found for #${opts.issueNumber} — skipping stack setup.`);
      return;
    }
    const outcome = github.stackPrOnto(prNumber, blockerPrNumber);
    if (outcome.stacked) {
      log.say(`PR #${prNumber} stacked on PR #${blockerPrNumber} (stack #${outcome.stackNumber}).`);
      return;
    }
    log.say(`Native PR stacking unavailable (${outcome.reason}) — using the do-not-merge banner.`);
    const memberBase =
      opts.featureIssueNumber !== undefined ? featureBranch(opts.featureIssueNumber) : null;
    const banner = stackedPrComment(blockerIssueNumber, blockerPrNumber, memberBase ?? prBase);
    if (!github.prCommentBodies(prNumber).includes(banner)) {
      github.postPrComment(prNumber, banner);
    }
    if (memberBase) {
      log.say(
        `PR #${prNumber} belongs to feature branch ${memberBase} — leaving its base on ` +
          `${issueBranch(blockerIssueNumber)} rather than retargeting it onto ${prBase}.`,
      );
      return;
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
    featureIssueNumber?: number;
    signal: AbortSignal;
  }): Promise<void> {
    const { issueNumber, issueTitle, worktreeBase, stacked, promptFile } = opts;
    const { blockerIssueNumber, blockerPrNumber, featureIssueNumber } = opts;
    const agentBranch = issueBranch(issueNumber);
    const stackedOn: StackedOn | null =
      stacked && blockerIssueNumber !== undefined && blockerPrNumber !== undefined
        ? { blockerIssueNumber, blockerPrNumber }
        : null;
    // A stacked PR targets the blocker's branch — a stacked member included,
    // whose stack reaches the feature branch through the blocker's own PR. An
    // unstacked member targets the feature integration branch; all others target
    // the default branch. The agent's own `gh pr create` (issues prompt, step 7)
    // uses the same base.
    const intendedPrBase = stackedOn
      ? issueBranch(stackedOn.blockerIssueNumber)
      : featureIssueNumber !== undefined
        ? featureBranch(featureIssueNumber)
        : prBase;

    hub.fetch();
    const worktreeDir = prepareWorktree({ branch: agentBranch, baseRef: worktreeBase });
    try {
      runShellCommand(
        config.installCommand,
        worktreeDir,
        env,
        Object.values(config.providerEnv),
        rowDeclaredEnv,
      );

      await runAgentInWorktree({
        picked: opts.picked,
        worktreeDir,
        promptFile,
        promptArgs: { ISSUE_NUMBER: String(issueNumber), PR_BASE: intendedPrBase },
        signal: opts.signal,
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
          log.say(`PR #${existingPr} already exists for ${agentBranch} — posting follow-up note.`);
          github.postPrComment(existingPr, followUpPrComment(issueNumber, newCommitCount));
        }
        if (stackedOn) {
          ensureNativeStack({
            issueNumber,
            existingPr,
            stackedOn,
            ...(featureIssueNumber !== undefined ? { featureIssueNumber } : {}),
          });
        }
      } else {
        log.say("No commits — skipping PR creation.");
      }
    } finally {
      releaseWorktree(worktreeDir);
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
  function createAgentHelpers(
    picked: PickedWorkUnit,
    workspaceDir: () => string,
    signal: AbortSignal,
  ): AgentHelpers {
    const defaultPromptFile = picked.definition.promptFile;
    return {
      run: (opts = {}) =>
        runAgentInWorktree({
          picked,
          worktreeDir: opts.worktreeDir ?? workspaceDir(),
          promptFile: opts.promptFile ?? defaultPromptFile,
          promptArgs: opts.promptArgs ?? {},
          signal,
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
          ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
          ...(opts.beforeAgent !== undefined ? { beforeAgent: opts.beforeAgent } : {}),
          onResult: opts.onResult,
          signal,
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
          ...(opts.featureIssueNumber !== undefined
            ? { featureIssueNumber: opts.featureIssueNumber }
            : {}),
          signal,
        }),
      cleanMerge: (branch, blockerPrNumbers = [], baseBranch) =>
        tryCleanMerge(branch, blockerPrNumbers, baseBranch),
    };
  }

  /**
   * The read-only workspace (#397): a worktree of the default branch detached
   * at `origin/<defaultBranch>`, one directory per kind so it can never share a
   * path with the branch-slug dirs `worktreeDirFor` hands out.
   *
   * Detached is the whole of the don't-push contract. No local ref is created
   * or moved, and `git push` with no refspec fails out of a detached HEAD, so
   * the kind cannot publish by habit. It can still publish on purpose — it
   * holds `ctx.env` and the token — and the engine does not pretend otherwise.
   */
  function prepareReadonlyWorktree(kind: string): string {
    const worktreeDir = join(config.paths.worktreesDir, "readonly", kind);
    releaseWorktree(worktreeDir);
    hub.addWorktreeDetached({ worktreeDir, ref: `origin/${config.defaultBranch}` });
    hub.lockWorktree(worktreeDir, leaseReason);
    return worktreeDir;
  }

  /**
   * What a readonly workspace holds that the engine is about to delete. A kind
   * that wrote into a tree with nowhere to push is losing the work; the engine
   * does not stop it, but it refuses to lose it silently. Git failures here are
   * swallowed: this runs on the unit-teardown path, where a throw would replace
   * whatever actually happened to the unit.
   */
  function warnIfReadonlyTreeTouched(kind: string, dir: string): void {
    try {
      const changed = hub.dirtyFileCount(dir);
      const commits = hub.commitCount(dir, `origin/${config.defaultBranch}..HEAD`);
      if (changed === 0 && commits === 0) return;
      log.warn(
        `${kind}: the readonly workspace was modified ` +
          `(${changed} changed file(s), ${commits} commit(s)) and is being discarded with the ` +
          `unit. A kind that means to publish should build its own worktree through ctx.agent.`,
      );
    } catch (error) {
      log.warn(
        `${kind}: could not inspect the readonly workspace before removing it — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * One unit's engine-prepared workspace, in the mode its kind declared
   * (#356/#358/#397): the handle `run` sees, the materializing accessor the
   * agent helpers use as their default cwd, and the removal the unit boundary
   * runs.
   *
   * Every mode shares one shape — create on first read of `dir`, remove only
   * what was created — so laziness is a property of the workspace seam rather
   * than of the worktree arm that happened to get it first.
   */
  function lazyWorkspace(picked: PickedWorkUnit): {
    handle: WorkspaceHandle;
    dir: () => string;
    remove: () => void;
  } {
    const mode = picked.definition.workspace;
    let dir: string | null = null;
    const materialize = (): string => {
      if (dir === null) {
        if (mode === "scratch") {
          dir = prepareScratchDir(picked.kind);
        } else if (mode === "readonly") {
          hub.fetch();
          dir = prepareReadonlyWorktree(picked.kind);
        } else {
          hub.fetch();
          dir = prepareWorktree({
            branch: asBranchRef(`${config.branchPrefix}workspace`),
            baseRef: `origin/${config.defaultBranch}`,
          });
        }
      }
      return dir;
    };
    return {
      handle: {
        mode,
        get dir(): string {
          return materialize();
        },
      },
      dir: materialize,
      remove: () => {
        if (dir === null) return;
        if (mode === "scratch") {
          rmSync(dir, { recursive: true, force: true });
          return;
        }
        if (mode === "readonly") warnIfReadonlyTreeTouched(picked.kind, dir);
        releaseWorktree(dir);
      },
    };
  }

  /**
   * Execute one picked unit through its definition's `run`: widen the cycle ctx
   * with the declared workspace and the agent helpers, and hand over under the
   * whole-unit run deadline (#359).
   *
   * The deadline races the budget against the whole `definition.run` — not just
   * the agent spawn — so kind-owned code that hangs outside `ctx.agent.*` still
   * triggers `RunTimeoutError`, releases the slot, and reaches quarantine
   * accounting. The `signal` carried on `ctx` fires on expiry; cooperative kinds
   * poll `signal.aborted` or pass it to async operations to stop early. On
   * expiry the engine abandons the floating `run` promise: an orphaned `run`
   * keeps executing but cannot hold the slot or prevent quarantine.
   *
   * The workspace — whichever mode the kind declared, and the default cwd for a
   * bare `agent.run` — is materialized on first read, not up front. All five
   * built-ins build their own branch-specific worktrees and never touch
   * `ctx.workspace.dir`, so they pay no churn per unit; a kind that does read
   * it pays then, and only a materialized workspace is removed afterwards.
   */
  async function runPickedUnit(picked: PickedWorkUnit, ctx: WorkKindCtx): Promise<void> {
    const workspace = lazyWorkspace(picked);
    try {
      await runWithDeadline({
        ms: runTimeoutMsFor(picked.kind),
        work: (signal) => {
          const runCtx: WorkKindRunCtx = {
            ...ctx,
            log: (message) =>
              console.log(`${log.tag}[${picked.kind} ${picked.unit.ref}] ${message}`),
            workspace: workspace.handle,
            signal,
            agent: createAgentHelpers(picked, workspace.dir, signal),
          };
          return picked.definition.run(picked.unit, runCtx);
        },
      });
    } finally {
      workspace.remove();
    }
  }

  // --- The in-flight set (#422) ------------------------------------------------
  // What this pipeline is running right now. A pass tops the set up to the row's
  // `concurrency` and then waits for whichever comes first: a unit settling or
  // the poll interval. At concurrency 1 the set holds at most one unit and the
  // loop reduces to the serial one it has always been.

  type InFlightUnit = {
    ref: UnitRef;
    /** The unit's GitHub object, when it declared one — what admission excludes on. */
    target: WorkUnitGitHubTarget | undefined;
    /** Settles when the unit finishes, whatever the outcome. Never rejects. */
    settled: Promise<void>;
  };

  const inFlight = new Map<string, InFlightUnit>();
  /** This kind's running refs — what `ctx.inFlight` and the selection walk read. */
  const inFlightRefs = new Map<string, Set<string>>();
  /** The first error a `--run-once` unit threw, rethrown once nothing is running. */
  let fatalError: unknown;

  function inFlightKey(ref: UnitRef): string {
    return `${ref.kind} ${ref.id}`;
  }

  function refsInFlight(kind: string): Set<string> {
    const existing = inFlightRefs.get(kind);
    if (existing) return existing;
    const fresh = new Set<string>();
    inFlightRefs.set(kind, fresh);
    return fresh;
  }

  /**
   * Is this GitHub object one of the units running right now? Both the admission
   * exclusion and the four sweeps ask it, of the unit's structural `github`
   * field rather than of its ref: refs are kind-owned and nothing may parse one,
   * but the target is the window the engine already has (#352).
   */
  function targetInFlight(target: UnitTarget): boolean {
    for (const unit of inFlight.values()) {
      if (unit.target?.objectType === target.objectType && unit.target.id === target.id) {
        return true;
      }
    }
    return false;
  }

  // Woken when any in-flight unit settles, so a pass that has nothing else to
  // wait for reconsiders admission immediately rather than sleeping out a poll
  // interval behind a slot that is already free.
  const settleWakers = new Set<() => void>();

  function announceSettled(): void {
    for (const wake of settleWakers) wake();
  }

  /**
   * Wait for the next pass: whichever comes first of a unit settling, the poll
   * interval, or a drain. With nothing running there is nothing to settle, so
   * this is the idle poll the loop has always done.
   */
  async function waitForNextPass(): Promise<void> {
    if (inFlight.size === 0) {
      await drain.wait(pollIntervalMs);
      return;
    }
    let forget = (): void => {};
    const settled = new Promise<void>((resolve) => {
      const wake = (): void => resolve();
      settleWakers.add(wake);
      forget = () => settleWakers.delete(wake);
    });
    try {
      await Promise.race([drain.wait(pollIntervalMs), settled]);
    } finally {
      forget();
    }
  }

  /** Await every unit still running. The exit path of every way the loop stops. */
  async function settleInFlight(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.all([...inFlight.values()].map((unit) => unit.settled));
    }
  }

  /**
   * Run one admitted unit to settlement and report its outcome on the event
   * rail. Throws only under `runOnce`, where the unit's outcome is the process's
   * exit code; the loop absorbs that and rethrows once nothing is left running.
   * Otherwise a failed unit must not kill the daemon — `prepareWorktree` clears
   * any stale worktree on the next attempt.
   */
  async function workUnit(picked: PickedWorkUnit, ctx: WorkKindCtx): Promise<void> {
    const ref = unitRefOf(picked);
    try {
      await runPickedUnit(picked, ctx);
      emitUnitEvent({ unit: ref, event: "completed" });
    } catch (error) {
      if (error instanceof WorktreeLeasedError) {
        // Not a failure: another pipeline is working the tree this unit needs
        // (#418). Say so and leave the unit alone — the sibling will release it,
        // and the next cycle picks the unit up again.
        emitUnitEvent({ unit: ref, event: "skipped", detail: error.message });
        log.say(`Skipped ${describeUnit(picked)} — ${error.message}.`);
        return;
      }
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
        // A non-timeout failure: drop the unit from the snapshot and record the
        // error so `phoebe list` shows it (the durable record is still the
        // per-work-kind watermark/failure-comment on GitHub; this is the
        // at-a-glance snapshot).
        emitUnitEvent({
          unit: ref,
          event: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (runOnce) throw error;
      log.fail(
        `Failed executing ${describeUnit(picked)} — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      slotClient?.release();
    }
  }

  /** What one admission attempt did, and what the pass should do next. */
  type Admission = "started" | "refused" | "drain" | "stop";

  /**
   * Admit one selected unit: refuse it if its GitHub object is already busy,
   * take a broker slot for it, and start it without awaiting — the pass returns
   * to admission and the loop's wait is what watches for it settling.
   *
   * The credential lease is checked once per pass, before this runs and ahead of
   * the slot request (#422). That ordering is the point: a failed refresh has no
   * slot to give back, so the branch that used to release one is gone.
   */
  async function admit(picked: PickedWorkUnit, ctx: WorkKindCtx): Promise<Admission> {
    const ref = unitRefOf(picked);
    const target = picked.unit.github;
    if (target) {
      // Two units on one PR would be two agents pushing one branch.
      if (targetInFlight(target)) {
        log.say(
          `Not admitting ${describeUnit(picked)} — ` +
            `${describeUnitTarget(target)} is already in flight.`,
        );
        return "refused";
      }
    } else {
      // A unit with no `github` field is opaque to the engine, so there is
      // nothing to exclude it against. That is a defined degraded behaviour
      // (docs/research/slack-responder-sketch.md), not a fault — but it is the
      // kind of thing an operator should be able to find in the log afterwards.
      log.say(`${describeUnit(picked)} declares no GitHub target — admitted with no exclusion.`);
    }

    // A concurrency slot for the whole unit execution (#59): the supervisor's
    // global cap bounds how many repos run a unit at once. Held through worktree
    // + install + agent + test + push, released in `workUnit`'s `finally` so
    // timeout, error, and normal completion share one leak-free release path
    // (#72). Standalone (unbrokered) engines skip this entirely.
    if (slotClient) {
      emitUnitEvent({ unit: ref, event: "waiting-for-slot" });
      try {
        await slotClient.acquire();
      } catch (error) {
        if (error instanceof BrokerDisconnectedError) {
          // The supervisor's channel closed while we waited for a slot. Stop
          // rather than run unbrokered (which, across a fleet, would bypass the
          // global cap); the supervisor is gone or will respawn us afresh.
          log.fail(`${error.message} — stopping this engine.`);
          return "stop";
        }
        throw error;
      }
    }

    // A drain that arrived while awaiting the slot must not let this unit start
    // — "start no new one". Give the slot straight back.
    if (drain.requested) {
      slotClient?.release();
      log.say("Drain requested before starting the next unit — exiting 0.");
      return "drain";
    }

    emitUnitEvent({ unit: ref, event: "started", runBudgetMs: runTimeoutMsFor(picked.kind) });
    refsInFlight(ref.kind).add(ref.id);
    const key = inFlightKey(ref);
    const settled = workUnit(picked, ctx)
      .catch((error: unknown) => {
        fatalError ??= error;
      })
      .finally(() => {
        inFlight.delete(key);
        refsInFlight(ref.kind).delete(ref.id);
        announceSettled();
      });
    inFlight.set(key, { ref, target, settled });
    return "started";
  }

  const workSource: WorkSource = createWorkSource({
    tag: log.tag,
    github,
    originHub: hub,
    clock,
    env,
    config,
    registry,
    inFlight: refsInFlight,
  });

  /**
   * Words a kind's own `report` produced, or the engine's fallback if the kind
   * threw. Reporting sits deliberately outside the failure contract that makes
   * `fetch` and `run` cycle-fatal (src/work-kinds/definition.ts): a custom kind
   * is authored code, and a reporter that throws must not take the engine down.
   * The idle path is the sharpest case — it runs on every quiet cycle, so an
   * unguarded throw there is a restart loop until an operator edits the module,
   * and nothing about an idle cycle needed to fail. The describe path matters
   * for a subtler reason: one of its call sites is inside the handler for a
   * unit that already failed, where a throw would escape carrying the wrong
   * error.
   */
  function kindReported(kind: string, fallback: string, produce: () => string | undefined): string {
    try {
      return produce() ?? fallback;
    } catch (error) {
      log.warn(
        `${kind}: report failed, falling back to the engine's wording — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }

  /** How the kind names this unit, or `<kind> <ref>` if its `describe` throws. */
  function describeUnit(picked: PickedWorkUnit): string {
    return kindReported(picked.kind, `${picked.kind} ${picked.unit.ref}`, () =>
      picked.definition.report.describe(picked.unit),
    );
  }

  /** One line of the idle report, rendered from one entry of the selection's record. */
  function idleSkipLine(skip: WorkUnitSkip, cycle: GatheredCycle): string {
    const { report } = registeredKind(registry, skip.kind).definition;
    if (skip.reason === NONE_WORKABLE) {
      return kindReported(
        skip.kind,
        `${skip.count} ${report.noun} but none workable this cycle.`,
        () =>
          report.idle?.(cycle.record.gathered.get(skip.kind), skip.count, cycle.ctxFor(skip.kind)),
      );
    }
    // Kind-owned free-string reasons render verbatim (#348 Q5).
    return `${skip.count} ${report.noun} skipped (${skip.reason}).`;
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
      log.say(idleSkipLine(skip, cycle));
      if (skip.reason === NONE_WORKABLE) {
        return;
      }
    }
    log.say("No work this cycle — idle.");
  }

  /**
   * Drive this engine until it exits: the persistent poll loop, or one unit under
   * `runOnce`. Takes no arguments — the run options, the collaborators and the
   * tenant's config are all closed over.
   */
  async function runLoop(): Promise<void> {
    // Boot-time lease break (#418). A worktree lease outlives the process that
    // took it — a killed engine leaves its trees locked, and nothing would ever
    // unlock them. So a pipeline drops its own leases unconditionally at boot,
    // and never anyone else's: a tree stamped with a sibling's name may have a
    // live agent inside it. Skipped on the host, where the hub points at the
    // operator's own checkout.
    if (inContainer && !dryRun && usesRepoWorkspace) {
      try {
        const { broken, heldByOthers } = breakOwnLeases(hub, pipeline);
        for (const dir of broken) {
          log.say(`Broke a stale worktree lease on ${dir} — it was this pipeline's own.`);
        }
        for (const held of heldByOthers) {
          log.say(
            `Worktree ${held.dir} is leased by ` +
              `${held.pipeline === null ? "another writer" : `pipeline ${held.pipeline}`} — ` +
              `leaving it alone.`,
          );
        }
      } catch (error) {
        log.warn(
          `Could not read worktree leases at boot — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Boot-time login identity cross-check (#346): warn when the resolved login
    // differs from the author on Phoebe's own newest unit-marker comment. An
    // identity drift silently resets the quarantine counter every rotation —
    // every marker Phoebe posts reads as foreign activity. Best-effort: any
    // failure logs and the loop starts normally.
    try {
      const resolvedLogin = github.resolveLogin(env["PHOEBE_GH_LOGIN"]);
      const historicalAuthor = github.newestUnitMarkerAuthor();
      const warning = loginMismatchWarning(resolvedLogin, historicalAuthor);
      if (warning) {
        log.warn(warning);
      }
    } catch (error) {
      log.warn(
        `Boot-time login identity cross-check failed — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    while (true) {
      if (drain.requested) {
        log.say(
          inFlight.size === 0
            ? "Drain requested — starting no new work unit; exiting 0."
            : `Drain requested — starting no new work unit; awaiting ${inFlight.size} ` +
                `in flight, then exiting 0.`,
        );
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
            log.fail(`${error.message} — stopping this engine.`);
            break;
          }
          if (error instanceof CredentialRefreshBlockedError) {
            log.warn("Credential refresh unavailable — skipping work this cycle.");
            await waitForNextPass();
            continue;
          }
          if (error instanceof CredentialLeaseTimedOutError) {
            log.warn("Credential lease timed out — skipping work this cycle.");
            await waitForNextPass();
            continue;
          }
          throw error;
        }
      }
      if (leasedToken === null && arm === "app" && !dryRun) {
        const creds = detectAppCredentials(env);
        if (!creds) {
          log.fail("App mode active but GH_APP_ID or GH_APP_PRIVATE_KEY is missing.");
          if (runOnce) break;
          await waitForNextPass();
          continue;
        }
        const mintResult = await mintInstallationToken(config.repoSlug, creds);
        if (!mintResult.ok) {
          const statusLabel = mintResult.status !== null ? ` HTTP ${mintResult.status}` : "";
          log.fail(`App mode mint failed${statusLabel}: ${mintResult.reason}`);
          if (runOnce) break;
          await waitForNextPass();
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
      // start no new work this cycle. Runs already in flight finish on their own
      // terms, satisfying the "drain, don't cancel" contract. Clear any lingering
      // quarantine state so a re-enabled tenant starts clean.
      if (config.disabled) {
        if (!dryRun) {
          sweepQuarantine("tenant-disabled");
        }
        if (runOnce) {
          log.say(
            "Tenant is disabled — no work will be started (`disabled: true` in phoebe.config.ts).",
          );
          break;
        }
        log.say(
          "Tenant is disabled — no new work will be started this cycle. " +
            "Remove `disabled: true` from phoebe.config.ts to re-enable.",
        );
        await waitForNextPass();
        continue;
      }

      // Sweeps before selecting (#153, #366, #380): skipped under `--dry-run`,
      // which must not write to GitHub. They run on every pass, including one
      // with no free slot — repairing objects nobody is holding is the work a
      // pass owes whatever it can admit, and each sweep now skips the objects
      // this pipeline is itself running (#422).
      if (!dryRun) {
        sweepStrandedUnits();
        sweepQuarantine("content-advanced");
        sweepStaleNativeStacks();
        sweepFeatureCloses();
      }

      // Rolling top-up (#422): a pass admits at most as many units as the row
      // has free slots. With none free there is nothing selection could do with
      // an answer, so skip the gather entirely and wait.
      const free = concurrency - inFlight.size;
      if (free <= 0) {
        await waitForNextPass();
        continue;
      }

      const fetchKinds = schedulableKinds(
        runOnce ? oneShotWorkKinds(workOrder, registry) : workOrder,
      );
      const cycle = await workSource.gatherCycle(fetchKinds);
      const { units, skipped } = selectWorkUnits({
        registry,
        kinds: cycle.record.kindsGathered,
        gathered: cycle.record.gathered,
        ctxFor: cycle.ctxFor,
        limit: free,
        inFlight: refsInFlight,
        onDropped: (kind, ref) =>
          log.say(
            `${kind} offered ${ref}, which this pipeline is already running — dropped, and ` +
              `${kind} is not asked again this cycle. Its \`select\` is ignoring \`ctx.inFlight\`.`,
          ),
      });

      if (units.length === 0) {
        if (runOnce) {
          log.say(RUN_ONCE_NOTHING_MESSAGE);
        } else if (inFlight.size === 0) {
          // A pass that found nothing new while units are running is not idle,
          // and reporting it as such every poll would bury the real idle line.
          logIdleCycle(cycle, skipped);
        }
        if (runOnce || dryRun) break;
        await waitForNextPass();
        continue;
      }

      const decision = executionDecision({ dryRun, inContainer });
      if (decision === "dry-run") {
        for (const picked of units) {
          log.say(`Would execute: ${describeUnit(picked)}.`);
        }
        break;
      }
      if (decision === "refuse") {
        log.fail(EXECUTION_REFUSED_MESSAGE);
        process.exit(1);
      }

      // A drain that arrived during the fetch/selection above must not let these
      // freshly-picked units start — "start no new one". Anything already
      // running is awaited on the way out.
      if (drain.requested) {
        log.say("Drain requested before starting the next unit — exiting 0.");
        break;
      }

      // Credential lease — call site 2: admission, ahead of the slot request
      // (#422). One live lease per pipeline process, refreshed in place, so a
      // pass admitting three units refreshes once — the lease belongs to the
      // process, not to the unit. A failed refresh blocks admission and leaves
      // `GH_TOKEN` exactly as it was, so whatever is already running finishes on
      // the token it was handed. There is no slot to release: nothing has been
      // requested yet.
      if (credentialClient) {
        try {
          const token = await credentialClient.requestLease(credentialBudgetMs);
          if (token !== null) env["GH_TOKEN"] = token;
        } catch (error) {
          if (error instanceof BrokerDisconnectedError) {
            log.fail(`${error.message} — stopping this engine.`);
            break;
          }
          if (error instanceof CredentialRefreshBlockedError) {
            log.warn("Credential refresh unavailable — admitting no unit this cycle.");
            await waitForNextPass();
            continue;
          }
          if (error instanceof CredentialLeaseTimedOutError) {
            log.warn("Credential lease timed out — admitting no unit this cycle.");
            await waitForNextPass();
            continue;
          }
          throw error;
        }
      }

      let stopping = false;
      for (const picked of units) {
        const admission = await admit(picked, cycle.ctxFor(picked.kind));
        if (admission === "stop" || admission === "drain") {
          stopping = true;
          break;
        }
      }
      if (stopping) break;

      // `--run-once` is pinned to concurrency 1, so exactly one unit was
      // admitted: leave the loop and await it on the way out.
      if (runOnce) break;
      await waitForNextPass();
    }

    // Every way out of the loop lands here: the units still running are finished,
    // never cancelled, and only then does the engine return. Drain generalizes to
    // exactly this — admit nothing, await everything, exit 0.
    await settleInFlight();
    if (fatalError !== undefined) throw fatalError;
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
    kinds: workOrder.map((kind) => ({
      name: kind,
      promptFile: registeredKind(registry, kind).definition.promptFile,
    })),
  });

  const runOnce = argv.includes("--run-once");
  const dryRun = argv.includes("--dry-run");
  // Which row this child is (#415). `config` has already been flattened onto it
  // by the CLI, so the name is read back here only for the cadence — declared on
  // the row, which outranks `PHOEBE_POLL_INTERVAL_MS` — and for the log line.
  const pipeline = parsePipelineName(argv);
  // And in the same posture, the declared keys (#425): a scheduled kind whose
  // `requiredEnv` this row cannot read is a startup failure naming the kind and
  // the key, not a unit that dies weeks later holding an empty string. The
  // supervisor has already scrubbed this env, so "cannot read" here means what
  // the kind would mean by it.
  assertDeclaredEnvPresent({
    repoSlug: config.repoSlug,
    pipeline,
    kinds: workOrder.map((kind) => ({
      name: kind,
      definition: registeredKind(registry, kind).definition,
    })),
    env: process.env,
  });
  const row = pipelineRow(config, pipeline);
  const pollIntervalMs = resolvePollIntervalMs(row, process.env);
  const concurrency = row.concurrency;
  const log = createEngineLog(config.repoSlug, pipeline);

  console.log(
    runOnce
      ? `${log.tag} Run-once mode (pipeline ${pipeline}) — will work at most one unit of the first one-shot-eligible kind in WORK_ORDER, then exit.`
      : `${log.tag} Persistent mode (pipeline ${pipeline}) — up to ${concurrency} unit(s) in flight, idle poll every ${pollIntervalMs}ms. SIGTERM drains: finish what is in flight, then exit 0.`,
  );
  if (dryRun) {
    log.say("Dry-run — selection only, nothing executes.");
  }

  // Bootstrap the private clone every work unit fetches/worktrees against. Only
  // in the container (on the host the cwd is already a repo) and never for
  // --dry-run (selection uses the GitHub API, not a local clone). No-op once
  // the clone exists, so it's safe on every daemon restart. Ahead of the drain
  // latch below, as it was before the engine became a factory: until that latch
  // exists, a SIGTERM mid-clone still kills the process rather than being held
  // until the clone finishes.
  //
  // Two things changed with pipelines (#418). It is now conditional: a row whose
  // kinds all declare `scratch` never touches the clone, and cloning the repo
  // for it costs a full copy and a slow first boot for nothing. And it is
  // serialized by the tenant's clone lock, because two rows booting on a fresh
  // tenant would otherwise race `git clone` into one directory — the second
  // waits, then finds the clone already there and moves on. Only the clone is
  // locked; fetch and worktree administration share the clone unlocked, on
  // git's own ref locking and the fetch backoff.
  const inContainer = isInsideContainer();
  if (inContainer && !dryRun) {
    const workspaceModeFor = (kind: string): string =>
      registeredKind(registry, kind).definition.workspace;
    if (requiresOriginClone(workOrder, workspaceModeFor)) {
      withCloneLock(config.paths.stateDir, () => ensureOriginClone(config, inContainer), {
        log: (line) => log.say(line),
      });
    } else {
      log.say("No scheduled kind needs a repo workspace — skipping the origin clone.");
    }
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

  // Per-repo observability (#73): one tagged `[phoebe:<slug>:<pipeline>]` line
  // per unit event + a `status.json` snapshot under this pipeline's own dir in
  // the tenant's state dir (#418), which `phoebe list` reads for the `work`
  // row. The emitter swallows snapshot-write failures, so it is harmless on the
  // host (where the derived state dir may be unwritable).
  const emitUnitEvent = createEmitUnitEvent({
    tenant: config.repoSlug,
    pipeline,
    statusPath: statusPathFor(config.paths.stateDir, pipeline),
  });

  const drain = installDrainSignal();
  try {
    const engine = createEngine({
      config,
      pipeline,
      registry,
      env: process.env,
      drain,
      slotClient,
      credentialClient,
      emitUnitEvent,
      run: { runOnce, dryRun, pollIntervalMs, concurrency },
    });
    await engine.runLoop();
  } finally {
    drain.dispose();
  }
}
