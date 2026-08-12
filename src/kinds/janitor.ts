// The shared skeleton behind every PR-fix work kind (conflicts/checks/reviews):
// the agent-run workflow (snapshot origin, prepare a worktree, install, run
// the agent, re-snapshot, count commits), the blocker-first clean-merge
// attempt, and the #25 no-commit-attempt marker/quarantine glue. Only
// `onResult` differs per kind (push vs. failure comment vs. watermark).

import { asBranchRef, type BranchRef, type PrNumber, type Sha } from "../branded.ts";
import { createPhoebeLog } from "../phoebe-log.ts";
import {
  readVerificationReport,
  removeVerificationReport,
  resolveVerification,
  runEngineVerification,
} from "../verification.ts";
import type { KindDeps, UnitResult } from "./kind.ts";

// The observed outcome of an automatic (no-agent) merge attempt:
//   "pushed"     — merged cleanly and pushed; the PR is caught up.
//   "conflicted" — real merge conflicts in the tree; an agent must resolve them.
//   "failed"     — could not even start/finish the merge (e.g. worktree setup);
//                  no conflicts were observed.
export type CleanMergeOutcome = "pushed" | "conflicted" | "failed";

export type AgentWorkflowResult = {
  worktreeDir: string;
  branch: BranchRef;
  originShaBefore: Sha;
  originShaAfter: Sha;
  localCommitCount: number;
};

export type JanitorHelpers = {
  tryCleanMerge(
    branch: BranchRef,
    mergedBlockerPrNumbers?: readonly PrNumber[],
    baseBranch?: BranchRef,
  ): CleanMergeOutcome;
  attemptBlockerFirstMerges(
    worktreeDir: string,
    mergedBlockerPrNumbers: readonly PrNumber[],
    baseBranch: BranchRef,
  ): void;
  runAgentWorkflow(opts: {
    pr: { prNumber: PrNumber; headRefName: BranchRef; labels?: readonly string[] };
    promptFile: string;
    promptArgs: Record<string, string>;
    beforeAgent?: (worktreeDir: string) => void;
    onResult: (result: AgentWorkflowResult) => void | Promise<void>;
  }): Promise<UnitResult>;
  recordFailedAttempt(opts: {
    kind: "conflicts" | "checks";
    prNumber: PrNumber;
    signature: string;
    failureComment: string;
  }): void;
};

/**
 * Where the agent is told to write its post-verify report (#17). Kept as a
 * sibling of the worktree, not inside it — so nothing the agent does inside
 * the worktree (a stray `git add -A`, a clean/reset) can sweep it into a
 * commit or delete it as untracked cruft.
 */
function verificationReportPath(worktreeDir: string): string {
  return `${worktreeDir}.verification.json`;
}

/** Retry budget for a PR whose mergeability GitHub is still computing (`UNKNOWN`). Shared by conflicts/checks fetch. */
export const MERGEABLE_RETRY_MS = 5_000;
export const MERGEABLE_RETRY_COUNT = 3;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Oldest PR (lowest number) among candidates, or `null` when the list is empty. Shared by all three PR-keyed kinds. */
export function pickOldestPr<T extends { prNumber: number }>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((oldest, pr) => (pr.prNumber < oldest.prNumber ? pr : oldest));
}

export function createJanitorHelpers(deps: KindDeps): JanitorHelpers {
  const { config, io } = deps;
  const defaultBranchRef = asBranchRef(config.defaultBranch);
  const { phoebeLog } = createPhoebeLog(config.repoSlug);

  function attemptBlockerFirstMerges(
    worktreeDir: string,
    mergedBlockerPrNumbers: readonly PrNumber[],
    baseBranch: BranchRef,
  ): void {
    try {
      for (const n of mergedBlockerPrNumbers) {
        io.git.gitInWorktree(worktreeDir, ["fetch", "origin", `pull/${n}/head`], {
          stdio: "inherit",
        });
        io.git.gitInWorktree(worktreeDir, ["merge", "FETCH_HEAD"], { stdio: "pipe" });
      }
      io.git.gitInWorktree(worktreeDir, ["fetch", "origin", baseBranch], { stdio: "inherit" });
      io.git.gitInWorktree(worktreeDir, ["merge", `origin/${baseBranch}`], { stdio: "pipe" });
    } catch {
      // Conflicts stay in the tree for the agent to resolve.
    }
  }

  function tryCleanMerge(
    branch: BranchRef,
    mergedBlockerPrNumbers: readonly PrNumber[] = [],
    baseBranch: BranchRef = defaultBranchRef,
  ): CleanMergeOutcome {
    let worktreeDir: string;
    try {
      worktreeDir = io.git.prepareWorktree({ branch });
    } catch {
      return "failed";
    }

    try {
      for (const blockerPrNumber of mergedBlockerPrNumbers) {
        io.git.gitInWorktree(worktreeDir, ["fetch", "origin", `pull/${blockerPrNumber}/head`], {
          stdio: "inherit",
        });
        io.git.gitInWorktree(worktreeDir, ["merge", "FETCH_HEAD"], { stdio: "pipe" });
      }
      io.git.gitInWorktree(worktreeDir, ["fetch", "origin", baseBranch], { stdio: "inherit" });
      io.git.gitInWorktree(worktreeDir, ["merge", `origin/${baseBranch}`], { stdio: "pipe" });
      io.git.pushBranch(worktreeDir, branch);
      io.git.removeWorktree(worktreeDir);
      return "pushed";
    } catch {
      try {
        const unmerged = io.git.gitInWorktree(worktreeDir, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
        if (unmerged.trim()) {
          io.git.gitInWorktree(worktreeDir, ["merge", "--abort"], { stdio: "ignore" });
          io.git.removeWorktree(worktreeDir);
          return "conflicted";
        }
      } catch {
        // Fall through to failed.
      }
      try {
        io.git.gitInWorktree(worktreeDir, ["merge", "--abort"], { stdio: "ignore" });
      } catch {
        // Best-effort.
      }
      io.git.removeWorktree(worktreeDir);
      return "failed";
    }
  }

  /**
   * The agent is prompted to write a verification report as part of its own
   * verify step (#17); this reads it back after the agent exits. Under
   * `config.verifyMode` (#166, default `"agent"`) that self-report may be
   * only a secondary signal, or ignored outright — see
   * `verification.ts#resolveVerification`.
   */
  async function runAgentWorkflow(opts: {
    pr: { prNumber: PrNumber; headRefName: BranchRef; labels?: readonly string[] };
    promptFile: string;
    promptArgs: Record<string, string>;
    beforeAgent?: (worktreeDir: string) => void;
    onResult: (result: AgentWorkflowResult) => void | Promise<void>;
  }): Promise<UnitResult> {
    const branch = opts.pr.headRefName;

    io.git.fetchOrigin();
    const originShaBefore = io.git.originBranchSha(branch);

    const worktreeDir = io.git.prepareWorktree({ branch });
    const reportPath = verificationReportPath(worktreeDir);
    removeVerificationReport(reportPath);
    try {
      io.shell.run(config.installCommand, worktreeDir);
      opts.beforeAgent?.(worktreeDir);

      const template = io.prompts.load(opts.promptFile);
      const prompt = io.prompts.render(
        template,
        { ...io.prompts.defaultArgs(), ...opts.promptArgs, VERIFICATION_RESULT_FILE: reportPath },
        worktreeDir,
      );
      const {
        exitCode: agentExitCode,
        usage,
        costUsd,
      } = await io.agent.run({ worktreeDir, prompt, labels: opts.pr.labels });
      const verification = resolveVerification({
        verifyMode: config.verifyMode,
        agentReported: readVerificationReport(reportPath),
        runEngine: () =>
          runEngineVerification([config.checkCommand, config.testCommand], worktreeDir, (c, d) =>
            io.shell.capture(c, d),
          ),
        onDisagreement: (disagreements) =>
          phoebeLog(
            `⚠️ verification disagreement for PR #${opts.pr.prNumber} (${branch}): ` +
              disagreements.join(" "),
          ),
      });

      io.git.fetchOrigin();
      const originShaAfter = io.git.originBranchSha(branch);
      const localCommitCount = io.git.commitCount(worktreeDir, `origin/${branch}..HEAD`);

      await opts.onResult({
        worktreeDir,
        branch,
        originShaBefore,
        originShaAfter,
        localCommitCount,
      });
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

  /**
   * Record one failed (no-commit) attempt on a PR-keyed unit (#25) via the
   * `no-commit` trigger — one tracking comment per unit, edited in place, and
   * escalated into `phoebe:quarantined` at threshold (`quarantine.ts`).
   */
  function recordFailedAttempt(opts: {
    kind: "conflicts" | "checks";
    prNumber: PrNumber;
    signature: string;
    failureComment: string;
  }): void {
    io.quarantine.record(
      { kind: opts.kind, target: { type: "pr", number: opts.prNumber } },
      "no-commit",
      {
        signature: opts.signature,
        reason: "produced no commit",
        belowThresholdNote: () => opts.failureComment,
      },
    );
  }

  return { tryCleanMerge, attemptBlockerFirstMerges, runAgentWorkflow, recordFailedAttempt };
}
