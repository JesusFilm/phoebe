// The bench judge (#942; spec #925, decisions #921): one agent run per trial
// with commits, comparing the trial's patch with the PR that actually merged,
// and answering on a fixed scale — `better`, `equivalent`, `worse` or `wrong` —
// with a short rationale.
//
// Off unless the bench config names `judge: { provider, model }`.
//
// The judge is read-only in effect. It works in a scratch directory of its own
// holding three files — the issue as the suite pinned it, the merged PR's diff
// from the hub clone, and the trial's patch — with no repository, no remote,
// no GitHub credential and a HOME of its own. Whatever it writes there is
// deleted with the directory; bench reads only its answer.
//
// It runs after the trial's clock has stopped, and its usage lands on the
// trial's `judgement`, never in `agentRuns`, so the judge's time, tokens and
// cost never count as the contender's.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_NAMES, type PhoebeConfig, type ProviderName } from "./config-schema.ts";
import {
  BENCH_VERDICTS,
  type BenchFixture,
  type BenchJudge,
  type BenchJudgement,
  type BenchVerdict,
} from "./contracts/bench.ts";
import type { GitRunner } from "./git-model.ts";
import { PROVIDERS } from "./providers/providers.ts";
import { runAgent, type SpawnAgent } from "./providers/run-agent.ts";
import { costBasisFor } from "./providers/usage.ts";
import { RunTimeoutError, runWithDeadline } from "./run-timeout.ts";
import { agentRunRecord, capDetail, promptShaOf, type AgentRunTrack } from "./unit-record.ts";

/** The files the judge reads, in its working directory. */
export const JUDGE_ISSUE_FILE = "issue.md";
export const JUDGE_MERGED_FILE = "merged.diff";
export const JUDGE_TRIAL_FILE = "trial.patch";

const JUDGE_FIELDS = new Set(["provider", "model"]);

/** Read the bench config's `judge`, refusing anything it would have to guess at. */
export function parseBenchJudge(raw: unknown, fail: (what: string) => never): BenchJudge {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("`judge` must be an object with `provider` and `model`.");
  }
  const judge = raw as Record<string, unknown>;
  for (const key of Object.keys(judge)) {
    if (!JUDGE_FIELDS.has(key)) {
      fail(`judge has unknown field \`${key}\` (expected ${[...JUDGE_FIELDS].join(", ")}).`);
    }
  }
  const text = (key: string): string => {
    const value = judge[key];
    if (typeof value !== "string" || value.trim() === "") {
      return fail(`judge.${key} must be a non-empty string.`);
    }
    return value.trim();
  };
  const provider = text("provider");
  if (!(PROVIDER_NAMES as readonly string[]).includes(provider)) {
    fail(`judge.provider \`${provider}\` is not one of ${PROVIDER_NAMES.join(", ")}.`);
  }
  return { provider, model: text("model") };
}

/** The issue as the suite pinned it, as Markdown for the judge to read. */
export function issueDocument(fixture: BenchFixture): string {
  const { issue } = fixture;
  const comments = issue.comments.map(
    (comment) =>
      `### ${comment.author ?? "(deleted account)"} at ${comment.createdAt}\n\n${comment.body}\n`,
  );
  return [
    `# #${issue.number}: ${issue.title}\n`,
    `${issue.body}\n`,
    ...(comments.length > 0 ? ["## Comments\n", ...comments] : []),
  ].join("\n");
}

/**
 * What the judge is asked, before `{{ISSUE_NUMBER}}` and `{{PR_NUMBER}}` are
 * filled. The scale and the answer's shape are fixed; the wording is ours. Its
 * hash is the judge run's `promptSha`, so a rewording shows in the records.
 */
export const JUDGE_PROMPT_TEMPLATE = `You are judging an offline benchmark of coding agents. Do not change any file.

Issue #{{ISSUE_NUMBER}} was solved by a pull request that merged. A
different agent attempted the same issue from the same starting commit. Compare
its attempt with the merged pull request.

Read these files in the current directory:

- \`${JUDGE_ISSUE_FILE}\`: the issue, with the comments posted before the pull request opened.
- \`${JUDGE_MERGED_FILE}\`: the diff of the pull request that merged (PR #{{PR_NUMBER}}).
- \`${JUDGE_TRIAL_FILE}\`: the attempt, as \`git format-patch\` output from the same starting commit.

Pick exactly one verdict for the attempt:

- \`better\`: it does what the issue asks at least as fully as the merged pull request, and is clearly better in correctness, scope or clarity.
- \`equivalent\`: it does what the issue asks about as well as the merged pull request, even if the code differs.
- \`worse\`: it addresses the issue but falls short of the merged pull request: incomplete, needlessly broad, harder to maintain or less well tested.
- \`wrong\`: it does not solve the issue, solves a different problem, or would break something.

Judge what the issue asks for, not whether the attempt matches the merged diff line for line.

End your reply with one line of JSON and nothing after it:

{"verdict": "<better|equivalent|worse|wrong>", "rationale": "<one to three sentences>"}
`;

export const JUDGE_PROMPT_SHA = promptShaOf(JUDGE_PROMPT_TEMPLATE);

/** The judge's prompt for one fixture. */
export function judgePrompt(fixture: BenchFixture): string {
  return JUDGE_PROMPT_TEMPLATE.replaceAll(
    "{{ISSUE_NUMBER}}",
    String(fixture.issue.number),
  ).replaceAll("{{PR_NUMBER}}", String(fixture.pr.number));
}

function isVerdict(value: unknown): value is BenchVerdict {
  return typeof value === "string" && (BENCH_VERDICTS as readonly string[]).includes(value);
}

/**
 * Read the verdict out of the judge's reply: the last JSON object in it that
 * names a verdict. `null` when there is none, or when it names one off the scale.
 */
export function parseVerdict(
  text: string,
): { verdict: BenchVerdict; rationale: string | null } | null {
  const candidates = text.match(/\{[^{}]*\}/g) ?? [];
  for (const candidate of candidates.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || !("verdict" in parsed)) continue;
    const { verdict, rationale } = parsed as { verdict: unknown; rationale?: unknown };
    const normal = typeof verdict === "string" ? verdict.trim().toLowerCase() : verdict;
    if (!isVerdict(normal)) return null;
    const why = typeof rationale === "string" && rationale.trim() !== "" ? rationale.trim() : null;
    return { verdict: normal, rationale: capDetail(why) };
  }
  return null;
}

/**
 * The merged PR's changes as the hub clone holds them: `baseSha` to the PR's
 * head, the same starting point the trial's patch is measured from. Fetches
 * the PR head first when the hub does not have it.
 */
export function mergedDiff(opts: { git: GitRunner; hub: string; fixture: BenchFixture }): string {
  const { git, hub, fixture } = opts;
  const has = (): boolean => {
    try {
      git(["cat-file", "-e", `${fixture.pr.headSha}^{commit}`], { cwd: hub, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!has()) {
    git(
      [
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "origin",
        `refs/pull/${fixture.pr.number}/head`,
      ],
      {
        cwd: hub,
        stdio: "pipe",
      },
    );
  }
  return git(["diff", fixture.baseSha, fixture.pr.headSha], { cwd: hub, stdio: "pipe" });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

/**
 * Judge one trial. Never throws: a judge that cannot answer is a judgement
 * with no verdict and an `error`, and the trial is recorded either way.
 */
export async function judgeTrial(opts: {
  judge: BenchJudge;
  config: PhoebeConfig;
  /**
   * The judge's environment for a HOME and a PATH directory of its own: the
   * trial agent's, so it holds no GitHub credential either.
   */
  agentEnv: (dirs: { home: string; bin: string }) => Record<string, string>;
  fixture: BenchFixture;
  /** The trial's patch, as `git format-patch` wrote it. */
  patch: string;
  /** Scratch directory for this judgement; removed when it ends. */
  dir: string;
  runTimeoutMs: number;
  signal: AbortSignal;
  git: GitRunner;
  spawnAgent: SpawnAgent;
  now: () => Date;
  log: (line: string) => void;
  /** The trial's bracket, so the judge's lines read as that trial's. */
  unit: string;
}): Promise<BenchJudgement> {
  const { judge, config, fixture, now } = opts;
  const provider = PROVIDERS[judge.provider as ProviderName];
  const base = { provider: judge.provider, model: judge.model };
  let track: AgentRunTrack | null = null;
  const settle = (
    answer: { verdict: BenchVerdict; rationale: string | null } | null,
    error: string | null,
  ): BenchJudgement => ({
    ...base,
    verdict: answer?.verdict ?? null,
    rationale: answer?.rationale ?? null,
    error: answer === null ? capDetail(error ?? "the judge gave no verdict") : null,
    run: track === null ? null : agentRunRecord(track, now()),
  });

  const inputs = join(opts.dir, "inputs");
  const dirs = { home: join(opts.dir, "home"), bin: join(opts.dir, "bin") };
  try {
    rmSync(opts.dir, { recursive: true, force: true });
    for (const dir of [inputs, dirs.home, dirs.bin]) mkdirSync(dir, { recursive: true });
    let merged: string;
    try {
      merged = mergedDiff({ git: opts.git, hub: config.paths.repoDir, fixture });
    } catch (error) {
      return settle(null, `could not read the merged diff: ${errorText(error)}`);
    }
    writeFileSync(join(inputs, JUDGE_ISSUE_FILE), issueDocument(fixture));
    writeFileSync(join(inputs, JUDGE_MERGED_FILE), merged);
    writeFileSync(join(inputs, JUDGE_TRIAL_FILE), opts.patch);
    if (opts.signal.aborted) return settle(null, "interrupted before a verdict");

    const env = opts.agentEnv(dirs);
    const meter = provider.meterUsage();
    const run: AgentRunTrack = {
      startedAt: now(),
      promptSha: JUDGE_PROMPT_SHA,
      costBasis: costBasisFor(provider.name, env),
      meter,
      endedAt: null,
      exitCode: null,
    };
    track = run;
    let reply = "";
    try {
      await runWithDeadline({
        ms: opts.runTimeoutMs,
        work: async (deadline) => {
          try {
            const result = await runAgent({
              provider,
              model: judge.model,
              prompt: judgePrompt(fixture),
              cwd: inputs,
              env,
              signal: AbortSignal.any([deadline, opts.signal]),
              tenant: config.repoSlug,
              pipeline: "bench",
              unit: `${opts.unit} judge`,
              meter,
              log: opts.log,
              spawn: opts.spawnAgent,
            });
            run.exitCode = result.exitCode;
            reply = result.resultText;
          } finally {
            run.endedAt = now();
          }
        },
      });
    } catch (error) {
      if (error instanceof RunTimeoutError)
        return settle(null, `the judge ran past its ${error.elapsedMs}ms budget`);
      throw error;
    }
    if (opts.signal.aborted) return settle(null, "interrupted before a verdict");
    const answer = parseVerdict(reply);
    if (answer !== null) return settle(answer, null);
    return settle(
      null,
      run.exitCode !== 0
        ? `the judge exited ${run.exitCode ?? "without a code"} with no verdict`
        : "the judge's reply held no verdict on the scale",
    );
  } catch (error) {
    return settle(null, `the judge failed: ${errorText(error)}`);
  } finally {
    rmSync(opts.dir, { recursive: true, force: true });
  }
}
