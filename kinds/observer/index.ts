// The `observer` catalog kind (#934, spec #924, decisions #920 and #916): look
// back over the tenant's unit history, flag the units that went wrong, have
// one read-only agent run group them into findings, and file one proposal per
// finding for a person to review.
//
// It ships in the engine and registers only when a tenant declares it, in a
// pipeline of its own (`pipelines.observe.kinds.observer`, with
// `path: "phoebe-agent/kinds/observer"`), so it may value-import engine helpers
// where a tenant module could not.
//
// Shape:
//   - one unit, ref `observer`. `fetch` reads the observer's own unit history
//     and offers the unit once `every` has passed since its last completed
//     run. The history is on disk, so a restart does not reset the clock.
//     With no `every` it never offers one on its own;
//   - a manual run (#937: `phoebe observe`, `POST /api/observe`) arrives
//     through `ctx.takeManualRun`. `fetch` offers the unit for it whatever
//     `every` says, carrying the run's own `lookback` when it named one;
//   - `run` reads every other pipeline's history, read-only, and flags units
//     from their records and from what became of their PRs (#935,
//     pr-outcomes.ts). A unit on an observer proposal is never flagged. The
//     agent sees only the flagged units and the proposals already filed, and
//     writes its findings to scratch;
//   - code files from the findings, each labelled `phoebe:observer`, never
//     the ready label, and carrying
//     `<!-- phoebe-observer finding=<category>:<target> -->`. In PR mode (the
//     default, #936) a convention or factory finding gets one edit run in a
//     fresh worktree, and code opens a PR from it when every path it changed
//     is on the allowlist (edit.ts, pr-proposal.ts); every other finding, and
//     an edit that strays, is an issue. GitHub is the record: one issue search
//     and one PR search across every state read the markers back, and the
//     rules in proposals.ts decide file, fold or skip;
//   - the run's summary becomes its unit record's `detail`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UnitRecord } from "../../src/contracts/unit-record.ts";
import type { PhoebeConfig } from "../../src/config-schema.ts";
import { defaultGit, type GitRunner } from "../../src/git-model.ts";
import { readUnitHistory } from "../../src/history.ts";
import { asPrNumber } from "../../src/branded.ts";
import {
  addLabelCreatingIfMissing,
  addUnitLabelCreatingIfMissing,
  type PhoebeLabel,
} from "../../src/labels.ts";
import { pipelineOwnedKinds } from "../../src/pipeline.ts";
import {
  defineWorkKind,
  type WorkKindCtx,
  type WorkKindDefinition,
  type WorkKindRunCtx,
  type WorkKindRunResult,
} from "../../src/work-kinds/definition.ts";
import {
  evidenceLine,
  renderBody,
  renderFoldComment,
  renderSummary,
  renderTitle,
  type EditAttemptNote,
  type RunTally,
} from "./body.ts";
import { proposalBranch } from "./edit.ts";
import {
  coverageOf,
  flagUnits,
  observerGate,
  renderCoverage,
  unitsSince,
  type FlaggedUnit,
  type PipelineHistory,
} from "./evidence.ts";
import { FINDINGS_FILE, parseFindings, type Category, type Finding } from "./findings.ts";
import { everyMs, resolveObserverOptions, type ObserverOptions } from "./options.ts";
import {
  gatherPrOutcomes,
  isProposalUnit,
  parseRevertLog,
  phoebeIdentityFrom,
  type RevertCommit,
} from "./pr-outcomes.ts";
import {
  decideFinding,
  listedUnitKeys,
  MARKER_TEXT,
  parseFindingMarker,
  PROPOSAL_LABEL,
  type Proposal,
} from "./proposals.ts";
import { proposeByPr } from "./pr-proposal.ts";

export const OBSERVER_KIND_NAME = "observer";

/** The kind's own prompt, an absolute path into the engine checkout. */
export const OBSERVER_PROMPT_FILE = join(import.meta.dirname, "prompt.md");

/** The label every proposal wears. Never the ready label: a person decides. */
export const OBSERVER_LABEL: PhoebeLabel = {
  name: PROPOSAL_LABEL,
  description: "Proposed by Phoebe's observer; a person decides whether it becomes work",
};

/**
 * The observer's one unit. `revision` moves when a run completes. A manual
 * run carries who asked and, when they named one, its own lookback.
 */
export type ObserverUnit = {
  ref: string;
  revision: string;
  manual?: { by: string; lookback: string | null };
};

export type ObserverGathered = { unit: ObserverUnit | null };

/**
 * Test seams: where unit history is read from, the git that reads revert
 * commits, and the runtime root.
 */
export type ObserverKindDeps = {
  readHistory?: (dir: string) => UnitRecord[];
  git?: GitRunner;
  /**
   * Where the governing config and `prompts/` live: the process cwd, as for
   * every prompt the engine loads.
   */
  runtimeRoot?: string;
};

/** The categories PR mode proposes as a PR. The rest are always issues. */
const PR_CATEGORIES: ReadonlySet<Category> = new Set(["convention", "factory"]);

/** How each fallback reads in the run's log. */
const ATTEMPT_LOG: Record<EditAttemptNote["reason"], string> = {
  empty: "the edit run changed nothing",
  outside: "the edit run changed paths outside the allowlist",
  untracked: "the fix edits files this repository does not track",
};

/**
 * The pipeline that declares the observer. It must schedule nothing else:
 * the observer never reads its own pipeline's history, so sharing one with
 * real work would hide that work from it, and an observer run would hold a
 * slot that work wanted.
 */
export function observerPipelineOf(config: PhoebeConfig, at: string): string {
  for (const [name, pipeline] of Object.entries(config.pipelines)) {
    if (pipeline.kinds[OBSERVER_KIND_NAME] === undefined) continue;
    const others = pipelineOwnedKinds({ pipelines: config.pipelines, name, pipeline }).filter(
      (kind) => kind !== OBSERVER_KIND_NAME,
    );
    if (others.length > 0) {
      throw new Error(
        `${at}: the observer needs a pipeline of its own, and \`pipelines.${name}\` also ` +
          `runs ${others.join(", ")}. Declare it under a new pipeline, e.g. ` +
          `\`pipelines.observe.kinds.observer\`.`,
      );
    }
    return name;
  }
  throw new Error(`${at}: no pipeline declares the observer kind.`);
}

/** Every proposal filed before, issues and PRs alike. */
function proposalsOf(ctx: WorkKindCtx): Proposal[] {
  const proposals: Proposal[] = [];
  for (const hit of ctx.github.listIssuesMentioning(MARKER_TEXT)) {
    const key = parseFindingMarker(hit.body);
    if (key === null) continue;
    proposals.push({
      number: hit.number,
      pr: false,
      key,
      body: hit.body,
      state: hit.state,
      stateReason: hit.stateReason,
      closedAt: hit.closedAt,
    });
  }
  for (const hit of ctx.github.listPrsMentioning(MARKER_TEXT)) {
    const key = parseFindingMarker(hit.body);
    if (key === null) continue;
    proposals.push({
      number: hit.number,
      pr: true,
      key,
      body: hit.body,
      state: hit.state,
      stateReason: hit.state === "open" ? null : hit.merged ? "completed" : "not_planned",
      closedAt: hit.closedAt,
    });
  }
  return proposals;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createObserverKind(
  config: PhoebeConfig,
  options: ObserverOptions,
  deps: ObserverKindDeps = {},
): WorkKindDefinition<ObserverGathered, ObserverUnit> {
  const at = `kinds.${OBSERVER_KIND_NAME}`;
  const ownPipeline = observerPipelineOf(config, at);
  const readHistory = deps.readHistory ?? ((dir: string) => readUnitHistory(dir));
  const git = deps.git ?? defaultGit;
  const runtimeRoot = deps.runtimeRoot ?? process.cwd();
  const historyDir = (pipeline: string): string => join(config.paths.stateDir, pipeline);

  /** The lookback a unit runs over: its manual run's own, else the configured one. */
  const lookbackOf = (unit: ObserverUnit): string => unit.manual?.lookback ?? options.lookback;

  /** Every other pipeline's history, in declaration order. */
  function otherHistories(): PipelineHistory[] {
    return Object.keys(config.pipelines)
      .filter((pipeline) => pipeline !== ownPipeline)
      .map((pipeline) => ({ pipeline, records: readHistory(historyDir(pipeline)) }));
  }

  /** The flagged units the grouping run is shown, each under a short id. */
  function writeFlagged(path: string, flagged: readonly FlaggedUnit[]): Map<string, FlaggedUnit> {
    const byId = new Map<string, FlaggedUnit>();
    const rows = flagged.map((unit, index) => {
      const id = `u${index + 1}`;
      byId.set(id, unit);
      const { record } = unit;
      return {
        id,
        pipeline: unit.pipeline,
        kind: record.unit.kind,
        ref: record.unit.id,
        flags: unit.flags,
        startedAt: record.startedAt,
        settledAt: record.settledAt,
        detail: record.detail,
        provider: record.provider,
        model: record.model,
        prNumber: unit.pr?.number ?? record.prNumber,
        pr: unit.pr,
      };
    });
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`);
    return byId;
  }

  /**
   * Revert commits on the default branch since `since`, from the run's own
   * read-only checkout: no API call. A revert made with `git revert` says
   * "This reverts commit <sha>". When git cannot answer, the revert PR search
   * still stands, so this logs and reads none.
   */
  function revertCommitsSince(ctx: WorkKindRunCtx, since: Date): RevertCommit[] {
    try {
      const output = git(
        [
          "-C",
          ctx.workspace.dir,
          "log",
          `--since=${since.toISOString()}`,
          "--grep=This reverts commit",
          "--format=%H%x1f%B%x1e",
        ],
        { stdio: "pipe" },
      );
      return parseRevertLog(output);
    } catch (error) {
      ctx.log(
        `could not read revert commits from the checkout, so only revert PRs count. ${message(error)}`,
      );
      return [];
    }
  }

  function writeProposals(path: string, proposals: readonly Proposal[]): void {
    const rows = proposals.map(({ number, pr, key, state, stateReason, closedAt }) => ({
      number,
      pr,
      key,
      state,
      stateReason,
      closedAt,
    }));
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`);
  }

  /** Add the label to a filed proposal; a failure is logged, never thrown. */
  function label(ctx: WorkKindCtx, finding: Finding, number: number, pr: boolean): void {
    // The proposal exists and carries the marker, so the finding is filed
    // whatever happens next. A throw here would leave the run failed with the
    // proposal up; the label is attempted and a failure logged for a person.
    const log = (line: string) => ctx.log(line);
    try {
      if (pr) {
        addUnitLabelCreatingIfMissing(
          ctx.github,
          { objectType: "pr", id: number },
          OBSERVER_LABEL,
          log,
        );
      } else {
        addLabelCreatingIfMissing(ctx.github, number, OBSERVER_LABEL, log);
      }
    } catch (error) {
      ctx.log(
        `${finding.key}: filed #${number} but could not add "${OBSERVER_LABEL.name}" — ` +
          `add it by hand. ${message(error)}`,
      );
    }
  }

  function fileIssue(
    ctx: WorkKindCtx,
    finding: Finding,
    units: readonly FlaggedUnit[],
    lookback: string,
    regressionOf: number | null,
    attempt?: EditAttemptNote,
  ): number {
    const number = ctx.github.createIssue({
      title: renderTitle(finding),
      body: renderBody({
        finding,
        units,
        lookback,
        regressionOf,
        ...(attempt !== undefined ? { attempt } : {}),
      }),
    });
    label(ctx, finding, number, false);
    return number;
  }

  /**
   * File one proposal: in PR mode a convention or factory finding is an edit
   * run and, when the edit stays on the allowlist, a PR. Everything else, and
   * an edit that does not, is an issue.
   */
  async function fileProposal(
    ctx: WorkKindRunCtx,
    finding: Finding,
    units: readonly FlaggedUnit[],
    lookback: string,
    regressionOf: number | null,
    slot: number,
  ): Promise<{ number: number; pr: boolean; note: string }> {
    if (options.mode !== "pr" || !PR_CATEGORIES.has(finding.category)) {
      return {
        number: fileIssue(ctx, finding, units, lookback, regressionOf),
        pr: false,
        note: "",
      };
    }
    const title = renderTitle(finding);
    const outcome = await proposeByPr({
      ctx,
      finding,
      slot,
      branch: proposalBranch(ctx.config.branchPrefix, finding.key),
      title,
      body: renderBody({ finding, units, lookback, regressionOf, as: "pr" }),
      runtimeRoot,
      evidence: units.map(evidenceLine).join("\n"),
    });
    if (outcome.action === "pr") {
      label(ctx, finding, outcome.number, true);
      return { number: outcome.number, pr: true, note: ` as a PR on ${outcome.branch}` };
    }
    const number = fileIssue(ctx, finding, units, lookback, regressionOf, outcome.attempt);
    return { number, pr: false, note: ` as an issue: ${ATTEMPT_LOG[outcome.attempt.reason]}` };
  }

  return defineWorkKind<ObserverGathered, ObserverUnit>({
    name: OBSERVER_KIND_NAME,
    oneShotEligible: true,
    promptFile: OBSERVER_PROMPT_FILE,
    workspace: "readonly",
    report: {
      noun: "observer run(s)",
      describe: (unit) =>
        `${unit.manual === undefined ? "observer" : "manual observer"} run over the last ${lookbackOf(unit)}`,
    },

    async fetch(ctx) {
      // A manual run skips the `every` gate. It is taken here whatever happens
      // next, so one that finds a run in flight is dropped by `select`, never
      // queued.
      const manual = ctx.takeManualRun?.() ?? null;
      if (manual !== null) {
        return {
          unit: {
            ref: OBSERVER_KIND_NAME,
            revision: `manual:${manual.at}`,
            manual: { by: manual.by, lookback: manual.lookback },
          },
        };
      }
      if (options.every === null) return { unit: null };
      const gate = observerGate(
        readHistory(historyDir(ownPipeline)),
        OBSERVER_KIND_NAME,
        everyMs(options.every),
        ctx.clock.now(),
      );
      if (!gate.due) return { unit: null };
      return { unit: { ref: OBSERVER_KIND_NAME, revision: gate.lastCompletedAt ?? "never" } };
    },

    select(gathered, ctx) {
      const candidate = gathered.unit;
      if (candidate === null) return { unit: null, skipped: [], total: 0 };
      if (ctx.inFlight.has(candidate.ref)) {
        if (candidate.manual !== undefined) {
          ctx.log(
            `manual run asked for by ${candidate.manual.by} dropped: a run is already in flight.`,
          );
        }
        return { unit: null, skipped: [{ reason: "in flight", count: 1 }], total: 1 };
      }
      // An operator who asks for a run gets one: its revision is new, which is
      // the engine's own exit from an in-memory quarantine.
      if (ctx.quarantined.has(candidate.ref) && candidate.manual === undefined) {
        return { unit: null, skipped: [{ reason: "quarantined in memory", count: 1 }], total: 1 };
      }
      return { unit: candidate, skipped: [], total: 1 };
    },

    async run(unit, ctx): Promise<WorkKindRunResult> {
      const now = ctx.clock.now();
      const lookback = lookbackOf(unit);
      const lookbackMs = everyMs(lookback);
      if (unit.manual !== undefined) {
        ctx.log(`manual run asked for by ${unit.manual.by}, over the last ${lookback}.`);
      }
      const histories = otherHistories();
      const coverage = renderCoverage(
        histories.map((history) => coverageOf(history, now, lookbackMs)),
        lookback,
      );
      const units = unitsSince(histories, new Date(now.getTime() - lookbackMs));
      const tally: RunTally = { filed: [], foldedInto: [], skipped: 0 };
      const nothingFlagged = (): WorkKindRunResult => {
        const summary = `no flagged units, ${renderSummary(tally, coverage)}`;
        ctx.log(summary);
        return { summary };
      };
      if (units.length === 0) return nothingFlagged();

      const proposals = proposalsOf(ctx);
      const proposalIssues = new Set(proposals.map((proposal) => proposal.number));
      const outcomes = gatherPrOutcomes({
        units,
        github: ctx.github,
        revertCommits: (since) => revertCommitsSince(ctx, since),
        proposalIssues,
        phoebe: phoebeIdentityFrom(ctx.env),
        repoSlug: config.repoSlug,
        ignoredBranches: new Set([config.defaultBranch, `${config.branchPrefix}workspace`]),
        now,
      });
      const flagged = flagUnits(units, {
        onProposal: (unit) => isProposalUnit(unit.record, proposalIssues),
        prOutcome: (unit) => outcomes.get(unit.key),
      });
      if (flagged.length === 0) return nothingFlagged();
      const scratch = ctx.workspace.scratch;
      const flaggedPath = join(scratch, "flagged.json");
      const proposalsPath = join(scratch, "proposals.json");
      const findingsPath = join(scratch, FINDINGS_FILE);
      const byId = writeFlagged(flaggedPath, flagged);
      writeProposals(proposalsPath, proposals);

      await ctx.agent.run({
        promptArgs: {
          OBSERVER_LOOKBACK: lookback,
          OBSERVER_COVERAGE: coverage,
          FLAGGED_COUNT: String(flagged.length),
          FLAGGED_JSON: flaggedPath,
          PROPOSALS_JSON: proposalsPath,
          FINDINGS_JSON: findingsPath,
          SCRATCH_DIR: scratch,
        },
      });

      if (!existsSync(findingsPath)) {
        throw new Error(
          `the grouping run left no ${FINDINGS_FILE} in ${scratch}, so there is nothing to file.`,
        );
      }
      const parsed = parseFindings(readFileSync(findingsPath, "utf8"), new Set(byId.keys()));
      for (const line of parsed.dropped) ctx.log(`dropped ${line}.`);

      // The best-supported findings file first, so `maxProposals` keeps those.
      const findings = [...parsed.findings].sort((a, b) => b.units.length - a.units.length);
      for (const finding of findings) {
        const units = finding.units.map((id) => byId.get(id)!);
        const decision = decideFinding(
          proposals.filter((proposal) => proposal.key === finding.key),
          now,
        );

        if (decision.action === "skip") {
          tally.skipped += 1;
          ctx.log(`${finding.key}: skipped, ${decision.reason}.`);
          continue;
        }

        if (decision.action === "fold") {
          const { into } = decision;
          const comments = into.pr
            ? ctx.github.prCommentBodies(asPrNumber(into.number))
            : ctx.github.issueCommentBodies(into.number);
          const listed = listedUnitKeys([into.body, ...comments]);
          const fresh = units.filter((unit) => !listed.has(unit.key));
          if (fresh.length === 0) {
            tally.skipped += 1;
            ctx.log(`${finding.key}: skipped, #${into.number} already lists every unit.`);
            continue;
          }
          ctx.github.postUnitComment(
            { objectType: into.pr ? "pr" : "issue", id: into.number },
            renderFoldComment(fresh),
          );
          tally.foldedInto.push(into.number);
          ctx.log(`${finding.key}: ${fresh.length} new unit(s) added to #${into.number}.`);
          continue;
        }

        const regression = decision.regressionOf;
        const evidence =
          regression === null
            ? units
            : units.filter(
                (unit) => Date.parse(unit.record.startedAt) > Date.parse(regression.closedAt),
              );
        if (evidence.length === 0) {
          tally.skipped += 1;
          ctx.log(
            `${finding.key}: skipped, fixed in #${regression!.number} and no unit since ` +
              `ran into it.`,
          );
          continue;
        }
        if (tally.filed.length >= options.maxProposals) {
          tally.skipped += 1;
          ctx.log(
            `${finding.key}: skipped, this run already filed ${options.maxProposals} ` +
              `(maxProposals).`,
          );
          continue;
        }
        const filed = await fileProposal(
          ctx,
          finding,
          evidence,
          lookback,
          regression?.number ?? null,
          tally.filed.length + 1,
        );
        tally.filed.push(filed.number);
        ctx.log(
          `${finding.key}: filed #${filed.number}${filed.note}` +
            (regression === null ? "." : `, a regression of #${regression.number}.`),
        );
      }

      const summary = renderSummary(tally, coverage);
      ctx.log(summary);
      return { summary };
    },
  });
}

/**
 * The catalog entry point: the loader hands a factory the resolved config and
 * the block's root options. Validation throws here, at registration, so a bad
 * block fails `phoebe pipelines` and the pipeline's boot rather than a run.
 */
export default function observerKind(
  config: PhoebeConfig,
  options: unknown,
): WorkKindDefinition<ObserverGathered, ObserverUnit> {
  const at = `kinds.${OBSERVER_KIND_NAME}`;
  return createObserverKind(config, resolveObserverOptions(options, at));
}
