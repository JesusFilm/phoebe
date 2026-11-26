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
//     With no `every` it never offers one;
//   - `run` reads every other pipeline's history, read-only, and flags units
//     from their records alone. The agent sees only those units and the
//     proposals already filed, and writes its findings to scratch;
//   - code files from the findings. Each is an issue labelled
//     `phoebe:observer`, never the ready label, carrying
//     `<!-- phoebe-observer finding=<category>:<target> -->`. GitHub is the
//     record: one search across every state reads the markers back, and the
//     rules in proposals.ts decide file, fold or skip;
//   - the run's summary becomes its unit record's `detail`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UnitRecord } from "../../src/contracts/unit-record.ts";
import type { PhoebeConfig } from "../../src/config-schema.ts";
import { readUnitHistory } from "../../src/history.ts";
import { addLabelCreatingIfMissing, type PhoebeLabel } from "../../src/labels.ts";
import { pipelineOwnedKinds } from "../../src/pipeline.ts";
import {
  defineWorkKind,
  type WorkKindCtx,
  type WorkKindDefinition,
  type WorkKindRunResult,
} from "../../src/work-kinds/definition.ts";
import {
  renderBody,
  renderFoldComment,
  renderSummary,
  renderTitle,
  type RunTally,
} from "./body.ts";
import {
  coverageOf,
  flagUnits,
  observerGate,
  renderCoverage,
  type FlaggedUnit,
  type PipelineHistory,
} from "./evidence.ts";
import { FINDINGS_FILE, parseFindings, type Finding } from "./findings.ts";
import { everyMs, resolveObserverOptions, type ObserverOptions } from "./options.ts";
import {
  decideFinding,
  listedUnitKeys,
  MARKER_TEXT,
  parseFindingMarker,
  type Proposal,
} from "./proposals.ts";

export const OBSERVER_KIND_NAME = "observer";

/** The kind's own prompt, an absolute path into the engine checkout. */
export const OBSERVER_PROMPT_FILE = join(import.meta.dirname, "prompt.md");

/** The label every proposal wears. Never the ready label: a person decides. */
export const OBSERVER_LABEL: PhoebeLabel = {
  name: "phoebe:observer",
  description: "Proposed by Phoebe's observer; a person decides whether it becomes work",
};

/** The observer's one unit. `revision` moves when a run completes. */
export type ObserverUnit = { ref: string; revision: string };

export type ObserverGathered = { unit: ObserverUnit | null };

/** Test seam: where unit history is read from. */
export type ObserverKindDeps = {
  readHistory?: (dir: string) => UnitRecord[];
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

function proposalsOf(ctx: WorkKindCtx): Proposal[] {
  const proposals: Proposal[] = [];
  for (const hit of ctx.github.listIssuesMentioning(MARKER_TEXT)) {
    const key = parseFindingMarker(hit.body);
    if (key === null) continue;
    proposals.push({
      number: hit.number,
      key,
      body: hit.body,
      state: hit.state,
      stateReason: hit.stateReason,
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
  const historyDir = (pipeline: string): string => join(config.paths.stateDir, pipeline);
  const lookbackMs = everyMs(options.lookback);

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
        prNumber: record.prNumber,
      };
    });
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`);
    return byId;
  }

  function writeProposals(path: string, proposals: readonly Proposal[]): void {
    const rows = proposals.map(({ number, key, state, stateReason, closedAt }) => ({
      number,
      key,
      state,
      stateReason,
      closedAt,
    }));
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`);
  }

  function fileProposal(
    ctx: WorkKindCtx,
    finding: Finding,
    units: readonly FlaggedUnit[],
    regressionOf: number | null,
  ): number {
    const number = ctx.github.createIssue({
      title: renderTitle(finding),
      body: renderBody({ finding, units, lookback: options.lookback, regressionOf }),
    });
    // The issue exists and carries the marker, so the finding is filed whatever
    // happens next. A throw here would leave the run failed with the issue up;
    // the label is attempted and a failure logged for a person to repair.
    try {
      addLabelCreatingIfMissing(ctx.github, number, OBSERVER_LABEL, (line) => ctx.log(line));
    } catch (error) {
      ctx.log(
        `${finding.key}: filed #${number} but could not add "${OBSERVER_LABEL.name}" — ` +
          `add it by hand. ${message(error)}`,
      );
    }
    return number;
  }

  return defineWorkKind<ObserverGathered, ObserverUnit>({
    name: OBSERVER_KIND_NAME,
    oneShotEligible: true,
    promptFile: OBSERVER_PROMPT_FILE,
    workspace: "readonly",
    report: {
      noun: "observer run(s)",
      describe: () => `observer run over the last ${options.lookback}`,
    },

    async fetch(ctx) {
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
        return { unit: null, skipped: [{ reason: "in flight", count: 1 }], total: 1 };
      }
      if (ctx.quarantined.has(candidate.ref)) {
        return { unit: null, skipped: [{ reason: "quarantined in memory", count: 1 }], total: 1 };
      }
      return { unit: candidate, skipped: [], total: 1 };
    },

    async run(_unit, ctx): Promise<WorkKindRunResult> {
      const now = ctx.clock.now();
      const histories = otherHistories();
      const coverage = renderCoverage(
        histories.map((history) => coverageOf(history, now, lookbackMs)),
        options.lookback,
      );
      const flagged = flagUnits(histories, new Date(now.getTime() - lookbackMs));
      const tally: RunTally = { filed: [], foldedInto: [], skipped: 0 };
      if (flagged.length === 0) {
        const summary = `no flagged units, ${renderSummary(tally, coverage)}`;
        ctx.log(summary);
        return { summary };
      }

      const proposals = proposalsOf(ctx);
      const scratch = ctx.workspace.scratch;
      const flaggedPath = join(scratch, "flagged.json");
      const proposalsPath = join(scratch, "proposals.json");
      const findingsPath = join(scratch, FINDINGS_FILE);
      const byId = writeFlagged(flaggedPath, flagged);
      writeProposals(proposalsPath, proposals);

      await ctx.agent.run({
        promptArgs: {
          OBSERVER_LOOKBACK: options.lookback,
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
          const listed = listedUnitKeys([into.body, ...ctx.github.issueCommentBodies(into.number)]);
          const fresh = units.filter((unit) => !listed.has(unit.key));
          if (fresh.length === 0) {
            tally.skipped += 1;
            ctx.log(`${finding.key}: skipped, #${into.number} already lists every unit.`);
            continue;
          }
          ctx.github.postUnitComment(
            { objectType: "issue", id: into.number },
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
        const number = fileProposal(ctx, finding, evidence, regression?.number ?? null);
        tally.filed.push(number);
        ctx.log(
          `${finding.key}: filed #${number}` +
            (regression === null ? "." : ` as a regression of #${regression.number}.`),
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
