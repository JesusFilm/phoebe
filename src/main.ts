// Phoebe orchestration entry point — an away-from-keyboard (AFK) worker loop.
//
// Picks ready-labelled issues off the configured repo one at a time and
// works each in a git worktree off the container's private clone, on its own
// branch, opening a PR to the default branch. The container is both
// orchestrator and execution environment; agent CLIs run as direct children
// with an allowlisted env. See docs/architecture.md for the full design.
//
//   src/main.ts                        # attached container run (persistent loop)
//   src/main.ts --run-once             # one unit of the first one-shot-eligible kind
//   src/main.ts --dry-run --run-once   # host-side selection preview
//
// Everything repo-specific comes from ../phoebe.config.ts; work-unit execution
// is refused outside the container marker (src/execution-gate.ts).

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../phoebe.config.ts";
import { PROVIDER_NAMES, type ProviderName } from "./config-schema.ts";
import { buildAgentEnv } from "./agent-env.ts";
import {
  EXECUTION_REFUSED_MESSAGE,
  executionDecision,
  isInsideContainer,
} from "./execution-gate.ts";
import {
  addWorktreeForExistingBranch,
  addWorktreeForNewBranch,
  commitCount,
  fetchOrigin as gitFetchOrigin,
  originBranchSha as gitOriginBranchSha,
  pushBranch,
  removeWorktree,
  worktreeDirForBranch,
} from "./git-model.ts";
import { PROVIDERS } from "./providers/providers.ts";
import { runAgent } from "./providers/run-agent.ts";
import type { Provider } from "./providers/types.ts";
import { renderPrompt } from "./prompt.ts";
import { SELF_UPDATE_EXIT_CODE, shouldExitForSelfUpdate } from "./supervisor-decision.ts";
import {
  buildInitialPrBody,
  buildReviewsHandledComment,
  checksFixFailureComment,
  conflictFixFailureComment,
  followUpPrComment,
  formatFailingChecksForPrompt,
  isReviewSummaryComment,
  issueBranch,
  isPrInScope,
  isPrMergeConflicting,
  listFailingChecks,
  newestReviewThreadCommentCreatedAt,
  parseBlockedBy,
  parseChecksFailWatermarkFromComments,
  parseConflictFailWatermarkFromComments,
  parseReviewsHandledWatermarkFromComments,
  parseIssueNumberFromBranch,
  getMergedBlockerPrNumbers,
  oneShotWorkKinds,
  selectChecksCandidates,
  selectChecksUnit,
  selectReviewsCandidates,
  selectReviewsUnit,
  stackedCatchUpRetractionComment,
  RUN_ONCE_NOTHING_MESSAGE,
  selectConflictFixCandidates,
  selectFirstWorkUnit,
  selectConflictUnit,
  selectIssue,
  shouldPostChecksFixFailure,
  shouldPostConflictFixFailure,
  statusCheckRollupState,
  validateWorkOrder,
  workflowRunsToCheckItems,
  type BlockerPrState,
  type ChecksCandidate,
  type ChecksFailWatermark,
  type ConflictingPrCandidate,
  type ConflictFailWatermark,
  type Issue,
  type IssueWorkUnit,
  type ReviewThread,
  type ReviewsCandidate,
  type ReviewsHandledWatermark,
  type StatusCheckItem,
  type WorkflowRunItem,
  type WorkKindName,
  type WorkUnit,
} from "./orchestrator.ts";

const DEFAULT_POLL_INTERVAL_MS = 300_000;
// Never let a gh/git child process block the persistent loop forever (rate-limit
// backoff, credential prompt, network partition). Configured toolchain commands
// (install/test) get a longer leash.
const CHILD_PROCESS_TIMEOUT_MS = 120_000;
const SHELL_COMMAND_TIMEOUT_MS = 600_000;
const MERGEABLE_RETRY_MS = 5_000;
const MERGEABLE_RETRY_COUNT = 3;

const PR_BASE = config.defaultBranch;
// The branch the supervisor keeps the clone on — normally the default branch,
// overridable (matching container/supervisor.sh) so a not-yet-merged Phoebe
// branch can run itself end-to-end. PRs and worktree bases still use
// config.defaultBranch.
const trackedBranch = process.env["PHOEBE_DEFAULT_BRANCH"] ?? config.defaultBranch;
const moduleDir = dirname(fileURLToPath(import.meta.url));

// Resolve a package-root-relative resource by walking up from this module's
// directory: the build emits dist/src/main.js while prompts/ and templates/
// ship at the package root, so the depth back to the root differs between the
// source layout (src/) and the built layout (dist/src/).
function resolvePackageFile(relativePath: string): string {
  let dir = moduleDir;
  while (true) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find ${relativePath} in any directory above ${moduleDir}`);
    }
    dir = parent;
  }
}

const inContainer = isInsideContainer();
// On the host only selection/--dry-run runs, against the local checkout; in
// the container all git state lives in the private clone on the named volume.
const repoDir = inContainer ? config.paths.repoDir : process.cwd();
const worktreesDir = config.paths.worktreesDir;

// ---------------------------------------------------------------------------
// Provider selection (multi-provider ready)
// ---------------------------------------------------------------------------

function selectProvider(): { provider: Provider; model: string } {
  const name = process.env["PHOEBE_AGENT"] ?? config.defaultProvider;
  if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown PHOEBE_AGENT "${name}". Use one of: ${PROVIDER_NAMES.join(", ")}.`);
  }
  const provider = PROVIDERS[name as ProviderName];
  const model = process.env["PHOEBE_MODEL"] ?? config.defaultModels[name as ProviderName];
  return { provider, model };
}

const workOrder = validateWorkOrder(config.workOrder);

// ---------------------------------------------------------------------------
// gh helpers — always pinned to the configured repo
// ---------------------------------------------------------------------------

function ghJson<T>(args: string[]): T {
  return JSON.parse(
    execFileSync("gh", [...args, "-R", config.repoSlug], {
      encoding: "utf8",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    }),
  ) as T;
}

function ghApiJson<T>(endpoint: string): T {
  return JSON.parse(
    execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    }),
  ) as T;
}

function gh(args: string[], opts?: { input?: string }): void {
  execFileSync("gh", [...args, "-R", config.repoSlug], {
    stdio: opts?.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  });
}

function listReadyIssues(): Issue[] {
  type GhIssue = Omit<Issue, "labels"> & { labels: Array<{ name: string }> };
  return ghJson<GhIssue[]>([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    config.readyLabel,
    "--limit",
    "100",
    "--search",
    "sort:created-asc",
    "--json",
    "number,title,body,labels,createdAt",
  ]).map((row) => ({
    number: row.number,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
    labels: row.labels.map((l) => l.name),
  }));
}

function blockerPrState(blockerIssueNumber: number): BlockerPrState {
  const branch = issueBranch(blockerIssueNumber);
  const open = ghJson<Array<{ number: number }>>([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  const merged = ghJson<Array<{ number: number }>>([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "merged",
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  return {
    hasOpenPr: open.length > 0,
    openPrNumber: open[0]?.number,
    hasMergedPr: merged.length > 0,
    mergedPrNumber: merged[0]?.number,
  };
}

function buildBlockerStates(issues: readonly Issue[]): Map<number, BlockerPrState> {
  const blockerNumbers = new Set<number>();
  for (const issue of issues) {
    for (const n of parseBlockedBy(issue.body)) {
      blockerNumbers.add(n);
    }
  }
  const states = new Map<number, BlockerPrState>();
  for (const n of blockerNumbers) {
    try {
      states.set(n, blockerPrState(n));
    } catch (error) {
      // Absent entries are treated as unmerged blockers — safe to retry next cycle.
      console.warn(
        `[phoebe] Skipping blocker state for #${n} this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return states;
}

function buildBlockerStatesFromBodies(
  bodies: ReadonlyArray<{ number: number; body: string }>,
): Map<number, BlockerPrState> {
  return buildBlockerStates(
    bodies.map(({ number, body }) => ({
      number,
      title: "",
      body,
      labels: [],
      createdAt: "",
    })),
  );
}

function postPrComment(prNumber: number, body: string): void {
  gh(["pr", "comment", String(prNumber), "--body", body]);
}

type OpenPhoebePr = { number: number; headRefName: string; authorLogin: string };

function listOpenPhoebePrs(): OpenPhoebePr[] {
  type GhOpenPr = {
    number: number;
    headRefName: string;
    isDraft: boolean;
    isCrossRepository: boolean;
    labels: Array<{ name: string }>;
    author: { login: string };
  };
  return ghJson<GhOpenPr[]>([
    "pr",
    "list",
    "--base",
    PR_BASE,
    "--state",
    "open",
    "--json",
    "number,headRefName,isDraft,isCrossRepository,labels,author",
    "--limit",
    "100",
  ])
    .filter((pr) =>
      isPrInScope({
        headRefName: pr.headRefName,
        isDraft: pr.isDraft,
        isCrossRepository: pr.isCrossRepository,
        labels: pr.labels.map((label) => label.name),
      }),
    )
    .map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
      authorLogin: pr.author.login,
    }));
}

type PrMergeInfo = {
  number: number;
  headRefName: string;
  headRefOid: string;
  mergeable: string;
  mergeStateStatus: string;
};

function viewPrMergeInfo(prNumber: number): PrMergeInfo {
  return ghJson<PrMergeInfo>([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,headRefName,headRefOid,mergeable,mergeStateStatus",
  ]);
}

function prConflictFailWatermark(prNumber: number): ConflictFailWatermark | null {
  const { comments } = ghJson<{ comments: Array<{ body: string }> }>([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "comments",
  ]);
  return parseConflictFailWatermarkFromComments(comments.map((comment) => comment.body));
}

function prChecksFailWatermark(prNumber: number): ChecksFailWatermark | null {
  const { comments } = ghJson<{ comments: Array<{ body: string }> }>([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "comments",
  ]);
  return parseChecksFailWatermarkFromComments(comments.map((comment) => comment.body));
}

function prReviewsHandledWatermark(prNumber: number): ReviewsHandledWatermark | null {
  const { comments } = ghJson<{ comments: Array<{ body: string }> }>([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "comments",
  ]);
  return parseReviewsHandledWatermarkFromComments(comments.map((comment) => comment.body));
}

function phoebeGhLogin(): string {
  return ghApiJson<{ login: string }>("user").login;
}

function issueBody(issueNumber: number): string {
  return ghJson<{ body: string }>(["issue", "view", String(issueNumber), "--json", "body"]).body;
}

// ---------------------------------------------------------------------------
// git helpers bound to the clone
// ---------------------------------------------------------------------------

function fetchOrigin(): void {
  gitFetchOrigin(repoDir);
}

function originBranchSha(branch: string): string {
  return gitOriginBranchSha(repoDir, branch);
}

function currentConflictFailureWatermark(branch: string): ConflictFailWatermark {
  fetchOrigin();
  return {
    prHead: originBranchSha(branch),
    mainHead: originBranchSha(config.defaultBranch),
  };
}

function currentChecksFailureWatermark(branch: string): ChecksFailWatermark {
  fetchOrigin();
  return { prHead: originBranchSha(branch) };
}

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

/** Run a configured toolchain command (a shell string) inside a worktree. */
function runShellCommand(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: "inherit", timeout: SHELL_COMMAND_TIMEOUT_MS });
}

/** Shell executor for prompt !`...` expansion — captures stdout. */
function promptShell(cwd: string): (command: string) => string {
  return (command) =>
    execSync(command, { cwd, encoding: "utf8", timeout: SHELL_COMMAND_TIMEOUT_MS });
}

function loadPromptTemplate(relativePath: string): string {
  return readFileSync(resolvePackageFile(relativePath), "utf8");
}

/**
 * After each cycle's fetch, exit deliberately when Phoebe's own code changed
 * on the default branch — the container supervisor reinstalls and re-execs.
 *
 * When the supervisor has pinned us to the last-good SHA because a freshly
 * pulled commit was crash-looping, it passes that quarantined SHA in
 * `PHOEBE_QUARANTINED_SHA`; we stay on the good code (no self-update) while
 * `origin/<branch>` still points at it, and resume self-updating only once the
 * branch advances past it (a fix landed).
 */
function exitForSelfUpdateIfNeeded(): void {
  if (!inContainer) return;
  fetchOrigin();
  const originSha = originBranchSha(trackedBranch);
  const changed = gitInWorktree(repoDir, ["diff", "--name-only", `HEAD..origin/${trackedBranch}`])
    .split("\n")
    .filter(Boolean);
  if (
    shouldExitForSelfUpdate({
      changedFiles: changed,
      selfUpdatePaths: config.selfUpdatePaths,
      originSha,
      quarantinedSha: process.env["PHOEBE_QUARANTINED_SHA"] || null,
    })
  ) {
    console.log(
      `[phoebe] Own code changed on origin/${trackedBranch} — exiting for supervisor re-exec.`,
    );
    process.exit(SELF_UPDATE_EXIT_CODE);
  }
}

// ---------------------------------------------------------------------------
// Work-unit execution
// ---------------------------------------------------------------------------

function prepareWorktree(opts: { branch: string; baseRef?: string }): string {
  const worktreeDir = worktreeDirForBranch(worktreesDir, opts.branch);
  removeWorktree(repoDir, worktreeDir);
  if (opts.baseRef) {
    addWorktreeForNewBranch({
      repoDir,
      worktreeDir,
      branch: opts.branch,
      baseRef: opts.baseRef,
    });
  } else {
    addWorktreeForExistingBranch({ repoDir, worktreeDir, branch: opts.branch });
  }
  return worktreeDir;
}

async function runAgentInWorktree(opts: {
  worktreeDir: string;
  promptFile: string;
  promptArgs: Record<string, string>;
}): Promise<void> {
  const { provider, model } = selectProvider();
  const prompt = renderPrompt(
    loadPromptTemplate(opts.promptFile),
    opts.promptArgs,
    promptShell(opts.worktreeDir),
  );
  const env = buildAgentEnv({
    parentEnv: process.env,
    provider: provider.name,
    providerEnv: config.providerEnv,
  });
  const { exitCode } = await runAgent({
    provider,
    model,
    prompt,
    cwd: opts.worktreeDir,
    env,
  });
  if (exitCode !== 0) {
    console.log(`[phoebe] Agent exited with code ${exitCode}.`);
  }
}

function tryCleanMerge(
  branch: string,
  mergedBlockerPrNumbers: readonly number[] = [],
): "pushed" | "needs_agent" | "failed" {
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
    gitInWorktree(worktreeDir, ["fetch", "origin", config.defaultBranch], { stdio: "inherit" });
    gitInWorktree(worktreeDir, ["merge", `origin/${config.defaultBranch}`], { stdio: "pipe" });
    pushBranch(worktreeDir, branch);
    removeWorktree(repoDir, worktreeDir);
    return "pushed";
  } catch {
    try {
      const unmerged = gitInWorktree(worktreeDir, ["diff", "--name-only", "--diff-filter=U"]);
      if (unmerged.trim()) {
        gitInWorktree(worktreeDir, ["merge", "--abort"], { stdio: "ignore" });
        removeWorktree(repoDir, worktreeDir);
        return "needs_agent";
      }
    } catch {
      // Fall through to failed.
    }
    try {
      gitInWorktree(worktreeDir, ["merge", "--abort"], { stdio: "ignore" });
    } catch {
      // Best-effort.
    }
    removeWorktree(repoDir, worktreeDir);
    return "failed";
  }
}

/** Blocker-first merge attempt, mirroring `cmd && … || true` hook semantics. */
function attemptBlockerFirstMerges(
  worktreeDir: string,
  mergedBlockerPrNumbers: readonly number[],
): void {
  try {
    for (const n of mergedBlockerPrNumbers) {
      gitInWorktree(worktreeDir, ["fetch", "origin", `pull/${n}/head`], { stdio: "inherit" });
      gitInWorktree(worktreeDir, ["merge", "FETCH_HEAD"], { stdio: "pipe" });
    }
    gitInWorktree(worktreeDir, ["fetch", "origin", config.defaultBranch], { stdio: "inherit" });
    gitInWorktree(worktreeDir, ["merge", `origin/${config.defaultBranch}`], { stdio: "pipe" });
  } catch {
    // Conflicts stay in the tree for the agent to resolve.
  }
}

async function runConflictResolutionAgent(
  pr: ConflictingPrCandidate,
  mergedBlockerPrNumbers: readonly number[],
): Promise<boolean> {
  const branch = pr.headRefName;

  fetchOrigin();
  const originShaBefore = originBranchSha(branch);

  const worktreeDir = prepareWorktree({ branch });
  try {
    runShellCommand(config.installCommand, worktreeDir);
    attemptBlockerFirstMerges(worktreeDir, mergedBlockerPrNumbers);

    await runAgentInWorktree({
      worktreeDir,
      promptFile: config.promptFiles.conflict,
      promptArgs: {
        PR_NUMBER: String(pr.prNumber),
        PR_BRANCH: branch,
        BLOCKER_PR_NUMBERS: mergedBlockerPrNumbers.join(","),
      },
    });

    fetchOrigin();
    const originShaAfter = originBranchSha(branch);
    const prInfo = viewPrMergeInfo(pr.prNumber);
    const localCommitCount = commitCount(worktreeDir, `origin/${branch}..HEAD`);

    let pushed = false;
    if (
      shouldPostConflictFixFailure({
        hostCommitCount: localCommitCount,
        originShaBefore,
        originShaAfter,
        mergeable: prInfo.mergeable,
        mergeStateStatus: prInfo.mergeStateStatus,
      })
    ) {
      console.log(
        `[phoebe] Conflict fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
      );
      postPrComment(
        pr.prNumber,
        conflictFixFailureComment(pr.prNumber, currentConflictFailureWatermark(pr.headRefName)),
      );
    } else {
      if (localCommitCount > 0) {
        pushBranch(worktreeDir, branch);
        pushed = true;
        console.log(`[phoebe] Conflict resolved for PR #${pr.prNumber} — pushed.`);
      } else {
        pushed = true;
        console.log(`[phoebe] Conflict resolved for PR #${pr.prNumber} — already pushed by agent.`);
      }
    }

    return pushed;
  } finally {
    removeWorktree(repoDir, worktreeDir);
  }
}

async function fixOnePrConflict(
  pr: ConflictingPrCandidate,
  issueBodies: Map<number, string>,
  blockerStates: Map<number, BlockerPrState>,
): Promise<void> {
  console.log(`[phoebe] Conflict fix: PR #${pr.prNumber} (${pr.headRefName}).`);
  fetchOrigin();

  const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
  const body = issueNumber !== null ? (issueBodies.get(issueNumber) ?? "") : "";
  const mergedBlockerPrNumbers = getMergedBlockerPrNumbers(body, blockerStates);
  if (mergedBlockerPrNumbers.length > 0) {
    console.log(
      `[phoebe] Stacked catch-up: merging blocker PR(s) ${mergedBlockerPrNumbers.map((n) => `#${n}`).join(", ")} before ${config.defaultBranch}.`,
    );
  }

  const cleanResult = tryCleanMerge(pr.headRefName, mergedBlockerPrNumbers);
  if (cleanResult === "pushed") {
    console.log(`[phoebe] Clean merge for PR #${pr.prNumber} — pushed.`);
    if (mergedBlockerPrNumbers.length > 0) {
      postPrComment(pr.prNumber, stackedCatchUpRetractionComment(mergedBlockerPrNumbers));
    }
    return;
  }
  if (cleanResult === "failed") {
    console.log(`[phoebe] Could not start merge for PR #${pr.prNumber} — skipping.`);
    postPrComment(
      pr.prNumber,
      conflictFixFailureComment(pr.prNumber, currentConflictFailureWatermark(pr.headRefName)),
    );
    return;
  }

  await runConflictResolutionAgent(pr, mergedBlockerPrNumbers);
}

async function runChecksResolutionAgent(pr: ChecksCandidate): Promise<boolean> {
  const branch = pr.headRefName;

  fetchOrigin();
  const originShaBefore = originBranchSha(branch);

  const worktreeDir = prepareWorktree({ branch });
  try {
    runShellCommand(config.installCommand, worktreeDir);

    await runAgentInWorktree({
      worktreeDir,
      promptFile: config.promptFiles.checks,
      promptArgs: {
        PR_NUMBER: String(pr.prNumber),
        PR_BRANCH: branch,
        FAILING_CHECKS: formatFailingChecksForPrompt(pr.failingChecks),
      },
    });

    fetchOrigin();
    const originShaAfter = originBranchSha(branch);
    const localCommitCount = commitCount(worktreeDir, `origin/${branch}..HEAD`);

    let pushed = false;
    if (
      shouldPostChecksFixFailure({
        hostCommitCount: localCommitCount,
        originShaBefore,
        originShaAfter,
      })
    ) {
      console.log(
        `[phoebe] Checks fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
      );
      postPrComment(
        pr.prNumber,
        checksFixFailureComment(pr.prNumber, currentChecksFailureWatermark(pr.headRefName)),
      );
    } else {
      if (localCommitCount > 0) {
        pushBranch(worktreeDir, branch);
        pushed = true;
        console.log(`[phoebe] Checks fixed for PR #${pr.prNumber} — pushed.`);
      } else {
        pushed = true;
        console.log(`[phoebe] Checks fixed for PR #${pr.prNumber} — already pushed by agent.`);
      }
    }

    return pushed;
  } finally {
    removeWorktree(repoDir, worktreeDir);
  }
}

async function fixOnePrChecks(
  pr: ChecksCandidate,
  issueBodies: Map<number, string>,
  blockerStates: Map<number, BlockerPrState>,
): Promise<void> {
  console.log(
    `[phoebe] Checks fix: PR #${pr.prNumber} (${pr.headRefName}) — ` +
      `${pr.failingChecks.map((c) => c.name).join(", ")}.`,
  );
  fetchOrigin();

  if (pr.mergeStateStatus === "BEHIND") {
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    const body = issueNumber !== null ? (issueBodies.get(issueNumber) ?? "") : "";
    const mergedBlockerPrNumbers = getMergedBlockerPrNumbers(body, blockerStates);
    if (mergedBlockerPrNumbers.length > 0) {
      console.log(
        `[phoebe] Behind main — catch-up merging blocker PR(s) ${mergedBlockerPrNumbers.map((n) => `#${n}`).join(", ")} before ${config.defaultBranch}.`,
      );
    } else {
      console.log(`[phoebe] Behind main — catch-up merge for PR #${pr.prNumber}.`);
    }

    const cleanResult = tryCleanMerge(pr.headRefName, mergedBlockerPrNumbers);
    if (cleanResult === "pushed") {
      console.log(
        `[phoebe] Catch-up merge for PR #${pr.prNumber} — pushed; waiting for CI on next cycle.`,
      );
      if (mergedBlockerPrNumbers.length > 0) {
        postPrComment(pr.prNumber, stackedCatchUpRetractionComment(mergedBlockerPrNumbers));
      }
      return;
    }
    if (cleanResult === "needs_agent" || cleanResult === "failed") {
      console.log(
        `[phoebe] Catch-up merge conflicted for PR #${pr.prNumber} — deferring to conflicts mode.`,
      );
      return;
    }
  }

  await runChecksResolutionAgent(pr);
}

type GraphQLReviewThreadsPage = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            isResolved: boolean;
            isOutdated: boolean;
            comments: {
              nodes: Array<{
                createdAt: string;
                author: { login: string } | null;
              }>;
            };
          }>;
        };
      };
    };
  };
};

function fetchReviewThreads(prNumber: number): ReviewThread[] {
  const [owner, repo] = config.repoSlug.split("/");
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterArg = cursor ? `, after:"${cursor}"` : "";
    const query = `query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first:100${afterArg}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first:30) {
            nodes {
              createdAt
              author { login }
            }
          }
        }
      }
    }
  }
}`;
    const page = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `repo=${repo}`,
          "-F",
          `pr=${prNumber}`,
        ],
        { encoding: "utf8", timeout: CHILD_PROCESS_TIMEOUT_MS },
      ),
    ) as GraphQLReviewThreadsPage;

    const reviewThreads = page.data.repository.pullRequest.reviewThreads;
    for (const node of reviewThreads.nodes) {
      threads.push({
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        comments: node.comments.nodes.map((comment) => ({
          createdAt: comment.createdAt,
          authorLogin: comment.author?.login ?? "",
        })),
      });
    }
    hasNextPage = reviewThreads.pageInfo.hasNextPage;
    cursor = reviewThreads.pageInfo.endCursor;
    if (!hasNextPage) {
      break;
    }
  }

  return threads;
}

function hasNewReviewSummaryComment(prNumber: number, phoebeLogin: string, since: string): boolean {
  const { comments } = ghJson<{
    comments: Array<{ body: string; createdAt: string; author: { login: string } }>;
  }>(["pr", "view", String(prNumber), "--json", "comments"]);
  return comments.some(
    (comment) =>
      comment.author.login === phoebeLogin &&
      comment.createdAt > since &&
      isReviewSummaryComment(comment.body),
  );
}

async function runReviewsResolutionAgent(pr: ReviewsCandidate, phoebeLogin: string): Promise<void> {
  const branch = pr.headRefName;
  const runStartedAt = new Date().toISOString();

  fetchOrigin();
  const originShaBefore = originBranchSha(branch);

  const worktreeDir = prepareWorktree({ branch });
  try {
    runShellCommand(config.installCommand, worktreeDir);

    await runAgentInWorktree({
      worktreeDir,
      promptFile: config.promptFiles.reviews,
      promptArgs: {
        PR_NUMBER: String(pr.prNumber),
        PR_BRANCH: branch,
      },
    });

    fetchOrigin();
    const originShaAfter = originBranchSha(branch);
    const localCommitCount = commitCount(worktreeDir, `origin/${branch}..HEAD`);

    if (localCommitCount > 0) {
      pushBranch(worktreeDir, branch);
      console.log(`[phoebe] Review feedback handled for PR #${pr.prNumber} — pushed.`);
    } else if (originShaAfter !== originShaBefore) {
      console.log(
        `[phoebe] Review feedback handled for PR #${pr.prNumber} — already pushed by agent.`,
      );
    }

    const hasSummary = hasNewReviewSummaryComment(pr.prNumber, phoebeLogin, runStartedAt);
    const pushed = localCommitCount > 0 || originShaAfter !== originShaBefore;
    const threadsAfter = fetchReviewThreads(pr.prNumber);
    const latestActivityAt = newestReviewThreadCommentCreatedAt(threadsAfter);

    if (hasSummary) {
      console.log(`[phoebe] Review summary posted for PR #${pr.prNumber}.`);
    } else if (!pushed) {
      console.log(`[phoebe] Review handling for PR #${pr.prNumber} produced no summary or push.`);
    }

    postPrComment(
      pr.prNumber,
      buildReviewsHandledComment({
        latestActivityAt,
        failed: !hasSummary && !pushed,
      }),
    );
  } finally {
    removeWorktree(repoDir, worktreeDir);
  }
}

async function fixOnePrReviews(pr: ReviewsCandidate, phoebeLogin: string): Promise<void> {
  console.log(`[phoebe] Reviews fix: PR #${pr.prNumber} (${pr.headRefName}).`);
  fetchOrigin();
  await runReviewsResolutionAgent(pr, phoebeLogin);
}

async function runOneIssue(
  issueNumber: number,
  issueTitle: string,
  worktreeBase: string,
  stacked: boolean,
  blockerIssueNumber?: number,
  blockerPrNumber?: number,
): Promise<void> {
  const agentBranch = issueBranch(issueNumber);

  fetchOrigin();
  const worktreeDir = prepareWorktree({ branch: agentBranch, baseRef: worktreeBase });
  try {
    runShellCommand(config.installCommand, worktreeDir);

    await runAgentInWorktree({
      worktreeDir,
      promptFile: config.promptFiles.issue,
      promptArgs: { ISSUE_NUMBER: String(issueNumber) },
    });

    const newCommitCount = commitCount(worktreeDir, `${worktreeBase}..HEAD`);

    if (newCommitCount > 0) {
      pushBranch(worktreeDir, agentBranch);
      const existingPr = ghJson<Array<{ number: number }>>([
        "pr",
        "list",
        "--head",
        agentBranch,
        "--state",
        "open",
        "--json",
        "number",
      ])[0]?.number;
      if (existingPr === undefined) {
        const prTitle = `Phoebe: ${issueTitle} (#${issueNumber})`;
        const prBody = buildInitialPrBody({
          issueNumber,
          commitCount: newCommitCount,
          ...(stacked && blockerIssueNumber !== undefined && blockerPrNumber !== undefined
            ? { stacked: { blockerIssueNumber, blockerPrNumber } }
            : {}),
        });
        gh(
          [
            "pr",
            "create",
            "--head",
            agentBranch,
            "--base",
            PR_BASE,
            "--title",
            prTitle,
            "--body-file",
            "-",
          ],
          { input: prBody },
        );
      } else {
        console.log(
          `[phoebe] PR #${existingPr} already exists for ${agentBranch} — posting follow-up note.`,
        );
        postPrComment(existingPr, followUpPrComment(issueNumber, newCommitCount));
      }
    } else {
      console.log("[phoebe] No commits — skipping PR creation.");
    }
  } finally {
    removeWorktree(repoDir, worktreeDir);
  }
}

// ---------------------------------------------------------------------------
// Work kinds + cycle data
// ---------------------------------------------------------------------------

type WorkKind = {
  name: WorkKindName;
  fetch: () => Promise<WorkKindFetch>;
  runUnit: (unit: WorkUnit["unit"]) => Promise<void>;
};

type WorkKindFetch =
  | {
      kind: "conflicts";
      conflictingPrs: ConflictingPrCandidate[];
      issueBodies: Map<number, string>;
      currentMainHead: string;
    }
  | {
      kind: "checks";
      failingCheckPrs: ChecksCandidate[];
      issueBodies: Map<number, string>;
    }
  | {
      kind: "reviews";
      reviewActivityPrs: ReviewsCandidate[];
      issueBodies: Map<number, string>;
      phoebeLogin: string;
    }
  | { kind: "issues"; issues: Issue[]; blockerStates: Map<number, BlockerPrState> };

async function conflictingPrCandidate(pr: OpenPhoebePr): Promise<ConflictingPrCandidate | null> {
  for (let attempt = 0; attempt < MERGEABLE_RETRY_COUNT; attempt++) {
    const info = viewPrMergeInfo(pr.number);
    if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
      const issueNumber = parseIssueNumberFromBranch(info.headRefName);
      return {
        prNumber: info.number,
        headRefName: info.headRefName,
        headSha: info.headRefOid,
        ...(issueNumber !== null ? { issueNumber } : {}),
      };
    }
    if (info.mergeable !== "UNKNOWN") {
      return null;
    }
    if (attempt < MERGEABLE_RETRY_COUNT - 1) {
      await sleep(MERGEABLE_RETRY_MS);
    }
  }
  return null;
}

async function fetchConflictingPrs(): Promise<ConflictingPrCandidate[]> {
  const openPrs = listOpenPhoebePrs();
  const conflicting: ConflictingPrCandidate[] = [];
  for (const pr of openPrs) {
    try {
      const candidate = await conflictingPrCandidate(pr);
      if (candidate) {
        conflicting.push(candidate);
      }
    } catch (error) {
      console.warn(
        `[phoebe] Skipping PR #${pr.number} for conflicts this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return conflicting;
}

// GraphQL statusCheckRollup is not readable by fine-grained PATs (GitHub-App/
// OAuth only), so check state comes from the REST Actions API instead.
function listCommitCheckItems(headSha: string): StatusCheckItem[] {
  return workflowRunsToCheckItems(
    ghJson<WorkflowRunItem[]>([
      "run",
      "list",
      "--commit",
      headSha,
      "--json",
      "workflowName,status,conclusion",
      "--limit",
      "50",
    ]),
  );
}

async function failingChecksCandidate(pr: OpenPhoebePr): Promise<ChecksCandidate | null> {
  for (let attempt = 0; attempt < MERGEABLE_RETRY_COUNT; attempt++) {
    const info = viewPrMergeInfo(pr.number);
    if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
      return null;
    }
    const checkItems = listCommitCheckItems(info.headRefOid);
    const rollup = statusCheckRollupState(checkItems);
    if (rollup === "FAILURE") {
      const issueNumber = parseIssueNumberFromBranch(info.headRefName);
      return {
        prNumber: info.number,
        headRefName: info.headRefName,
        headSha: info.headRefOid,
        mergeable: info.mergeable,
        mergeStateStatus: info.mergeStateStatus,
        failingChecks: listFailingChecks(checkItems),
        ...(issueNumber !== null ? { issueNumber } : {}),
      };
    }
    if (rollup !== "PENDING" && info.mergeable !== "UNKNOWN") {
      return null;
    }
    if (attempt < MERGEABLE_RETRY_COUNT - 1) {
      await sleep(MERGEABLE_RETRY_MS);
    }
  }
  return null;
}

async function fetchFailingCheckPrs(): Promise<ChecksCandidate[]> {
  const openPrs = listOpenPhoebePrs();
  const failing: ChecksCandidate[] = [];
  for (const pr of openPrs) {
    try {
      const candidate = await failingChecksCandidate(pr);
      if (candidate) {
        failing.push(candidate);
      }
    } catch (error) {
      console.warn(
        `[phoebe] Skipping PR #${pr.number} for checks this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failing;
}

async function fetchReviewsWorkData(): Promise<{
  reviewActivityPrs: ReviewsCandidate[];
  issueBodies: Map<number, string>;
  phoebeLogin: string;
}> {
  const phoebeLogin = phoebeGhLogin();
  const openPrs = listOpenPhoebePrs();
  const reviewActivityPrs: ReviewsCandidate[] = [];

  for (const pr of openPrs) {
    try {
      const info = viewPrMergeInfo(pr.number);
      if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
        continue;
      }
      const threads = fetchReviewThreads(pr.number);
      const issueNumber = parseIssueNumberFromBranch(info.headRefName);
      reviewActivityPrs.push({
        prNumber: info.number,
        headRefName: info.headRefName,
        authorLogin: pr.authorLogin,
        mergeable: info.mergeable,
        mergeStateStatus: info.mergeStateStatus,
        threads,
        handledWatermark: prReviewsHandledWatermark(pr.number),
        ...(issueNumber !== null ? { issueNumber } : {}),
      });
    } catch (error) {
      console.warn(
        `[phoebe] Skipping PR #${pr.number} for reviews this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const issueNumbers = [
    ...new Set(
      reviewActivityPrs
        .map((pr) => pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName))
        .filter((n): n is number => n !== null),
    ),
  ];
  const issueBodies = new Map(issueNumbers.map((number) => [number, issueBody(number)] as const));
  return { reviewActivityPrs, issueBodies, phoebeLogin };
}

async function fetchConflictWorkData(): Promise<{
  conflictingPrs: ConflictingPrCandidate[];
  issueBodies: Map<number, string>;
  currentMainHead: string;
}> {
  const rawConflictingPrs = await fetchConflictingPrs();
  fetchOrigin();
  const currentMainHead = originBranchSha(config.defaultBranch);
  const conflictingPrs = rawConflictingPrs.map((pr) => ({
    ...pr,
    failureWatermark: prConflictFailWatermark(pr.prNumber),
  }));
  const issueNumbers = [
    ...new Set(
      conflictingPrs
        .map((pr) => pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName))
        .filter((n): n is number => n !== null),
    ),
  ];
  const issueBodies = new Map(issueNumbers.map((number) => [number, issueBody(number)] as const));
  return { conflictingPrs, issueBodies, currentMainHead };
}

async function fetchChecksWorkData(): Promise<{
  failingCheckPrs: ChecksCandidate[];
  issueBodies: Map<number, string>;
}> {
  const rawFailingPrs = await fetchFailingCheckPrs();
  const failingCheckPrs = rawFailingPrs.map((pr) => ({
    ...pr,
    failureWatermark: prChecksFailWatermark(pr.prNumber),
  }));
  const issueNumbers = [
    ...new Set(
      failingCheckPrs
        .map((pr) => pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName))
        .filter((n): n is number => n !== null),
    ),
  ];
  const issueBodies = new Map(issueNumbers.map((number) => [number, issueBody(number)] as const));
  return { failingCheckPrs, issueBodies };
}

function fetchIssueWorkData(): { issues: Issue[]; blockerStates: Map<number, BlockerPrState> } {
  const issues = listReadyIssues();
  return { issues, blockerStates: buildBlockerStates(issues) };
}

async function runIssueUnit(unit: IssueWorkUnit): Promise<void> {
  const { issue: target, resolution } = unit;
  console.log(
    `[phoebe] Working #${target.number} — base ${resolution.worktreeBase}` +
      (resolution.stacked ? ` (stacked on #${resolution.blockerIssueNumber})` : "") +
      ".",
  );
  await runOneIssue(
    target.number,
    target.title,
    resolution.worktreeBase,
    resolution.stacked,
    resolution.blockerIssueNumber,
    resolution.blockerPrNumber,
  );
}

type ConflictRunContext = {
  issueBodies: Map<number, string>;
  blockerStates: Map<number, BlockerPrState>;
};

let conflictRunContext: ConflictRunContext = {
  issueBodies: new Map(),
  blockerStates: new Map(),
};

let checksRunContext: ConflictRunContext = {
  issueBodies: new Map(),
  blockerStates: new Map(),
};

let reviewsRunContext: { phoebeLogin: string } = { phoebeLogin: "" };

const KINDS: Record<WorkKindName, WorkKind> = {
  conflicts: {
    name: "conflicts",
    fetch: async () => {
      const { conflictingPrs, issueBodies, currentMainHead } = await fetchConflictWorkData();
      return { kind: "conflicts", conflictingPrs, issueBodies, currentMainHead };
    },
    runUnit: async (unit) => {
      await fixOnePrConflict(
        unit as ConflictingPrCandidate,
        conflictRunContext.issueBodies,
        conflictRunContext.blockerStates,
      );
    },
  },
  checks: {
    name: "checks",
    fetch: async () => {
      const { failingCheckPrs, issueBodies } = await fetchChecksWorkData();
      return { kind: "checks", failingCheckPrs, issueBodies };
    },
    runUnit: async (unit) => {
      await fixOnePrChecks(
        unit as ChecksCandidate,
        checksRunContext.issueBodies,
        checksRunContext.blockerStates,
      );
    },
  },
  reviews: {
    name: "reviews",
    fetch: async () => {
      const { reviewActivityPrs, issueBodies, phoebeLogin } = await fetchReviewsWorkData();
      return { kind: "reviews", reviewActivityPrs, issueBodies, phoebeLogin };
    },
    runUnit: async (unit) => {
      await fixOnePrReviews(unit as ReviewsCandidate, reviewsRunContext.phoebeLogin);
    },
  },
  issues: {
    name: "issues",
    fetch: async () => {
      const { issues, blockerStates } = fetchIssueWorkData();
      return { kind: "issues", issues, blockerStates };
    },
    runUnit: async (unit) => {
      await runIssueUnit(unit as IssueWorkUnit);
    },
  },
};

type CycleWorkData = {
  issues: Issue[];
  blockerStates: Map<number, BlockerPrState>;
  conflictingPrs: ConflictingPrCandidate[];
  failingCheckPrs: ChecksCandidate[];
  reviewActivityPrs: ReviewsCandidate[];
  issueBodies: Map<number, string>;
  phoebeLogin?: string;
  currentMainHead?: string;
};

async function fetchCycleWorkData(kinds: readonly WorkKindName[]): Promise<CycleWorkData> {
  let issues: Issue[] = [];
  let blockerStates = new Map<number, BlockerPrState>();
  let conflictingPrs: ConflictingPrCandidate[] = [];
  let failingCheckPrs: ChecksCandidate[] = [];
  let reviewActivityPrs: ReviewsCandidate[] = [];
  let issueBodies = new Map<number, string>();
  let phoebeLogin: string | undefined;
  let currentMainHead: string | undefined;

  for (const kind of kinds) {
    const fetched = await KINDS[kind].fetch();
    if (fetched.kind === "issues") {
      issues = fetched.issues;
      blockerStates = fetched.blockerStates;
    } else if (fetched.kind === "conflicts") {
      conflictingPrs = fetched.conflictingPrs;
      issueBodies = fetched.issueBodies;
      currentMainHead = fetched.currentMainHead;
    } else if (fetched.kind === "checks") {
      failingCheckPrs = fetched.failingCheckPrs;
      for (const [number, body] of fetched.issueBodies) {
        issueBodies.set(number, body);
      }
    } else {
      reviewActivityPrs = fetched.reviewActivityPrs;
      phoebeLogin = fetched.phoebeLogin;
      for (const [number, body] of fetched.issueBodies) {
        issueBodies.set(number, body);
      }
    }
  }

  const allBodies = [...issueBodies.entries()].map(([number, body]) => ({ number, body }));
  if (allBodies.length > 0) {
    const mergedBlockerStates = buildBlockerStatesFromBodies(allBodies);
    for (const [blockerIssue, state] of mergedBlockerStates) {
      blockerStates.set(blockerIssue, state);
    }
  }

  conflictRunContext = { issueBodies, blockerStates };
  checksRunContext = { issueBodies, blockerStates };
  if (phoebeLogin) {
    reviewsRunContext = { phoebeLogin };
  }
  return {
    issues,
    blockerStates,
    conflictingPrs,
    failingCheckPrs,
    reviewActivityPrs,
    issueBodies,
    phoebeLogin,
    currentMainHead,
  };
}

function logIdleCycle(data: CycleWorkData): void {
  const phoebeBase = process.env["PHOEBE_BASE"];
  if (data.issues.length > 0 && !selectIssue(data.issues, data.blockerStates, phoebeBase)) {
    console.log(
      `[phoebe] ${data.issues.length} ${config.readyLabel} issue(s) but none workable this cycle (blocked or waiting on blocker PR).`,
    );
    return;
  }
  if (data.conflictingPrs.length > 0) {
    const conflictBlockerStates = buildBlockerStatesFromBodies(
      [...data.issueBodies.entries()].map(([number, body]) => ({ number, body })),
    );
    const conflictOpts = data.currentMainHead
      ? { currentMainHead: data.currentMainHead }
      : undefined;
    const candidatesWithoutWatermark = selectConflictFixCandidates(
      data.conflictingPrs,
      data.issueBodies,
      conflictBlockerStates,
    );
    const candidates = selectConflictFixCandidates(
      data.conflictingPrs,
      data.issueBodies,
      conflictBlockerStates,
      conflictOpts,
    );
    const unit = selectConflictUnit(
      data.conflictingPrs,
      data.issueBodies,
      conflictBlockerStates,
      conflictOpts,
    );
    const skippedStacked = data.conflictingPrs.length - candidatesWithoutWatermark.length;
    const skippedWatermark = candidatesWithoutWatermark.length - candidates.length;
    if (skippedStacked > 0) {
      console.log(
        `[phoebe] ${skippedStacked} conflicting PR(s) skipped (stacked on open blocker).`,
      );
    }
    if (skippedWatermark > 0) {
      console.log(
        `[phoebe] ${skippedWatermark} conflicting PR(s) skipped (unchanged failure watermark).`,
      );
    }
    if (!unit) {
      console.log(
        `[phoebe] ${data.conflictingPrs.length} conflicting PR(s) but none fixable this cycle.`,
      );
      return;
    }
  }
  if (data.failingCheckPrs.length > 0) {
    const checksBlockerStates = buildBlockerStatesFromBodies(
      [...data.issueBodies.entries()].map(([number, body]) => ({ number, body })),
    );
    const candidatesWithoutWatermark = selectChecksCandidates(
      data.failingCheckPrs,
      data.issueBodies,
      checksBlockerStates,
    );
    const unit = selectChecksUnit(data.failingCheckPrs, data.issueBodies, checksBlockerStates);
    const skippedStacked = data.failingCheckPrs.length - candidatesWithoutWatermark.length;
    if (skippedStacked > 0) {
      console.log(`[phoebe] ${skippedStacked} failing-CI PR(s) skipped (stacked or watermarked).`);
    }
    if (!unit) {
      console.log(
        `[phoebe] ${data.failingCheckPrs.length} failing-CI PR(s) but none fixable this cycle.`,
      );
      return;
    }
  }
  if (data.reviewActivityPrs.length > 0 && data.phoebeLogin) {
    const reviewsBlockerStates = buildBlockerStatesFromBodies(
      [...data.issueBodies.entries()].map(([number, body]) => ({ number, body })),
    );
    const candidates = selectReviewsCandidates(
      data.reviewActivityPrs,
      data.issueBodies,
      reviewsBlockerStates,
      data.phoebeLogin,
    );
    const unit = selectReviewsUnit(
      data.reviewActivityPrs,
      data.issueBodies,
      reviewsBlockerStates,
      data.phoebeLogin,
    );
    const skipped = data.reviewActivityPrs.length - candidates.length;
    if (skipped > 0) {
      console.log(
        `[phoebe] ${skipped} review-feedback PR(s) skipped (stacked, watermarked, or no new activity).`,
      );
    }
    if (!unit) {
      console.log(
        `[phoebe] ${data.reviewActivityPrs.length} review-feedback PR(s) but none fixable this cycle.`,
      );
      return;
    }
  }
  console.log("[phoebe] No work this cycle — idle.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeUnit(picked: WorkUnit): string {
  if (picked.kind === "conflicts") {
    const unit = picked.unit;
    return `conflict fix for PR #${unit.prNumber} (${unit.headRefName})`;
  }
  if (picked.kind === "checks") {
    const unit = picked.unit;
    return `checks fix for PR #${unit.prNumber} (${unit.headRefName})`;
  }
  if (picked.kind === "reviews") {
    const unit = picked.unit;
    return `review feedback for PR #${unit.prNumber} (${unit.headRefName})`;
  }
  const unit = picked.unit;
  return `issue #${unit.issue.number} — base ${unit.resolution.worktreeBase}`;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const runOnce = argv.includes("--run-once");
const dryRun = argv.includes("--dry-run");
const rawPollIntervalMs = Number(process.env["PHOEBE_POLL_INTERVAL_MS"]);
const pollIntervalMs =
  Number.isFinite(rawPollIntervalMs) && rawPollIntervalMs > 0
    ? rawPollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;

console.log(
  runOnce
    ? "[phoebe] Run-once mode — will work at most one unit of the first one-shot-eligible kind in WORK_ORDER, then exit."
    : `[phoebe] Persistent mode — idle poll every ${pollIntervalMs}ms.`,
);
if (dryRun) {
  console.log("[phoebe] Dry-run — selection only, nothing executes.");
}

while (true) {
  exitForSelfUpdateIfNeeded();

  const fetchKinds = runOnce ? oneShotWorkKinds(workOrder) : workOrder;
  const data = await fetchCycleWorkData(fetchKinds);
  const picked = selectFirstWorkUnit(
    workOrder,
    {
      issues: data.issues,
      blockerStates: data.blockerStates,
      conflictingPrs: data.conflictingPrs,
      failingCheckPrs: data.failingCheckPrs,
      reviewActivityPrs: data.reviewActivityPrs,
      issueBodies: data.issueBodies,
      phoebeBase: process.env["PHOEBE_BASE"],
      phoebeLogin: data.phoebeLogin,
      currentMainHead: data.currentMainHead,
    },
    { oneShotOnly: runOnce },
  );

  if (!picked) {
    if (runOnce) {
      console.log(RUN_ONCE_NOTHING_MESSAGE);
    } else {
      logIdleCycle(data);
    }
    if (runOnce || dryRun) break;
    await sleep(pollIntervalMs);
    continue;
  }

  const decision = executionDecision({ dryRun, inContainer });
  if (decision === "dry-run") {
    console.log(`[phoebe] Would execute: ${describeUnit(picked)}.`);
    break;
  }
  if (decision === "refuse") {
    console.error(EXECUTION_REFUSED_MESSAGE);
    process.exit(1);
  }

  try {
    await KINDS[picked.kind].runUnit(picked.unit);
  } catch (error) {
    if (runOnce) {
      throw error;
    }
    // A failed unit must not kill the daemon — prepareWorktree clears any
    // stale worktree on the next attempt.
    console.error(
      `[phoebe] Failed executing ${describeUnit(picked)} — ${error instanceof Error ? error.message : String(error)}`,
    );
    await sleep(pollIntervalMs);
    continue;
  }

  if (runOnce) break;
}
