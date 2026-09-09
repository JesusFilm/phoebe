// The prompt-only producer helper (#348 Q8): the recovered cheap case. The two
// built-in producers (`issues`, `research`) differ only in which label they
// list and which prompt they run, so a new issue-keyed producer is one call to
// `issueProducerKind` — a label, a prompt file, and a noun. Everything else
// (blocker-aware base resolution, priority ordering, quarantine skip, the
// PR-opening workflow) is the shared shape.

import {
  isLandedMember,
  selectIssue,
  unresolvedBlockerNumbers,
  type BaseResolution,
  type Issue,
} from "../orchestrator.ts";
import { addLabelCreatingIfMissing, processingLabelOf } from "../labels.ts";
import {
  defineWorkKind,
  type WorkKindCtx,
  type WorkKindDefinition,
  type WorkKindRunCtx,
  type WorkUnitGitHubTarget,
} from "./definition.ts";

export type IssueProducerGathered = { issues: readonly Issue[] };

export type IssueProducerUnit = {
  ref: string;
  github: WorkUnitGitHubTarget;
  issue: Issue;
  resolution: BaseResolution;
};

/**
 * One phrase per feature whose landed members are sitting in the queue —
 * `5 landed on feature #400` — ascending by feature number, so a quiet cycle
 * says which integration PR the finished work is waiting on (#485). A landed
 * member the cycle cannot place (its feature retired, or the graph read failed)
 * falls back to a bare `landed`, which sorts last.
 */
function landedCounts(issues: readonly Issue[], ctx: WorkKindCtx): string[] {
  const perFeature = new Map<number, number>();
  let unplaced = 0;
  for (const issue of issues) {
    if (!isLandedMember(issue, ctx.config.mergedLabel)) continue;
    const feature = ctx.cycle.feature(issue.number);
    if (feature) {
      perFeature.set(feature.issueNumber, (perFeature.get(feature.issueNumber) ?? 0) + 1);
    } else {
      unplaced += 1;
    }
  }
  const phrases = [...perFeature.entries()]
    .sort(([a], [b]) => a - b)
    .map(([featureNumber, count]) => `${count} landed on feature #${featureNumber}`);
  if (unplaced > 0) phrases.push(`${unplaced} landed`);
  return phrases;
}

/**
 * Why nothing was workable, naming the blockers when there are any — the bare
 * count is indistinguishable from a legitimate wait (#219). When all unblocked
 * issues carry processingLabel the queue is temporarily full, not stuck (#365),
 * and a landed member is neither: it is done and waiting on its feature, so it
 * is counted apart rather than swept into the fallback (#485). Named blockers
 * first, then the in-progress and landed counts, then the fallback.
 */
function idleBlockerReason(issues: readonly Issue[], ctx: WorkKindCtx): string {
  const waiting = unresolvedBlockerNumbers(
    issues,
    ctx.cycle.blockerStates(),
    ctx.env["PHOEBE_BASE"],
    ctx.config.processingLabel,
    (issueNumber) => ctx.cycle.feature(issueNumber),
  );
  if (waiting.length > 0) return `(waiting on blockers ${waiting.map((n) => `#${n}`).join(", ")})`;
  // Landed wins over in-progress for an issue wearing both, which is what the
  // swap looks like mid-flight — otherwise one member would be counted twice and
  // the numbers would not add up to the queue.
  const label = ctx.config.processingLabel;
  const processingCount = issues.filter(
    (i) => label && i.labels.includes(label) && !isLandedMember(i, ctx.config.mergedLabel),
  ).length;
  const counts = processingCount > 0 ? [`${processingCount} in progress`] : [];
  counts.push(...landedCounts(issues, ctx));
  if (counts.length > 0) return `(${counts.join(", ")})`;
  return "(blocked or waiting on blocker PR)";
}

/**
 * Apply `config.processingLabel` to `issueNumber` before the agent runs (#365).
 *
 * Returns `false` when a fresh label fetch shows the issue is already claimed
 * by another run — the caller should skip the workflow. Returns `true` when
 * the label was successfully applied.
 *
 * A pre-check before the add tightens the race window to the network round-trip
 * of a single API call; it is not atomic (GitHub labels have no test-and-set),
 * but it gives the caller a reliable skip signal when another instance already
 * owns the issue. A repo that has never seen the label gets it created on the
 * way through (src/labels.ts); any other failure propagates, aborting the unit
 * without running the agent.
 */
function claimIssue(issueNumber: number, ctx: WorkKindRunCtx): boolean {
  const label = processingLabelOf(ctx.config);
  if (ctx.github.issueLabels(issueNumber).includes(label.name)) return false;
  addLabelCreatingIfMissing(ctx.github, issueNumber, label, ctx.log);
  return true;
}

/**
 * Build an issue-keyed producer kind: fetch the labelled tickets, pick the
 * highest-priority workable one (blockers and quarantine respected), and run
 * one agent over it via the issue workflow. `unitNoun` is how one unit is
 * named in log lines ("issue", "research ticket"); `verb` opens the run's
 * narration ("Working", "Researching").
 */
export function issueProducerKind(opts: {
  name: string;
  promptFile: string;
  noun: string;
  unitNoun: string;
  verb: string;
  oneShotEligible?: boolean;
  listIssues: (ctx: WorkKindCtx) => Issue[];
}): WorkKindDefinition<IssueProducerGathered, IssueProducerUnit> {
  const { name, promptFile, noun, unitNoun, verb, listIssues } = opts;
  return defineWorkKind<IssueProducerGathered, IssueProducerUnit>({
    name,
    oneShotEligible: opts.oneShotEligible ?? true,
    promptFile,
    workspace: "worktree",
    report: {
      noun,
      describe: (unit) =>
        `${unitNoun} #${unit.issue.number} — base ${unit.resolution.worktreeBase}`,
      idle: (gathered, total, ctx) =>
        `${total} ${noun} but none workable this cycle ${idleBlockerReason(gathered.issues, ctx)}.`,
    },
    async fetch(ctx) {
      const issues = listIssues(ctx);
      ctx.cycle.registerIssues(issues);
      return { issues };
    },
    select(gathered, ctx) {
      const pick = selectIssue(
        gathered.issues,
        ctx.cycle.blockerStates(),
        ctx.env["PHOEBE_BASE"],
        ctx.config.processingLabel,
        (issueNumber) => ctx.cycle.feature(issueNumber),
      );
      return {
        unit: pick
          ? {
              ref: `issue:${pick.issue.number}`,
              github: { objectType: "issue", id: pick.issue.number },
              issue: pick.issue,
              resolution: pick.resolution,
            }
          : null,
        skipped: [],
        total: gathered.issues.length,
      };
    },
    async run(unit, ctx) {
      const { issue, resolution } = unit;
      ctx.log(
        `${verb} #${issue.number} — base ${resolution.worktreeBase}` +
          (resolution.stacked ? ` (stacked on #${resolution.blockerIssueNumber})` : "") +
          (resolution.featureIssueNumber !== undefined
            ? ` (feature #${resolution.featureIssueNumber})`
            : "") +
          ".",
      );
      if (!claimIssue(issue.number, ctx)) {
        ctx.log(
          `Issue #${issue.number} already carries processingLabel — another run owns it; skipping.`,
        );
        return;
      }
      if (resolution.featureIssueNumber !== undefined) {
        ctx.github.createFeatureBranch(resolution.featureIssueNumber);
        ctx.github.ensureDraftIntegrationPr(
          resolution.featureIssueNumber,
          resolution.featureIssueTitle ?? `Feature #${resolution.featureIssueNumber}`,
        );
      }
      await ctx.agent.issueWorkflow({
        issueNumber: issue.number,
        issueTitle: issue.title,
        worktreeBase: resolution.worktreeBase,
        stacked: resolution.stacked,
        ...(resolution.blockerIssueNumber !== undefined
          ? { blockerIssueNumber: resolution.blockerIssueNumber }
          : {}),
        ...(resolution.blockerPrNumber !== undefined
          ? { blockerPrNumber: resolution.blockerPrNumber }
          : {}),
        ...(resolution.featureIssueNumber !== undefined
          ? { featureIssueNumber: resolution.featureIssueNumber }
          : {}),
      });
    },
  });
}
