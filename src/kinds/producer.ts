// The `issues` and `research` work kinds: two instances of one producer
// core, parameterized by label/prompt/lease. Both walk the same
// priority-ordered issue pool, resolve the same stacked-worktree base, and
// run the same agent-in-a-fresh-branch workflow; they differ only in which
// label's pool they draw from, which prompt they run, and whether picking up
// a ticket claims a crash-safe lease (#15) — `research` tickets are cheap to
// re-pick, so they skip the claim/heartbeat machinery entirely.

import type { BranchRef, PrNumber } from "../branded.ts";
import { createPhoebeLog } from "../phoebe-log.ts";
import {
  buildLeaseComment,
  buildReclaimComment,
  leaseHeartbeatIntervalMs,
  parseLeaseMarker,
  reclaimDecision,
} from "../claim-lease.ts";
import { parseLatestMarker } from "../markers.ts";
import {
  buildQuarantineComment,
  buildUnitAttemptMarker,
  findLatestUnitAttemptComment,
  PHOEBE_QUARANTINE_LABEL,
  planUnitAttempt,
  slugifyFailureSignature,
} from "../quarantine.ts";
import { readVerificationReport, removeVerificationReport } from "../verification.ts";
import {
  findBlockedDependents,
  issueBlockers,
  issueBranch,
  resolveStackedPrPlan,
  resolveWorktreeBase,
  type BaseResolution,
  type BlockerPrState,
  type Issue,
  type NativeBlockerMap,
  type StackConfig,
} from "../stack.ts";
import type { CycleContext } from "../cycle.ts";
import type { KindDeps, UnitRef, UnitResult, WorkKind } from "./kind.ts";

const PRIORITY_ORDER = ["bug", "tracer", "polish", "refactor"] as const;
export type Priority = (typeof PRIORITY_ORDER)[number];

export function classifyPriority(issue: Issue): Priority {
  const text = `${issue.title} ${issue.body}`.toLowerCase();
  if (/\b(bug|broken|crash|regression|fix)\b/.test(text)) return "bug";
  if (/\b(tracer|wire|poc)\b/.test(text)) return "tracer";
  if (/\brefactor\b/.test(text)) return "refactor";
  return "polish";
}

export function compareIssues(a: Issue, b: Issue): number {
  const pa = PRIORITY_ORDER.indexOf(classifyPriority(a));
  const pb = PRIORITY_ORDER.indexOf(classifyPriority(b));
  if (pa !== pb) return pa - pb;
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return ta - tb;
  return a.number - b.number;
}

export type IssueWorkUnit = { issue: Issue; resolution: BaseResolution };

/** Pick the highest-priority workable issue, or `null` when none qualify. */
export function selectIssue(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  stackConfig: StackConfig,
  phoebeBase?: string,
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): IssueWorkUnit | null {
  // Quarantined issues/research tickets (#75) are skipped for work until a human
  // clears the label or the issue is edited (the auto-un-stick sweep).
  const eligible = issues.filter((issue) => !issue.labels.includes(PHOEBE_QUARANTINE_LABEL));
  const sorted = [...eligible].sort(compareIssues);
  for (const issue of sorted) {
    const resolution = resolveWorktreeBase(
      issue,
      blockerStates,
      phoebeBase,
      nativeBlockersByIssue.get(issue.number) ?? [],
      stackConfig,
    );
    if (resolution) {
      return { issue, resolution };
    }
  }
  return null;
}

/**
 * The full `issues` work order, ordered as {@link selectIssue} would take it,
 * with each entry's resolved blocker set and whether it is workable this
 * cycle — the status-v2 `queue` lookahead. Unlike `selectIssue`, which stops
 * at the first workable candidate, this walks every eligible issue so an
 * operator can see what comes after `activeWork`, not just what runs next.
 */
export function buildIssueQueue(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  stackConfig: StackConfig,
  phoebeBase?: string,
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): Array<{ issueNumber: number; blockedBy: readonly number[]; workable: boolean }> {
  const eligible = issues.filter((issue) => !issue.labels.includes(PHOEBE_QUARANTINE_LABEL));
  const sorted = [...eligible].sort(compareIssues);
  return sorted.map((issue) => {
    const nativeBlockers = nativeBlockersByIssue.get(issue.number) ?? [];
    return {
      issueNumber: issue.number,
      blockedBy: issueBlockers(issue, stackConfig, nativeBlockers),
      workable:
        resolveWorktreeBase(issue, blockerStates, phoebeBase, nativeBlockers, stackConfig) !== null,
    };
  });
}

export function buildInitialPrBody(opts: {
  issueNumber: number;
  commitCount: number;
  stacked?: { blockerIssueNumber: number; blockerPrNumber: PrNumber };
}): string {
  const parts = [`Closes #${opts.issueNumber}`, "", "Automated PR from Phoebe.", ""];
  if (opts.stacked) {
    parts.push(
      `⛓️ Blocked by #${opts.stacked.blockerIssueNumber} (PR #${opts.stacked.blockerPrNumber}). ` +
        `Its commits appear in this diff until #${opts.stacked.blockerPrNumber} merges. ` +
        `**Do not merge this PR before #${opts.stacked.blockerPrNumber}** — doing so would pull ` +
        `#${opts.stacked.blockerIssueNumber}'s work into \`main\` ahead of its own review.`,
      "",
    );
  }
  parts.push(`Commits: ${opts.commitCount}`);
  return parts.join("\n");
}

/** Incremental note for follow-up pushes — no stacked-PR banner. */
export function followUpPrComment(issueNumber: number, commitCount: number): string {
  return `Phoebe update for #${issueNumber}: ${commitCount} new commit(s) pushed to this branch.`;
}

/**
 * Failure signature for an issue/research unit that ran and produced no PR
 * (#22) — the verification command the agent's own report last failed on
 * (e.g. `apply_patch`), so the cause is visible on the issue without
 * container logs. Falls back to the agent's exit code, then a generic
 * marker when neither signal is available (a clean exit with no commits).
 */
export function issueAttemptFailureSignature(opts: {
  failedCommand?: string;
  agentExitCode: number | null;
}): string {
  if (opts.failedCommand) {
    return slugifyFailureSignature(`${opts.failedCommand}-failed`);
  }
  if (opts.agentExitCode !== null && opts.agentExitCode !== 0) {
    return slugifyFailureSignature(`agent-exit-${opts.agentExitCode}`);
  }
  return "no-commit-produced";
}

type ProducerData = {
  issues: readonly Issue[];
  blockerStates: ReadonlyMap<number, BlockerPrState>;
  nativeBlockers: NativeBlockerMap;
};

type ProducerSpec = {
  name: "issues" | "research";
  label: string;
  promptFile: string;
  lease: boolean;
  unitNoun: string;
};

function stackConfigFrom(config: KindDeps["config"]): StackConfig {
  return {
    blockedByPattern: config.blockedByPattern,
    blockerSource: config.blockerSource,
    branchPrefix: config.branchPrefix,
    stackMode: config.stackMode,
  };
}

function verificationReportPath(worktreeDir: string): string {
  return `${worktreeDir}.verification.json`;
}

function phoebeBaseOverride(): string | undefined {
  return process.env["PHOEBE_BASE"];
}

function createProducerKind(
  deps: KindDeps,
  spec: ProducerSpec,
): WorkKind<ProducerData, IssueWorkUnit> {
  const { config, io } = deps;
  const { phoebeLog, phoebeError } = createPhoebeLog(config.repoSlug);
  const stackConfig = stackConfigFrom(config);

  async function fetch(ctx: CycleContext): Promise<ProducerData> {
    const issues = spec.name === "issues" ? ctx.pools.ready : ctx.pools.research;
    return { issues, blockerStates: ctx.blockerStates, nativeBlockers: ctx.nativeBlockers };
  }

  function select(data: ProducerData): IssueWorkUnit | null {
    return selectIssue(
      data.issues,
      data.blockerStates,
      stackConfig,
      phoebeBaseOverride(),
      data.nativeBlockers,
    );
  }

  function refFor(unit: IssueWorkUnit): UnitRef {
    return {
      kind: spec.name,
      target: { type: "issue", number: unit.issue.number },
      branch: issueBranch(config.branchPrefix, unit.issue.number),
    };
  }

  function describeIdle(data: ProducerData): string | null {
    if (data.issues.length === 0) {
      return null;
    }
    if (select(data)) {
      return null;
    }
    return `${data.issues.length} ${spec.label} ${spec.unitNoun}(s) but none workable this cycle (blocked or waiting on blocker PR).`;
  }

  function registerNativeStack(link: { predecessor: BranchRef; successor: BranchRef }): void {
    try {
      io.github.linkStack(link.predecessor, link.successor);
    } catch (error) {
      phoebeError(
        `gh stack link failed — the PR bases off the blocker branch but is not ` +
          `registered as a native stack. Register it manually with \`gh stack link ${link.predecessor} ${link.successor}\`. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  function resetIssueAttemptCounter(issueNumber: number): void {
    const comments = io.github.issueActivity(issueNumber).comments;
    const found = findLatestUnitAttemptComment(comments, spec.name);
    if (!found) {
      return;
    }
    io.github.updateComment(
      found.commentId,
      `✅ Phoebe produced a PR for this ${spec.name === "issues" ? "issue" : "research ticket"} — the no-PR attempt counter is reset.`,
    );
  }

  function recordFailedIssueAttempt(opts: {
    issueNumber: number;
    signature: string;
    dependentsPool: readonly Issue[];
    nativeBlockersByIssue: NativeBlockerMap;
  }): void {
    const comments = io.github.issueActivity(opts.issueNumber).comments;
    const found = findLatestUnitAttemptComment(comments, spec.name);
    const k = config.maxUnitAttempts;
    const plan = planUnitAttempt({
      previous: found?.marker ?? null,
      ref: String(opts.issueNumber),
      signature: opts.signature,
      now: new Date().toISOString(),
      k,
    });

    const body = plan.quarantined
      ? buildQuarantineComment({
          kind: spec.name,
          id: opts.issueNumber,
          k,
          baseline: io.github.issueActivity(opts.issueNumber).updatedAt,
          reason: "was claimed and released with no PR",
          signature: opts.signature,
          dependents: findBlockedDependents(
            opts.issueNumber,
            opts.dependentsPool,
            { blockedByPattern: config.blockedByPattern, blockerSource: config.blockerSource },
            opts.nativeBlockersByIssue,
          ),
        })
      : `⚠️ Phoebe claimed this ${spec.name === "issues" ? "issue" : "research ticket"} and released it ` +
        `with no PR (attempt ${plan.marker.n}/${k}, \`${opts.signature}\`). It stays in the ready queue ` +
        `and will retry once the claim lease expires.`;
    const fullBody = `${body}\n\n${buildUnitAttemptMarker(spec.name, plan.marker)}`;
    if (found?.commentId) {
      io.github.updateComment(found.commentId, fullBody);
    } else {
      io.github.commentIssue(opts.issueNumber, fullBody);
    }

    if (plan.quarantined) {
      io.github.labelIssue(opts.issueNumber, PHOEBE_QUARANTINE_LABEL);
      phoebeLog(
        `Quarantined ${spec.name} #${opts.issueNumber} after ${plan.marker.n} claims with no PR (${opts.signature}).`,
      );
    }
  }

  /**
   * Work a single issue-shaped ticket: branch off the resolved base, run the
   * given prompt, and — only when the agent left commits — push and open (or
   * update) a PR. A research ticket that resolves as an issue-level artifact
   * (comment + close + map update, done by the prompt) leaves no commits, so
   * no PR is opened; one that produces a committed doc does.
   */
  async function runOneIssue(opts: {
    issueNumber: number;
    issueTitle: string;
    worktreeBase: string;
    stacked: boolean;
    blockerIssueNumber?: number;
    blockerPrNumber?: PrNumber;
    dependentsPool: readonly Issue[];
    nativeBlockersByIssue: NativeBlockerMap;
  }): Promise<UnitResult> {
    const { issueNumber, issueTitle, worktreeBase, stacked, blockerIssueNumber, blockerPrNumber } =
      opts;
    const agentBranch = issueBranch(config.branchPrefix, issueNumber);

    io.git.fetchOrigin();
    const worktreeDir = io.git.prepareWorktree({ branch: agentBranch, baseRef: worktreeBase });
    const reportPath = verificationReportPath(worktreeDir);
    removeVerificationReport(reportPath);
    try {
      io.shell.run(config.installCommand, worktreeDir);

      const template = io.prompts.load(spec.promptFile);
      const prompt = io.prompts.render(
        template,
        {
          ...io.prompts.defaultArgs(),
          ISSUE_NUMBER: String(issueNumber),
          ISSUE_REF: `#${issueNumber}`,
          VERIFICATION_RESULT_FILE: reportPath,
        },
        worktreeDir,
      );
      const agentExitCode = await io.agent.run({ worktreeDir, prompt });
      const verification = readVerificationReport(reportPath);

      const newCommitCount = io.git.commitCount(worktreeDir, `${worktreeBase}..HEAD`);

      if (newCommitCount > 0) {
        io.git.pushBranch(worktreeDir, agentBranch);
      }
      // Looked up regardless of `newCommitCount` (#22): an issue reclaimed after
      // its PR already opened must read as "has a PR", not as a fresh no-progress
      // attempt, even when this particular run added nothing.
      const existingPr = io.github.prNumberForHead(agentBranch, "open");

      if (newCommitCount > 0) {
        if (existingPr === undefined) {
          const plan = resolveStackedPrPlan({
            issueNumber,
            resolution: { stacked, blockerIssueNumber },
            stackMode: config.stackMode,
            defaultBranch: config.defaultBranch,
            branchPrefix: config.branchPrefix,
          });
          const prTitle = `Phoebe: ${issueTitle} (#${issueNumber})`;
          const prBody = buildInitialPrBody({
            issueNumber,
            commitCount: newCommitCount,
            ...(plan.includeBanner &&
            blockerIssueNumber !== undefined &&
            blockerPrNumber !== undefined
              ? { stacked: { blockerIssueNumber, blockerPrNumber } }
              : {}),
          });
          // Create the PR *first* with Phoebe's own title/body (base = the blocker
          // branch in native mode), then register the stack — so `gh stack link`
          // only corrects the base chain and never auto-generates a title over
          // ours.
          io.github.createPr({
            head: agentBranch,
            base: plan.prBase,
            title: prTitle,
            body: prBody,
          });
          if (plan.stackLink) {
            registerNativeStack(plan.stackLink);
          }
        } else {
          phoebeLog(
            `PR #${existingPr} already exists for ${agentBranch} — posting follow-up note.`,
          );
          io.github.commentPr(existingPr, followUpPrComment(issueNumber, newCommitCount));
        }
      } else {
        phoebeLog("No commits — skipping PR creation.");
      }

      // #22: count claim→release cycles that end with no PR for this issue, and
      // quarantine at threshold.
      if (newCommitCount > 0 || existingPr !== undefined) {
        resetIssueAttemptCounter(issueNumber);
      } else {
        const failedCommand = verification?.find((v) => v.status === "failed")?.command;
        recordFailedIssueAttempt({
          issueNumber,
          signature: issueAttemptFailureSignature({ failedCommand, agentExitCode }),
          dependentsPool: opts.dependentsPool,
          nativeBlockersByIssue: opts.nativeBlockersByIssue,
        });
      }

      return { exitCode: agentExitCode, verification };
    } finally {
      removeVerificationReport(reportPath);
      io.git.removeWorktree(worktreeDir);
    }
  }

  function claimIssueLease(opts: {
    issueNumber: number;
    branch: BranchRef;
    runtimeId: string;
    claimedAt: string;
  }): void {
    io.github.commentIssue(
      opts.issueNumber,
      buildLeaseComment({
        runtimeId: opts.runtimeId,
        claimedAt: opts.claimedAt,
        heartbeatAt: opts.claimedAt,
        branch: opts.branch,
      }),
    );
    // Add-then-remove as two explicit calls (#81): a failure between them
    // leaves both labels — recoverable by the reclaim sweep — rather than
    // neither, which nothing can find.
    io.github.labelIssue(opts.issueNumber, config.processingLabel);
    io.github.unlabelIssue(opts.issueNumber, config.readyLabel);
  }

  function startLeaseHeartbeat(opts: {
    issueNumber: number;
    branch: BranchRef;
    runtimeId: string;
    claimedAt: string;
    ttlMs: number;
  }): () => void {
    const timer = setInterval(() => {
      try {
        io.github.commentIssue(
          opts.issueNumber,
          buildLeaseComment({
            runtimeId: opts.runtimeId,
            claimedAt: opts.claimedAt,
            heartbeatAt: new Date().toISOString(),
            branch: opts.branch,
          }),
        );
      } catch (error) {
        phoebeError(
          `Lease heartbeat failed for #${opts.issueNumber} — ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }, leaseHeartbeatIntervalMs(opts.ttlMs));
    timer.unref();
    return () => clearInterval(timer);
  }

  async function run(unit: IssueWorkUnit, ctx: CycleContext): Promise<UnitResult> {
    const { issue: target, resolution } = unit;
    const dependentsPool = [...ctx.pools.ready, ...ctx.pools.research];
    const verb = spec.name === "issues" ? "Working" : "Researching";
    phoebeLog(
      `${verb} #${target.number} — base ${resolution.worktreeBase}` +
        (resolution.stacked ? ` (stacked on #${resolution.blockerIssueNumber})` : "") +
        ".",
    );

    const runOpts = {
      issueNumber: target.number,
      issueTitle: target.title,
      worktreeBase: resolution.worktreeBase,
      stacked: resolution.stacked,
      blockerIssueNumber: resolution.blockerIssueNumber,
      blockerPrNumber: resolution.blockerPrNumber,
      dependentsPool,
      nativeBlockersByIssue: ctx.nativeBlockers,
    };

    if (!spec.lease) {
      return runOneIssue(runOpts);
    }

    // #15: the engine claims the lease itself (marker comment, then the label
    // flip) before the agent ever starts, and refreshes the heartbeat while it
    // runs — so a crash mid-run leaves a claim the next boot/cycle can reclaim,
    // rather than a bare label flip nothing ever re-examines.
    const branch = issueBranch(config.branchPrefix, target.number);
    const claimedAt = new Date().toISOString();
    claimIssueLease({ issueNumber: target.number, branch, runtimeId: ctx.runtimeId, claimedAt });
    const stopHeartbeat = startLeaseHeartbeat({
      issueNumber: target.number,
      branch,
      runtimeId: ctx.runtimeId,
      claimedAt,
      ttlMs: config.leaseTtlMs,
    });
    try {
      return await runOneIssue(runOpts);
    } finally {
      stopHeartbeat();
    }
  }

  const kind: WorkKind<ProducerData, IssueWorkUnit> = {
    name: spec.name,
    oneShot: true,
    fetch,
    select,
    run,
    refFor,
    describeIdle,
  };
  if (spec.lease) {
    kind.sweep = (ctx: CycleContext) =>
      reclaimStaleClaims(deps, { runtimeId: ctx.runtimeId, forceOwnReclaim: false });
  }
  return kind;
}

export function createIssuesKind(deps: KindDeps): WorkKind<ProducerData, IssueWorkUnit> {
  return createProducerKind(deps, {
    name: "issues",
    label: deps.config.readyLabel,
    promptFile: deps.config.promptFiles.issue,
    lease: true,
    unitNoun: "issue",
  });
}

export function createResearchKind(deps: KindDeps): WorkKind<ProducerData, IssueWorkUnit> {
  return createProducerKind(deps, {
    name: "research",
    label: deps.config.researchLabel,
    promptFile: deps.config.promptFiles.research,
    lease: false,
    unitNoun: "ticket",
  });
}

/**
 * Self-recovery sweep for orphaned `processingLabel` claims (#15). Every
 * `processingLabel` issue's lease marker (its latest matching comment) is
 * read back and, per `reclaimDecision`, flipped back to `readyLabel` when it
 * has no marker, is this runtime's own claim from before a restart
 * (`forceOwnReclaim`, boot only), or its heartbeat has gone stale past the
 * TTL. A quarantined issue (#75) is left alone — that label already means a
 * human needs to look at it. Exported so `runEngine`'s boot preflight can run
 * it once with `forceOwnReclaim: true`, ahead of the issues kind's per-cycle
 * `sweep` (`forceOwnReclaim: false`).
 */
export async function reclaimStaleClaims(
  deps: KindDeps,
  opts: { runtimeId: string; forceOwnReclaim: boolean },
): Promise<void> {
  const { config, io } = deps;
  const { phoebeLog } = createPhoebeLog(config.repoSlug);
  const nowMs = Date.now();
  for (const issue of io.github.issuesWithLabel(config.processingLabel)) {
    if (issue.labels.includes(PHOEBE_QUARANTINE_LABEL)) continue;
    const bodies = io.github.issueActivity(issue.number).comments.map((c) => c.body);
    const lease = parseLatestMarker(bodies, parseLeaseMarker);
    const reason = reclaimDecision(lease, {
      ownRuntimeId: opts.runtimeId,
      nowMs,
      ttlMs: config.leaseTtlMs,
      forceOwnReclaim: opts.forceOwnReclaim,
    });
    if (reason === null) continue;
    phoebeLog(`Reclaiming #${issue.number} (${reason}) back to ${config.readyLabel}.`);
    io.github.labelIssue(issue.number, config.readyLabel);
    io.github.unlabelIssue(issue.number, config.processingLabel);
    io.github.commentIssue(issue.number, buildReclaimComment(reason));
  }
}
