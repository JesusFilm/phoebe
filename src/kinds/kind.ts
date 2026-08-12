// The kind interface (issue #53): every work kind owns its whole lifecycle —
// fetch its data, select a unit from it, run that unit — behind one generic
// shape. `boxKind` erases each kind's own `Data`/`Unit` type parameters at
// construction time, so the cycle loop's vocabulary is `KindHandle` ->
// `Gathered` -> `Plan`: no `any`, no casts, no discriminated union of every
// kind's unit shape.
//
// Also home to `Io` — the impure capabilities a kind factory closes over
// (`createConflictsKind(deps)` etc., `deps = { config, io }`). `io` is built
// once in `runEngine`'s composition root and passed to every kind factory;
// nothing under `src/kinds/` spawns a binary or reads config off a global
// directly — every impure read/write goes through one of these six seams.

import type { BranchRef, Sha } from "../branded.ts";
import type { PhoebeConfig, WorkKindName } from "../config/index.ts";
import type { GitHub } from "../github.ts";
import type { Quarantine } from "../quarantine.ts";
import type { VerificationResult } from "../verification.ts";
import type { CycleContext } from "../cycle.ts";
import type { AgentUsage } from "../providers/types.ts";
import {
  classifyFailure,
  sanitizeTelemetryText,
  type RuntimeStatusTransition,
} from "../runtime-status.ts";

/** What every kind's `run`/`Plan.execute` reports back to the loop for telemetry. */
export type UnitResult = {
  exitCode: number | null;
  verification?: readonly VerificationResult[];
  /** Token usage/cost off the agent run that produced this result, if any (#165). */
  usage?: AgentUsage;
  costUsd?: number;
};

/**
 * Everything the loop needs to know about a picked unit without knowing its
 * kind's own `Unit` shape: logging, status records, unit events, and the
 * generic quarantine write path (`quarantine.ts#recordUnitTimeout`) all key
 * off this alone.
 */
export type UnitRef = {
  kind: WorkKindName;
  target: { type: "issue" | "pr"; number: number };
  branch?: BranchRef;
};

/**
 * git-model.ts operations plus the raw `git -C <dir> ...` escape hatch, bound
 * to the private clone / worktrees dir / child-process timeout once at
 * construction (`runEngine`). No kind resolves those paths itself.
 */
export type GitOps = {
  fetchOrigin(): void;
  originBranchSha(branch: BranchRef): Sha;
  /** Clears any stale worktree for the branch, then creates a fresh one. */
  prepareWorktree(opts: { branch: BranchRef; baseRef?: string }): string;
  removeWorktree(worktreeDir: string): void;
  pushBranch(worktreeDir: string, branch: BranchRef): void;
  commitCount(worktreeDir: string, range: string): number;
  /** `git -C <dir> <args>` — `dir` need not be a worktree (boot-time config on the clone itself). */
  gitInWorktree(
    dir: string,
    args: readonly string[],
    opts?: { stdio?: "inherit" | "ignore" | "pipe" },
  ): string;
};

/**
 * Runs one already-rendered prompt in a prepared worktree: provider select,
 * env allowlist, run-budget deadline. `labels` is the unit's GitHub labels
 * (issue or PR) — a `phoebe:tier:*` label among them overrides the tenant's
 * default model/effort for this one run (#155).
 */
export type AgentRunner = {
  run(opts: {
    worktreeDir: string;
    prompt: string;
    labels?: readonly string[];
  }): Promise<{ exitCode: number; usage?: AgentUsage; costUsd?: number }>;
};

/** Prompt template load + `{{KEY}}` substitution + `` !`cmd` `` shell splicing. */
export type Prompts = {
  load(relativePath: string): string;
  defaultArgs(): Record<string, string>;
  render(template: string, args: Record<string, string>, worktreeDir: string): string;
};

/** A configured toolchain command (install/check/test), run to completion with output inherited. */
export type Shell = {
  run(command: string, cwd: string): void;
  /**
   * Run a configured command to completion and capture its outcome instead
   * of inheriting stdio — the engine's own verification run (#166,
   * `verification.ts#runEngineVerification`). Never throws on a nonzero
   * exit or a timeout; both are a result (`exitCode`), not an error.
   */
  capture(command: string, cwd: string): { exitCode: number; output: string };
};

/** The impure capabilities a kind factory closes over. Built once in `runEngine`. */
export type Io = {
  github: GitHub;
  git: GitOps;
  agent: AgentRunner;
  prompts: Prompts;
  shell: Shell;
  quarantine: Quarantine;
};

/** What every kind factory (`createConflictsKind`, ...) takes. */
export type KindDeps = {
  config: PhoebeConfig;
  io: Io;
};

/**
 * One work kind's whole lifecycle. `Data` is whatever `fetch` gathers for one
 * cycle; `Unit` is the single candidate `select` may pick out of it. Neither
 * type parameter is visible past `boxKind` — the loop only ever sees
 * `KindHandle`.
 */
export type WorkKind<Data, Unit> = {
  name: WorkKindName;
  /** Whether this kind may run under `--run-once` — persistent-mode-only janitors are `false`. */
  oneShot: boolean;
  fetch(ctx: CycleContext): Promise<Data>;
  select(data: Data, ctx: CycleContext): Unit | null;
  run(unit: Unit, ctx: CycleContext): Promise<UnitResult>;
  refFor(unit: Unit): UnitRef;
  /** A human-readable reason this cycle picked no unit from `data`, or `null` when there is nothing to explain. */
  describeIdle?(data: Data): string | null;
  /** Per-cycle housekeeping unrelated to picking/running a unit (reclaim sweeps, stack retargeting). */
  sweep?(ctx: CycleContext): Promise<void>;
};

/** A selected unit, boxed: everything the loop needs to log, execute, and report it. */
export type Plan = {
  ref: UnitRef;
  describe(): string;
  execute(ctx: CycleContext): Promise<UnitResult>;
};

/** One kind's fetch results, boxed: `Data` lives only in this closure. */
export type Gathered = {
  idle(): string | null;
  plan(ctx: CycleContext): Plan | null;
};

/** A work kind with its `Data`/`Unit` type parameters erased — the loop's only vocabulary. */
export type KindHandle = {
  name: WorkKindName;
  oneShot: boolean;
  sweep?(ctx: CycleContext): Promise<void>;
  gather(ctx: CycleContext): Promise<Gathered>;
};

const UNIT_LABEL: Record<WorkKindName, string> = {
  conflicts: "conflict fix",
  checks: "checks fix",
  reviews: "review feedback",
  issues: "issue",
  research: "research ticket",
};

/** Generic, ref-only description — enough for the dry-run preview and the failure log line. */
function describeRef(ref: UnitRef): string {
  const label = UNIT_LABEL[ref.kind];
  if (ref.target.type === "pr") {
    return `${label} for PR #${ref.target.number}${ref.branch ? ` (${ref.branch})` : ""}`;
  }
  return `${label} #${ref.target.number}`;
}

/** Erase one kind's `Data`/`Unit` type parameters into the loop's generic vocabulary. */
export function boxKind<Data, Unit>(kind: WorkKind<Data, Unit>): KindHandle {
  const handle: KindHandle = {
    name: kind.name,
    oneShot: kind.oneShot,
    async gather(ctx: CycleContext): Promise<Gathered> {
      const data = await kind.fetch(ctx);
      return {
        idle: () => kind.describeIdle?.(data) ?? null,
        plan: (planCtx: CycleContext): Plan | null => {
          const unit = kind.select(data, planCtx);
          if (unit === null) {
            return null;
          }
          const ref = kind.refFor(unit);
          return {
            ref,
            describe: () => describeRef(ref),
            execute: (execCtx: CycleContext) => kind.run(unit, execCtx),
          };
        },
      };
    },
  };
  if (kind.sweep) {
    handle.sweep = (ctx: CycleContext) => kind.sweep!(ctx);
  }
  return handle;
}

/** Message the loop reports when `--run-once` finds nothing among the one-shot-eligible kinds. */
export const RUN_ONCE_NOTHING_MESSAGE =
  "Nothing to do under --run-once (janitor kinds are persistent-mode only).";

/** `--run-once` may only work a kind with `oneShot: true` — janitor kinds are persistent-mode only. */
export function oneShotEligible(kinds: readonly KindHandle[]): readonly KindHandle[] {
  return kinds.filter((kind) => kind.oneShot);
}

/** Walk `gathered` in order and return the first kind with a unit to run. */
export function pickFirstPlan(gathered: readonly Gathered[], ctx: CycleContext): Plan | null {
  for (const g of gathered) {
    const plan = g.plan(ctx);
    if (plan) {
      return plan;
    }
  }
  return null;
}

/** Walk `gathered` in order and return the first kind's explanation for why it picked nothing. */
export function pickFirstIdleReason(gathered: readonly Gathered[]): string | null {
  for (const g of gathered) {
    const reason = g.idle();
    if (reason) {
      return reason;
    }
  }
  return null;
}

/**
 * Run every one of `fetchKinds`' `gather(ctx)` — the per-cycle GitHub fetch
 * phase (#162). Any GitHub failure along the way (most notably a 403 off the
 * reviews kind's identity check when the configured credential's rate limit
 * is exhausted) is classified the same way a failing work unit already is: a
 * quota/rate-limit outcome records a `backoff` status transition and returns
 * `null` — discarding whatever this cycle already gathered, so the next cycle
 * refetches cleanly — rather than propagating and crashing the engine. Any
 * other classification rethrows, preserving today's fail-fast (engine-failed)
 * behavior.
 */
export async function gatherFetchPhase(
  fetchKinds: readonly KindHandle[],
  ctx: CycleContext,
  deps: { secrets: readonly string[]; record: (transition: RuntimeStatusTransition) => void },
): Promise<Gathered[] | null> {
  try {
    const gathered: Gathered[] = [];
    for (const handle of fetchKinds) {
      gathered.push(await handle.gather(ctx));
    }
    return gathered;
  } catch (error) {
    const message = sanitizeTelemetryText(error, deps.secrets);
    const classified = classifyFailure(message);
    if (classified.outcome !== "quota-backoff") {
      throw error;
    }
    deps.record({ kind: "backoff", reason: message });
    return null;
  }
}
