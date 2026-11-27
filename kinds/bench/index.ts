// The `bench` catalog kind (#989, decision #982): a person adds `phoebe:bench`
// to a PR, and the deployment benches the PR's `issues` prompt and settings
// against the default branch's, then comments the comparison on the PR.
//
// It ships in the engine and registers only when a tenant declares it, in a
// pipeline of its own with one slot (`pipelines.bench.kinds.bench`, with
// `path: "phoebe-agent/kinds/bench"`), so it may value-import engine helpers
// where a tenant module could not.
//
// Shape:
//   - one unit per open PR wearing the label, ref `pr:<n>`. A PR already in
//     flight is skipped;
//   - `run` reads the suite from the deployment directory. With none it
//     comments the `bench select` command, removes the label and runs nothing;
//   - it builds two contenders. `main` is the default branch's `issues`
//     prompt, provider, model and effort; `pr` is the PR head's. Prompts are
//     read as text through git; settings come from evaluating each commit's
//     governing config in a child process with no GitHub credential and no
//     provider key (sides.ts). A PR that changes none of them gets a comment
//     saying so, and runs nothing;
//   - otherwise one `runBench` call, the one `phoebe bench run` makes, replays
//     the newest `maxFixtures` fixtures with both contenders, recorded under
//     `bench/<runId>/`. Then a new comment and the label comes off. An
//     interrupted bench leaves the label on, so the bench runs again;
//   - the kind never starts an agent of its own, so its unit record carries no
//     agent runs, and trials go to `bench/<runId>/trials.jsonl`, never to a
//     pipeline's `units.jsonl`. Nothing that totals unit history counts them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { issuesPipelineConfig, parseSuite, runBench } from "../../src/bench-run.ts";
import type { PhoebeConfig } from "../../src/config-schema.ts";
import type { BenchContenderSpec, BenchSuite } from "../../src/contracts/bench.ts";
import { defaultGit, type GitRunner } from "../../src/git-model.ts";
import { pipelineOwnedKinds } from "../../src/pipeline.ts";
import {
  defineWorkKind,
  type WorkKindDefinition,
  type WorkKindRunCtx,
  type WorkKindRunResult,
} from "../../src/work-kinds/definition.ts";
import { GOVERNING_CONFIG } from "../observer/edit.ts";
import {
  MAIN_CONTENDER,
  PR_CONTENDER,
  renderBadSuiteComment,
  renderBenchComment,
  renderNoSuiteComment,
  renderNothingToMeasureComment,
} from "./comment.ts";
import { BENCH_LABEL } from "./label.ts";
import { resolveBenchOptions, type BenchKindOptions } from "./options.ts";
import {
  resolveSides,
  settingsDiffer,
  unmeasuredPaths,
  type RunSettingsChild,
  type Side,
} from "./sides.ts";

export { BENCH_LABEL };

export const BENCH_KIND_NAME = "bench";

/** The kind's placeholder prompt, an absolute path into the engine checkout. */
export const BENCH_PROMPT_FILE = join(import.meta.dirname, "prompt.md");

/** One labelled PR. `revision` is its head, so a push is a new unit to the engine. */
export type BenchUnit = {
  ref: string;
  github: { objectType: "pr"; id: number };
  revision: string;
  pr: { number: number; title: string; headSha: string; headRefName: string };
};

export type BenchGathered = { units: BenchUnit[] };

/** Test seams: the bench itself, git in the hub clone, the config read, the runtime root. */
export type BenchKindDeps = {
  runBench?: typeof runBench;
  git?: GitRunner;
  runSettingsChild?: RunSettingsChild;
  /** Where the suite and the deployment's prompts resolve: the process cwd. */
  runtimeRoot?: string;
};

/**
 * The pipeline that declares the kind. It must schedule nothing else and hold
 * one slot: a bench runs for hours, and sharing a pipeline would hold a slot
 * work wanted.
 */
export function benchPipelineOf(config: PhoebeConfig, at: string): string {
  for (const [name, pipeline] of Object.entries(config.pipelines)) {
    if (pipeline.kinds[BENCH_KIND_NAME] === undefined) continue;
    const others = pipelineOwnedKinds({ pipelines: config.pipelines, name, pipeline }).filter(
      (kind) => kind !== BENCH_KIND_NAME,
    );
    if (others.length > 0) {
      throw new Error(
        `${at}: bench needs a pipeline of its own, and \`pipelines.${name}\` also runs ` +
          `${others.join(", ")}. Declare it under a new pipeline, e.g. ` +
          `\`pipelines.bench.kinds.bench\`.`,
      );
    }
    if (pipeline.concurrency !== 1) {
      throw new Error(
        `${at}: bench runs one bench at a time, and \`pipelines.${name}.concurrency\` is ` +
          `${pipeline.concurrency}. Leave it unset or set it to 1.`,
      );
    }
    return name;
  }
  throw new Error(`${at}: no pipeline declares the bench kind.`);
}

/** The suite cut to its newest `max` fixtures, by PR number, newest first. */
export function trimSuite(suite: BenchSuite, max: number): BenchSuite {
  const fixtures = [...suite.fixtures].sort((a, b) => b.pr.number - a.pr.number).slice(0, max);
  return { ...suite, fixtures };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A contender as the bench config names it: a prompt file and, when known, the settings. */
function contenderOf(name: string, side: Side, promptFile: string): BenchContenderSpec {
  return {
    name,
    promptFile,
    ...(side.settings === null
      ? {}
      : {
          provider: side.settings.provider,
          model: side.settings.model,
          effort: side.settings.effort,
        }),
  };
}

export function createBenchKind(
  config: PhoebeConfig,
  options: BenchKindOptions,
  deps: BenchKindDeps = {},
): WorkKindDefinition<BenchGathered, BenchUnit> {
  benchPipelineOf(config, `kinds.${BENCH_KIND_NAME}`);
  const bench = deps.runBench ?? runBench;
  const git = deps.git ?? defaultGit;
  const runtimeRoot = deps.runtimeRoot ?? process.cwd();

  /** Comment, then take the label off. The label comes off only once the comment is up. */
  function finish(ctx: WorkKindRunCtx, unit: BenchUnit, body: string): void {
    ctx.github.postUnitComment(unit.github, body);
    ctx.github.removeUnitLabel(unit.github, BENCH_LABEL);
  }

  /** Make sure the hub clone holds the PR's head, fetching the PR ref when it does not. */
  function ensurePrHead(hub: string, unit: BenchUnit): void {
    const present = (): boolean => {
      try {
        git(["cat-file", "-e", `${unit.pr.headSha}^{commit}`], { cwd: hub, stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    };
    if (present()) return;
    git(
      [
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "origin",
        `+refs/pull/${unit.pr.number}/head:refs/phoebe-bench/pr-${unit.pr.number}`,
      ],
      { cwd: hub, stdio: "pipe" },
    );
    if (!present()) {
      throw new Error(
        `PR #${unit.pr.number}'s head ${unit.pr.headSha} is not in the hub clone after a ` +
          `fetch; it was probably pushed over. The next poll benches the new head.`,
      );
    }
  }

  /** The paths the PR changes, from the merge base. Empty when git cannot say. */
  function changedPaths(
    ctx: WorkKindRunCtx,
    hub: string,
    mainSha: string,
    headSha: string,
  ): string[] {
    try {
      return git(["diff", "--name-only", "--no-renames", "-z", `${mainSha}...${headSha}`], {
        cwd: hub,
        stdio: "pipe",
      })
        .split("\0")
        .filter((path) => path !== "");
    } catch (error) {
      ctx.log(
        `could not list the PR's changed paths, so no unmeasured paths are noted. ${message(error)}`,
      );
      return [];
    }
  }

  return defineWorkKind<BenchGathered, BenchUnit>({
    name: BENCH_KIND_NAME,
    oneShotEligible: true,
    promptFile: BENCH_PROMPT_FILE,
    workspace: "scratch",
    report: {
      noun: "PR(s) labelled for bench",
      describe: (unit) => `bench of PR #${unit.pr.number} at ${unit.pr.headSha.slice(0, 12)}`,
    },

    async fetch(ctx) {
      const units = ctx.github.listLabeledPrs(BENCH_LABEL).map((pr): BenchUnit => ({
        ref: `pr:${pr.number}`,
        github: { objectType: "pr", id: pr.number },
        revision: pr.headSha,
        pr: {
          number: pr.number,
          title: pr.title,
          headSha: pr.headSha,
          headRefName: pr.headRefName,
        },
      }));
      return { units };
    },

    select(gathered, ctx) {
      const total = gathered.units.length;
      let inFlight = 0;
      let quarantined = 0;
      for (const unit of gathered.units) {
        if (ctx.inFlight.has(unit.ref)) {
          inFlight += 1;
          continue;
        }
        if (ctx.quarantined.has(unit.ref)) {
          quarantined += 1;
          continue;
        }
        return { unit, skipped: [], total };
      }
      const skipped = [
        ...(inFlight > 0 ? [{ reason: "in flight", count: inFlight }] : []),
        ...(quarantined > 0 ? [{ reason: "quarantined in memory", count: quarantined }] : []),
      ];
      return { unit: null, skipped, total };
    },

    async run(unit, ctx): Promise<WorkKindRunResult> {
      const prName = `PR #${unit.pr.number}`;
      const suiteFile = resolve(runtimeRoot, options.suite);
      if (!existsSync(suiteFile)) {
        finish(ctx, unit, renderNoSuiteComment(options.suite));
        const summary = `${prName}: no suite at ${options.suite}, nothing ran`;
        ctx.log(summary);
        return { summary };
      }
      let suite: BenchSuite;
      try {
        suite = parseSuite(readFileSync(suiteFile, "utf8"), ctx.config.repoSlug);
      } catch (error) {
        finish(ctx, unit, renderBadSuiteComment(options.suite, message(error)));
        const summary = `${prName}: the suite at ${options.suite} did not read, nothing ran`;
        ctx.log(`${summary}. ${message(error)}`);
        return { summary };
      }

      const hub = ctx.config.paths.repoDir;
      ctx.origin.fetch();
      const mainSha = ctx.origin.branchHead(ctx.config.defaultBranch);
      ensurePrHead(hub, unit);
      const scratch = ctx.workspace.scratch;
      const sides = resolveSides({
        git,
        hub,
        runtimeRoot,
        configFile: GOVERNING_CONFIG,
        promptFile: issuesPipelineConfig(ctx.config).promptFiles.issue,
        mainSha,
        prSha: unit.pr.headSha,
        scratch,
        env: ctx.env,
        providerEnv: ctx.config.providerEnv,
        ...(deps.runSettingsChild !== undefined ? { runChild: deps.runSettingsChild } : {}),
        log: (line) => ctx.log(line),
      });
      const unmeasured = unmeasuredPaths(changedPaths(ctx, hub, mainSha, unit.pr.headSha));

      const promptChanged = sides.pr.prompt.text !== sides.main.prompt.text;
      if (!promptChanged && !settingsDiffer(sides.main.settings, sides.pr.settings)) {
        finish(ctx, unit, renderNothingToMeasureComment(unit.pr.headSha, unmeasured));
        const summary = `${prName}: nothing to measure, nothing ran`;
        ctx.log(summary);
        return { summary };
      }

      const promptDir = join(scratch, "prompts");
      mkdirSync(promptDir, { recursive: true });
      const mainPrompt = join(promptDir, `${MAIN_CONTENDER}.md`);
      const prPrompt = join(promptDir, `${PR_CONTENDER}.md`);
      writeFileSync(mainPrompt, sides.main.prompt.text);
      writeFileSync(prPrompt, sides.pr.prompt.text);

      const trimmed = trimSuite(suite, options.maxFixtures);
      ctx.log(
        `${prName} at ${unit.pr.headSha.slice(0, 12)} against ${ctx.config.defaultBranch} at ` +
          `${mainSha.slice(0, 12)}: ${trimmed.fixtures.length} of ${suite.fixtures.length} ` +
          `fixture(s), ${options.repeat} repeat(s)` +
          `${options.judge === null ? "" : `, judged by ${options.judge.provider} ${options.judge.model}`}.`,
      );
      const result = await bench({
        config: ctx.config,
        env: ctx.env,
        suite: trimmed,
        suitePath: options.suite,
        runtimeRoot,
        deploymentDir: runtimeRoot,
        benchConfig: {
          contenders: [
            contenderOf(MAIN_CONTENDER, sides.main, mainPrompt),
            contenderOf(PR_CONTENDER, sides.pr, prPrompt),
          ],
          repeat: options.repeat,
          ...(options.judge === null ? {} : { judge: options.judge }),
        },
        benchConfigPath: null,
        concurrency: 1,
        signal: ctx.signal,
        deps: { log: (line) => ctx.log(line) },
      });
      if (result.report.interrupted) {
        throw new Error(
          `the bench of ${prName} (run ${result.runId}) was interrupted after ` +
            `${result.report.recorded}/${result.report.planned} trial(s). The label stays on, ` +
            `so the bench runs again.`,
        );
      }

      finish(
        ctx,
        unit,
        renderBenchComment({
          pr: { number: unit.pr.number, headSha: unit.pr.headSha },
          runId: result.runId,
          report: result.report,
          trials: result.trials,
          sides,
          suiteSize: suite.fixtures.length,
          unmeasured,
        }),
      );
      const rate = (name: string): string => {
        const test = result.report.contenders.find((row) => row.contender.name === name)?.test;
        return test === null || test === undefined || test.rate === null
          ? "—"
          : `${Math.round(test.rate * 100)}%`;
      };
      const summary =
        `${prName}: run ${result.runId}, test pass ${MAIN_CONTENDER} ${rate(MAIN_CONTENDER)}, ` +
        `${PR_CONTENDER} ${rate(PR_CONTENDER)}, over ${trimmed.fixtures.length} fixture(s)`;
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
export default function benchKind(
  config: PhoebeConfig,
  options: unknown,
): WorkKindDefinition<BenchGathered, BenchUnit> {
  const at = `kinds.${BENCH_KIND_NAME}`;
  return createBenchKind(config, resolveBenchOptions(options, at, process.env));
}
