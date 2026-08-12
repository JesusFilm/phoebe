// The `issues` and `research` work kinds: two instances of one producer
// core, parameterized by label/prompt/lease. Both walk the same
// priority-ordered issue pool, resolve the same stacked-worktree base, and
// run the same agent-in-a-fresh-branch workflow; they differ only in which
// label's pool they draw from, which prompt they run, and whether picking up
// a ticket claims a crash-safe lease (#15) — `research` tickets are cheap to
// re-pick, so they skip the claim/heartbeat machinery entirely.

import { asBranchRef, type BranchRef, type PrNumber } from "../branded.ts";
import { createPhoebeLog } from "../phoebe-log.ts";
import {
  buildLeaseComment,
  buildReclaimComment,
  leaseHeartbeatIntervalMs,
  parseLeaseMarker,
  reclaimDecision,
} from "../claim-lease.ts";
import { parseLatestMarker } from "../markers.ts";
import type { ActivityComment } from "../github.ts";
import {
  filterBackoffEligible,
  findLatestUnitAttemptComment,
  PHOEBE_QUARANTINE_LABEL,
  type UnitMarker,
} from "../quarantine.ts";
import {
  readVerificationReport,
  removeVerificationReport,
  resolveVerification,
  runEngineVerification,
  type VerificationResult,
} from "../verification.ts";
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

/**
 * Bucket an issue into one of `PRIORITY_ORDER`'s four priorities. An explicit
 * `<priorityLabelPrefix>bug` / `tracer` / `polish` / `refactor` label wins
 * over the title/body keyword cascade (#87/#130); if more than one such label
 * is on the issue, the first bucket in `PRIORITY_ORDER` wins, same as the
 * cascade below resolves overlapping keywords.
 */
export function classifyPriority(issue: Issue, priorityLabelPrefix: string): Priority {
  const labeled = new Set(
    issue.labels
      .filter((label) => label.startsWith(priorityLabelPrefix))
      .map((label) => label.slice(priorityLabelPrefix.length)),
  );
  const labelMatch = PRIORITY_ORDER.find((bucket) => labeled.has(bucket));
  if (labelMatch) return labelMatch;

  const text = `${issue.title} ${issue.body}`.toLowerCase();
  if (/\b(bug|broken|crash|regression|fix)\b/.test(text)) return "bug";
  if (/\b(tracer|wire|poc)\b/.test(text)) return "tracer";
  if (/\brefactor\b/.test(text)) return "refactor";
  return "polish";
}

export function compareIssues(a: Issue, b: Issue, priorityLabelPrefix: string): number {
  const pa = PRIORITY_ORDER.indexOf(classifyPriority(a, priorityLabelPrefix));
  const pb = PRIORITY_ORDER.indexOf(classifyPriority(b, priorityLabelPrefix));
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
  priorityLabelPrefix: string,
  phoebeBase?: string,
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): IssueWorkUnit | null {
  // Quarantined issues/research tickets (#75) are skipped for work until a human
  // clears the label or the issue is edited (the auto-un-stick sweep).
  const eligible = issues.filter((issue) => !issue.labels.includes(PHOEBE_QUARANTINE_LABEL));
  const sorted = [...eligible].sort((a, b) => compareIssues(a, b, priorityLabelPrefix));
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
  priorityLabelPrefix: string,
  phoebeBase?: string,
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): Array<{ issueNumber: number; blockedBy: readonly number[]; workable: boolean }> {
  const eligible = issues.filter((issue) => !issue.labels.includes(PHOEBE_QUARANTINE_LABEL));
  const sorted = [...eligible].sort((a, b) => compareIssues(a, b, priorityLabelPrefix));
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
 * Typed park reason (#173) for an issue/research unit that ran and produced
 * no PR (#22) — a closed set rather than a command-derived free-text slug, so
 * the quarantine counter (`quarantine.ts#nextCount`) can tell a recurring
 * `verify-timeout` from a one-off `verify-failed` instead of conflating every
 * distinct cause into "no commit, again."
 */
export type IssueAttemptFailureReason =
  | "verify-timeout"
  | "verify-failed"
  | "agent-failed"
  | "no-commit";

/**
 * Failure reason for an issue/research unit that ran and produced no PR
 * (#22): a failed verification command (#166) outranks a nonzero agent exit,
 * since a report can carry both — the agent may exit 0 having declared
 * victory over a failing check. `timedOut` (#173) on any failed result
 * distinguishes a hang (`verify-timeout`) from an ordinary nonzero exit
 * (`verify-failed`) — checked across every failed command, not just the
 * first, since a hang is the more specific and more actionable signal when
 * one command timed out and another merely exited nonzero. Falls back to the
 * agent's exit code, then a generic marker when neither signal is available
 * (a clean exit with no commits).
 */
export function issueAttemptFailureSignature(opts: {
  verification: readonly VerificationResult[] | undefined;
  agentExitCode: number | null;
}): IssueAttemptFailureReason {
  const failures = opts.verification?.filter((v) => v.status === "failed") ?? [];
  if (failures.length > 0) {
    return failures.some((v) => v.timedOut) ? "verify-timeout" : "verify-failed";
  }
  if (opts.agentExitCode !== null && opts.agentExitCode !== 0) {
    return "agent-failed";
  }
  return "no-commit";
}

// --- Repro-test-must-fail-first (#171, competitive-landscape.md §4.8) -------
//
// A new or modified test that already passes against the pre-change tree
// proves nothing about the fix it's meant to cover — Agentless is the only
// competitor found to actually enforce this rather than merely prompt for it.
// After an issue unit commits, `runReproCheck` diffs for test-like paths
// touched since `worktreeBase`, replays just those files onto a throwaway
// worktree pinned to that same base, and installs + runs the test suite
// there. `git bisect --run`'s exit-code contract (exit 125 = "cannot test
// this tree", distinct from pass/fail) is mirrored as its own `untestable`
// verdict: an environment that can't run the pre-patch tree at all must not
// silently pass the gate, so it fails open (proceeds without blocking)
// instead.

/**
 * Cheap heuristic for "which new tests to run pre-patch" (#171): a path that
 * looks like a test by common convention across ecosystems — a
 * `*.test.*`/`*.spec.*`/`*_test.*`/`test_*.*` filename, or anything under a
 * `test(s)`/`__tests__`/`spec` directory. False positives just cost an extra
 * pre-patch run on a file that turns out not to be a test; false negatives
 * just mean the gate has nothing to check for that file — neither is a
 * correctness bug.
 */
const TEST_LIKE_PATH_RE =
  /(^|\/)(__tests__|tests?|spec)\/|(^|\/)test_[^/]+\.[^./]+$|[._-](tests?|specs?)\.[^./]+$/i;

export function isTestLikePath(path: string): boolean {
  return TEST_LIKE_PATH_RE.test(path);
}

export type ReproCheckOutcome =
  /** No test-like path changed in this unit's diff — nothing to check. */
  | { verdict: "no-tests" }
  /** The new/modified test(s) correctly fail against the pre-change tree. */
  | { verdict: "confirmed"; testFiles: readonly string[] }
  /** The new/modified test(s) already pass against the pre-change tree — discard this attempt. */
  | { verdict: "weak"; testFiles: readonly string[] }
  /** Could not run the pre-change tree at all — fails open rather than blocking on an inconclusive signal. */
  | { verdict: "untestable"; testFiles: readonly string[]; reason: string };

/** Stable, kind-independent signature for the `no-pr` quarantine counter. */
export const REPRO_GATE_FAILURE_SIGNATURE = "repro-test-passed-pre-patch";

/** The tracking-comment prose for a repro-gate discard, below quarantine threshold. */
export function reproGateBelowThresholdNote(
  n: number,
  k: number,
  testFiles: readonly string[],
): string {
  const files = testFiles.map((f) => `\`${f}\``).join(", ");
  return (
    `⚠️ Phoebe discarded this attempt (attempt ${n}/${k}, \`${REPRO_GATE_FAILURE_SIGNATURE}\`): the ` +
    `new/modified test(s) ${files} already pass against the pre-change tree, so they don't prove the fix ` +
    `does anything (repro-test-must-fail-first). Write a test that fails without the change — it stays in ` +
    `the ready queue and will retry once the claim lease expires.`
  );
}

type ProducerData = {
  issues: readonly Issue[];
  blockerStates: ReadonlyMap<number, BlockerPrState>;
  nativeBlockers: NativeBlockerMap;
};

/**
 * The newer of the unit's `no-pr` and `timed-out` markers (#137) — an
 * issue-keyed unit can carry both at once (a claim that timed out, then a
 * retry that produced no PR), and the backoff filter only needs the most
 * recent attempt to compute the current growing gap.
 */
function latestIssueAttemptMarker(
  comments: readonly ActivityComment[],
  kind: "issues" | "research",
): UnitMarker | null {
  const noPr = findLatestUnitAttemptComment(comments, kind, "no-pr")?.marker ?? null;
  const timedOut = findLatestUnitAttemptComment(comments, kind, "timed-out")?.marker ?? null;
  if (!noPr) return timedOut;
  if (!timedOut) return noPr;
  return timedOut.at > noPr.at ? timedOut : noPr;
}

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
    const pool = spec.name === "issues" ? ctx.pools.ready : ctx.pools.research;
    const nowIso = new Date().toISOString();
    const withMarkers = pool.map((candidate) => ({
      issue: candidate,
      // Quarantined issues are filtered downstream by `selectIssue`/`buildIssueQueue`
      // regardless — skip the activity fetch for them rather than burn an API call
      // on a unit that's excluded either way.
      attemptMarker: candidate.labels.includes(PHOEBE_QUARANTINE_LABEL)
        ? null
        : latestIssueAttemptMarker(io.github.issueActivity(candidate.number).comments, spec.name),
    }));
    // #137: a unit still inside its no-pr/timed-out backoff window sits this cycle
    // out — the same growing-gap protection the PR-keyed no-commit trigger already
    // gets (#25), now covering the triggers that previously churned at full cadence.
    const issues = filterBackoffEligible(withMarkers, nowIso).map((c) => c.issue);
    return { issues, blockerStates: ctx.blockerStates, nativeBlockers: ctx.nativeBlockers };
  }

  function select(data: ProducerData): IssueWorkUnit | null {
    return selectIssue(
      data.issues,
      data.blockerStates,
      stackConfig,
      config.priorityLabelPrefix,
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

  /** A run produced a PR (or one already existed) — the no-PR counter (#22) resets, since an issue-keyed `ref` never moves on its own to signal progress. */
  function resetIssueAttemptCounter(issueNumber: number): void {
    io.quarantine.resolve(
      { kind: spec.name, target: { type: "issue", number: issueNumber } },
      "no-pr",
      `✅ Phoebe produced a PR for this ${spec.name === "issues" ? "issue" : "research ticket"} — the no-PR attempt counter is reset.`,
    );
  }

  function recordFailedIssueAttempt(opts: {
    issueNumber: number;
    signature: string;
    dependentsPool: readonly Issue[];
    nativeBlockersByIssue: NativeBlockerMap;
    /** Override the default "was claimed and released with no PR" wording (#171's repro gate). */
    reason?: string;
    belowThresholdNote?: (n: number, k: number) => string;
  }): void {
    const dependents = findBlockedDependents(
      opts.issueNumber,
      opts.dependentsPool,
      { blockedByPattern: config.blockedByPattern, blockerSource: config.blockerSource },
      opts.nativeBlockersByIssue,
    );
    io.quarantine.record(
      { kind: spec.name, target: { type: "issue", number: opts.issueNumber } },
      "no-pr",
      {
        signature: opts.signature,
        reason: opts.reason ?? "was claimed and released with no PR",
        belowThresholdNote:
          opts.belowThresholdNote ??
          ((n, k) =>
            `⚠️ Phoebe claimed this ${spec.name === "issues" ? "issue" : "research ticket"} and released it ` +
            `with no PR (attempt ${n}/${k}, \`${opts.signature}\`). It stays in the ready queue ` +
            `and will retry once the claim lease expires.`),
        ...(dependents.length > 0 ? { dependents } : {}),
      },
    );
  }

  /**
   * The producer gate (#171): diff `worktreeDir` for test-like paths changed
   * since `worktreeBase`, replay just those onto a throwaway worktree pinned
   * to that same base, and install + run the test suite there. `verdict`
   * follows `ReproCheckOutcome` — `"weak"` (tests already pass pre-patch) is
   * the only verdict that blocks PR creation; `"untestable"` fails open
   * rather than treat an inconclusive signal as either pass or fail.
   */
  function runReproCheck(opts: {
    agentBranch: BranchRef;
    worktreeBase: string;
    worktreeDir: string;
  }): ReproCheckOutcome {
    const diffOutput = io.git.gitInWorktree(opts.worktreeDir, [
      "diff",
      "--name-only",
      "--diff-filter=AM",
      `${opts.worktreeBase}..HEAD`,
    ]);
    const testFiles = diffOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && isTestLikePath(line));
    if (testFiles.length === 0) {
      return { verdict: "no-tests" };
    }

    const reproBranch = asBranchRef(`${opts.agentBranch}--repro-check`);
    let reproWorktreeDir: string;
    try {
      reproWorktreeDir = io.git.prepareWorktree({
        branch: reproBranch,
        baseRef: opts.worktreeBase,
        force: true,
      });
    } catch (error) {
      return {
        verdict: "untestable",
        testFiles,
        reason: `could not prepare the pre-patch worktree — ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      io.git.gitInWorktree(reproWorktreeDir, ["checkout", opts.agentBranch, "--", ...testFiles]);

      try {
        io.shell.run(config.installCommand, reproWorktreeDir);
      } catch (error) {
        return {
          verdict: "untestable",
          testFiles,
          reason: `pre-patch install failed — ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      let exitCode: number;
      try {
        exitCode = io.shell.tryRun(config.testCommand, reproWorktreeDir);
      } catch (error) {
        return {
          verdict: "untestable",
          testFiles,
          reason: `pre-patch test run did not complete — ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // git bisect --run's convention: exit 125 means "cannot test this
      // tree", distinct from pass/fail — mirrored here rather than read as
      // a passing (0) or failing (any other non-zero) verdict.
      if (exitCode === 125) {
        return {
          verdict: "untestable",
          testFiles,
          reason: "the test command exited 125 (cannot test this tree)",
        };
      }
      return exitCode === 0 ? { verdict: "weak", testFiles } : { verdict: "confirmed", testFiles };
    } finally {
      try {
        io.git.removeWorktree(reproWorktreeDir, { force: true });
      } catch (error) {
        phoebeError(
          `Could not clean up the pre-patch repro worktree at ${reproWorktreeDir} — ` +
            `${error instanceof Error ? error.message : String(error)}.`,
        );
      }
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
    issueLabels: readonly string[];
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
      const {
        exitCode: agentExitCode,
        usage,
        costUsd,
      } = await io.agent.run({ worktreeDir, prompt, labels: opts.issueLabels });
      const verification = resolveVerification({
        verifyMode: config.verifyMode,
        agentReported: readVerificationReport(reportPath),
        runEngine: () =>
          runEngineVerification([config.checkCommand, config.testCommand], worktreeDir, (c, d) =>
            io.shell.capture(c, d),
          ),
        onDisagreement: (disagreements) =>
          phoebeLog(
            `⚠️ verification disagreement for issue #${issueNumber}: ${disagreements.join(" ")}`,
          ),
      });

      const newCommitCount = io.git.commitCount(worktreeDir, `${worktreeBase}..HEAD`);

      if (newCommitCount > 0) {
        io.git.pushBranch(worktreeDir, agentBranch);
      }
      // Looked up regardless of `newCommitCount` (#22): an issue reclaimed after
      // its PR already opened must read as "has a PR", not as a fresh no-progress
      // attempt, even when this particular run added nothing.
      const existingPr = io.github.prNumberForHead(agentBranch, "open");

      // The producer gate (#171): only worth running ahead of a *new* PR —
      // an already-open PR's follow-up push is a janitor-shaped concern, not
      // this unit's first-time "does the fix actually do anything" check.
      let reproOutcome: ReproCheckOutcome | null = null;
      if (newCommitCount > 0 && existingPr === undefined) {
        reproOutcome = runReproCheck({ agentBranch, worktreeBase, worktreeDir });
        if (reproOutcome.verdict === "untestable") {
          phoebeLog(
            `Repro check inconclusive for #${issueNumber} — ${reproOutcome.reason}. Proceeding without the gate.`,
          );
        }
      }
      const weakReproOutcome = reproOutcome?.verdict === "weak" ? reproOutcome : null;
      const reproGateFailed = weakReproOutcome !== null;

      if (newCommitCount > 0) {
        if (existingPr === undefined) {
          if (reproGateFailed) {
            phoebeLog(
              `Repro check: ${weakReproOutcome!.testFiles.join(", ")} already pass against the pre-change ` +
                `tree for #${issueNumber} — discarding this attempt without opening a PR.`,
            );
          } else {
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
      if ((newCommitCount > 0 && !reproGateFailed) || existingPr !== undefined) {
        resetIssueAttemptCounter(issueNumber);
      } else if (reproGateFailed) {
        recordFailedIssueAttempt({
          issueNumber,
          signature: REPRO_GATE_FAILURE_SIGNATURE,
          dependentsPool: opts.dependentsPool,
          nativeBlockersByIssue: opts.nativeBlockersByIssue,
          reason: "produced a test that already passed against the pre-change tree",
          belowThresholdNote: (n, k) =>
            reproGateBelowThresholdNote(n, k, weakReproOutcome!.testFiles),
        });
      } else {
        recordFailedIssueAttempt({
          issueNumber,
          signature: issueAttemptFailureSignature({ verification, agentExitCode }),
          dependentsPool: opts.dependentsPool,
          nativeBlockersByIssue: opts.nativeBlockersByIssue,
        });
      }

      return {
        exitCode: agentExitCode,
        verification,
        ...(usage !== undefined ? { usage } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
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
      issueLabels: target.labels,
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
