// PROTOTYPE (#980), throwaway. Build `fixture/units.jsonl`, a stand-in for
// `state/<pipeline>/units.jsonl`, from this repo's own GitHub history.
//
//   node kinds/observer/prototype-grouping/build-fixture.ts [--days 30]
//
// What it reconstructs, and how faithful each part is, is in README.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentRunRecord,
  UnitRecord,
  UnitRecordOutcome,
} from "../../../src/contracts/unit-record.ts";
import { argValue, ghJson, oneLine, PROTO_DIR, REPO_SLUG } from "./lib.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BUDGET_MS = 2_700_000; // DEFAULT_RUN_TIMEOUT_MS, src/run-timeout.ts
const PHOEBE_NAME = "Phoebe"; // the git author name Phoebe commits under here
const OPERATOR_LOGIN = "mikeallisonJS"; // Phoebe and the operator share this login

const days = Number(argValue("--days") ?? 30);
const now = new Date();
const since = new Date(now.getTime() - days * DAY);
const sinceDay = since.toISOString().slice(0, 10);
const inWindow = (iso: string): boolean => Date.parse(iso) >= since.getTime();

/** Deterministic "random" in [0,1) from a string, so re-runs build the same fixture. */
function jitter(seed: string): number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/** The model and effort this repo's `.phoebe/phoebe.config.ts` gives each kind. */
const MODEL: Record<string, [string, string]> = {
  issues: ["claude-opus-5-5", "high"],
  research: ["claude-opus-5-5", "high"],
  conflicts: ["claude-opus-5-5", "high"],
  dependencies: ["claude-opus-5-5", "high"],
  checks: ["claude-sonnet-5-5", "medium"],
  reviews: ["claude-sonnet-5-5", "medium"],
  "skill-updates": ["claude-opus-5-5", "low"],
};

function makeRecord(opts: {
  pipeline: string;
  kind: string;
  id: string;
  outcome: UnitRecordOutcome;
  startedAt: Date;
  settledAt: Date;
  detail: string | null;
  branch: string | null;
  prNumber: number | null;
  quarantined?: boolean;
}): UnitRecord {
  const [model, effort] = MODEL[opts.kind] ?? ["claude-opus-5-5", "low"];
  const durationMs = Math.max(0, opts.settledAt.getTime() - opts.startedAt.getTime());
  const run: AgentRunRecord = {
    startedAt: opts.startedAt.toISOString(),
    durationMs,
    exitCode: opts.outcome === "completed" ? 0 : opts.outcome === "failed" ? 1 : null,
    promptSha: "unknown",
    costBasis: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
    turns: null,
    providerDurationMs: null,
    stopReason: null,
    reportedModels: [],
    usageComplete: opts.outcome !== "timed-out",
    toolCalls: {},
  };
  return {
    v: 1,
    tenant: "phoebe",
    pipeline: opts.pipeline,
    unit: { kind: opts.kind, id: opts.id },
    outcome: opts.outcome,
    quarantined: opts.quarantined ?? false,
    detail: opts.detail === null ? null : oneLine(opts.detail, 500),
    startedAt: opts.startedAt.toISOString(),
    settledAt: opts.settledAt.toISOString(),
    durationMs,
    runBudgetMs: BUDGET_MS,
    provider: "claude",
    model,
    effort,
    branch: opts.branch,
    headSha: null,
    prNumber: opts.prNumber,
    engineCommit: null,
    agentRuns: [run],
  };
}

type Label = { name: string };
type ListedPr = {
  number: number;
  title: string;
  author: { login: string };
  createdAt: string;
  headRefName: string;
  labels: Label[];
  state: string;
};
type PrCommit = { committedDate: string; messageHeadline: string; authors: { name: string }[] };
type PrDetail = { commits: PrCommit[]; closingIssuesReferences: { number: number }[] };
type Comment = { author: { login: string } | null; createdAt: string; body: string };
type IssueDetail = {
  title: string;
  labels: Label[];
  createdAt: string;
  comments: Comment[];
};

function issueDetail(n: number): IssueDetail {
  return ghJson<IssueDetail>([
    "issue",
    "view",
    String(n),
    "-R",
    REPO_SLUG,
    "--json",
    "title,labels,createdAt,comments",
  ]);
}

/** The pipeline and kind an issue's labels route it to. */
function issueRoute(labels: readonly Label[]): { pipeline: string; kind: string } {
  const names = new Set(labels.map((label) => label.name));
  if (names.has("phoebe:dependencies") || names.has("dependencies")) {
    return { pipeline: "dependencies", kind: "dependencies" };
  }
  if (names.has("wayfinder:research")) return { pipeline: "work", kind: "research" };
  return { pipeline: "work", kind: "issues" };
}

const records: UnitRecord[] = [];
const notes: string[] = [];

// --- 1. One completed unit per Phoebe-authored PR, plus follow-up units ------

const listed = ghJson<ListedPr[]>([
  "pr",
  "list",
  "-R",
  REPO_SLUG,
  "--state",
  "all",
  "--search",
  `created:>=${sinceDay}`,
  "--limit",
  "1000",
  "--json",
  "number,title,author,createdAt,headRefName,labels,state",
]).filter((pr) => inWindow(pr.createdAt));

let phoebePrs = 0;
let operatorPhoebeTitled = 0;
for (const pr of listed) {
  const renovate = pr.headRefName.startsWith("renovate/");
  if (!pr.title.startsWith("Phoebe:") && !renovate) continue;
  const detail = ghJson<PrDetail>([
    "pr",
    "view",
    String(pr.number),
    "-R",
    REPO_SLUG,
    "--json",
    "commits,closingIssuesReferences",
  ]);
  const commits = [...detail.commits].sort(
    (a, b) => Date.parse(a.committedDate) - Date.parse(b.committedDate),
  );
  const byPhoebe = (commit: PrCommit) => commit.authors[0]?.name === PHOEBE_NAME;
  const createdAt = new Date(pr.createdAt);

  let followUpKindDefault = "reviews";
  if (!renovate) {
    if (commits[0] === undefined || !byPhoebe(commits[0])) {
      // Titled like Phoebe, but the operator wrote it: not a unit.
      operatorPhoebeTitled += 1;
      continue;
    }
    phoebePrs += 1;
    const closing = detail.closingIssuesReferences.map((ref) => ref.number);
    const fromBranch = /^phoebe\/issue-(\d+)/.exec(pr.headRefName)?.[1];
    const issue = closing[0] ?? (fromBranch === undefined ? null : Number(fromBranch));
    let pipeline = "work";
    let kind = "issues";
    let id = issue === null ? `pr:${pr.number}` : `issue:${issue}`;
    const skill = /^phoebe\/skill-updates\/(.+)$/.exec(pr.headRefName);
    if (skill !== null) {
      pipeline = "skills";
      kind = "skill-updates";
      id = `skill-updates:${skill[1]}`;
    } else if (issue !== null) {
      ({ pipeline, kind } = issueRoute(issueDetail(issue).labels));
    }
    // The run that opened the PR: it started a plausible while before.
    const runMs = (kind === "dependencies" ? 8 : 18) * MIN + jitter(id) * 22 * MIN;
    records.push(
      makeRecord({
        pipeline,
        kind,
        id,
        outcome: "completed",
        startedAt: new Date(createdAt.getTime() - runMs),
        settledAt: createdAt,
        detail: null,
        branch: pr.headRefName,
        prNumber: pr.number,
      }),
    );
    followUpKindDefault = kind === "dependencies" ? "checks" : "reviews";
  } else {
    followUpKindDefault = "checks"; // Renovate branches are admitted to `checks` only.
  }

  // Later Phoebe pushes onto the PR are other units: reviews, checks, conflicts.
  const later = commits.filter(
    (commit) => byPhoebe(commit) && Date.parse(commit.committedDate) > createdAt.getTime() + 2 * MIN,
  );
  const groups: PrCommit[][] = [];
  for (const commit of later) {
    const last = groups.at(-1)?.at(-1);
    if (last !== undefined && Date.parse(commit.committedDate) - Date.parse(last.committedDate) < 15 * MIN) {
      groups.at(-1)!.push(commit);
    } else {
      groups.push([commit]);
    }
  }
  for (const group of groups) {
    const heads = group.map((commit) => commit.messageHeadline).join(" | ");
    const kind = /review/i.test(heads)
      ? "reviews"
      : /merge (main|blocker)|conflict/i.test(heads)
        ? "conflicts"
        : /\b(ci|check|lint|format|typecheck|changeset|test)/i.test(heads)
          ? "checks"
          : followUpKindDefault;
    const first = Date.parse(group[0]!.committedDate);
    const last = Date.parse(group.at(-1)!.committedDate);
    const id = `pr:${pr.number}`;
    records.push(
      makeRecord({
        pipeline: "work",
        kind,
        id,
        outcome: "completed",
        startedAt: new Date(first - (5 + jitter(id + first) * 10) * MIN),
        settledAt: new Date(last + MIN),
        detail: null,
        branch: pr.headRefName,
        prNumber: pr.number,
      }),
    );
  }
}
notes.push(
  `${phoebePrs} Phoebe-authored PRs; ${operatorPhoebeTitled} PRs titled "Phoebe:" whose first ` +
    `commit is the operator's, skipped`,
);

// --- 2. Failure records from issue and PR traces -----------------------------

const TIMEOUT_RE = /<!--\s*phoebe-unit-timeout:\s*n=(\d+)\s*-->/;
const QUARANTINE_RE = /Phoebe quarantined this unit: (.*?)\. It has been labelled/;
const QUARANTINE_KIND_RE = /the `([\w-]+)` work on #/;
const FAIL_MARKER_RE = /<!--\s*phoebe-(checks|conflict)-fail:/;
const BLOCKED_RE = /^<!--\s*phoebe-blocked\s*-->/im;

type Hit = { number: number; isPullRequest: boolean; updatedAt: string };
const hits = new Map<number, Hit>();
for (const term of [
  "phoebe-unit-timeout",
  "phoebe-checks-fail",
  "phoebe-conflict-fail",
  "phoebe-blocked",
]) {
  for (const hit of ghJson<Hit[]>([
    "search",
    "issues",
    "--repo",
    REPO_SLUG,
    term,
    "--include-prs",
    "--limit",
    "500",
    "--json",
    "number,isPullRequest,updatedAt",
  ])) {
    if (inWindow(hit.updatedAt)) hits.set(hit.number, hit);
  }
}

/** A comment Phoebe or the operator wrote that only bookkeeps, never explains a run. */
const bookkeeping = (body: string): boolean =>
  TIMEOUT_RE.test(body) ||
  QUARANTINE_RE.test(body) ||
  /^Addressed by Phoebe:/.test(body) ||
  /^Phoebe update for #/.test(body) ||
  /^⛓️ Blocked by/.test(body) ||
  /^## Review feedback addressed/.test(body) ||
  /phoebe-quarantine-cleared|phoebe-blocked-ack|phoebe-reviews-handled/.test(body);

/**
 * Failure text the GitHub trace does not carry but a person recorded. The
 * engine's record would have held the install error; #773 says what it was.
 */
const RECONSTRUCTED_DETAIL: Record<number, string> = {
  755:
    "Command failed: pnpm install --frozen-lockfile — Error: Cannot find module " +
    "'/opt/corepack/v1/pnpm/12.16.1/bin/pnpm.cjs' (MODULE_NOT_FOUND) [reconstructed from #773]",
  763:
    "Command failed: pnpm install --frozen-lockfile — Error: Cannot find module " +
    "'/opt/corepack/v1/pnpm/12.16.1/bin/pnpm.cjs' (MODULE_NOT_FOUND) [reconstructed from #773]",
};

let markerCount = 0;
let failureComments = 0;
let blockedComments = 0;
for (const hit of [...hits.values()].sort((a, b) => a.number - b.number)) {
  let comments: Comment[];
  let route: { pipeline: string; kind: string };
  let branch: string;
  let threadCreated: string;
  if (hit.isPullRequest) {
    const pr = ghJson<{ comments: Comment[]; headRefName: string; createdAt: string }>([
      "pr",
      "view",
      String(hit.number),
      "-R",
      REPO_SLUG,
      "--json",
      "comments,headRefName,createdAt",
    ]);
    comments = pr.comments;
    branch = pr.headRefName;
    threadCreated = pr.createdAt;
    route = { pipeline: "work", kind: "checks" };
  } else {
    const issue = issueDetail(hit.number);
    comments = issue.comments;
    branch = `phoebe/issue-${hit.number}`;
    threadCreated = issue.createdAt;
    route = issueRoute(issue.labels);
  }
  comments = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const mine = (comment: Comment) => comment.author?.login === OPERATOR_LOGIN;
  const used = new Set<Comment>();
  type Burst = { record: UnitRecord; count: number; n: number[] };
  const bursts: Burst[] = [];
  let current: Burst | undefined;
  let previousAt = Date.parse(threadCreated);

  comments.forEach((comment, index) => {
    const marker = TIMEOUT_RE.exec(comment.body);
    if (marker === null || !mine(comment)) return;
    const at = Date.parse(comment.createdAt);
    const gap = at - previousAt;
    if (!inWindow(comment.createdAt)) {
      previousAt = at;
      return;
    }
    markerCount += 1;
    // The comment the run itself left, just before the sweep's marker.
    let explained: Comment | undefined;
    for (let j = index - 1; j >= 0; j -= 1) {
      const prior = comments[j]!;
      if (Date.parse(prior.createdAt) <= previousAt) break;
      if (at - Date.parse(prior.createdAt) > 10 * MIN) break;
      if (mine(prior) && !bookkeeping(prior.body)) {
        explained = prior;
        break;
      }
    }
    if (explained !== undefined) used.add(explained);
    const next = comments[index + 1];
    const quarantine =
      next !== undefined &&
      mine(next) &&
      QUARANTINE_RE.test(next.body) &&
      Date.parse(next.createdAt) - at < 2 * MIN;
    // A marker under 3 minutes after the last one is the sweep re-arming a
    // claim no agent run could have used (worktree + install alone take
    // longer): fold it into the record before rather than invent a run.
    const open = current;
    if (open !== undefined && gap < 3 * MIN && explained === undefined) {
      if (quarantine) open.record.quarantined = true;
      open.count += 1;
      open.n.push(Number(marker[1]));
      open.record.settledAt = new Date(at - 15_000).toISOString();
      open.record.durationMs = Date.parse(open.record.settledAt) - Date.parse(open.record.startedAt);
      previousAt = at;
      return;
    }
    let kind = route.kind;
    // On an issue the sweep always names `issues`, whatever kind ran.
    if (quarantine && hit.isPullRequest) kind = QUARANTINE_KIND_RE.exec(next!.body)?.[1] ?? kind;
    if (explained !== undefined && FAIL_MARKER_RE.test(explained.body)) {
      kind = FAIL_MARKER_RE.exec(explained.body)![1] === "conflict" ? "conflicts" : "checks";
    }

    let outcome: UnitRecordOutcome;
    let detail: string;
    let runMs: number;
    if (hit.isPullRequest) {
      // On a PR the marker is the timeout path itself (recordUnitTimeout).
      outcome = "timed-out";
      detail = `${BUDGET_MS / 1000}s budget exceeded`;
      runMs = BUDGET_MS + 30_000;
    } else if (explained !== undefined) {
      // The run ended and said why it opened no PR.
      outcome = "failed";
      detail = explained.body;
      runMs = Math.min(Math.max(gap * 0.8, 4 * MIN), 30 * MIN);
    } else if (gap >= 44 * MIN && gap <= 3 * 60 * MIN) {
      outcome = "timed-out";
      detail = `${BUDGET_MS / 1000}s budget exceeded`;
      runMs = BUDGET_MS + 30_000;
    } else {
      outcome = "failed";
      detail =
        RECONSTRUCTED_DETAIL[hit.number] ??
        "the run left no PR and no comment; the stranded-unit sweep re-armed it";
      runMs = Math.min(Math.max(gap * 0.8, 4 * MIN), 30 * MIN);
    }
    const record = makeRecord({
        pipeline: route.pipeline,
        kind,
        id: hit.isPullRequest ? `pr:${hit.number}` : `issue:${hit.number}`,
        outcome,
        startedAt: new Date(at - runMs),
        settledAt: new Date(at - 15_000),
        detail,
        branch,
        prNumber: hit.isPullRequest ? hit.number : null,
        quarantined: quarantine,
      });
    records.push(record);
    current = { record, count: 1, n: [Number(marker[1])] };
    bursts.push(current);
    previousAt = at;
  });

  for (const { record, count, n } of bursts) {
    if (count < 2) continue;
    const resets = n.filter((value, i) => i > 0 && value <= n[i - 1]!).length;
    record.detail = oneLine(
      `${record.detail ?? ""} [fixture: ${count} stranded-unit markers in ` +
        `${Math.round((record.durationMs ?? 0) / MIN)} min, n=${n.slice(0, 6).join(",")}` +
        `${n.length > 6 ? ",…" : ""}; the count went back down ${resets} times and no ` +
        `quarantine comment was posted]`,
      500,
    );
  }

  // A run that stopped and said a person has to act (src/blocked.ts).
  for (const comment of comments) {
    if (!BLOCKED_RE.test(comment.body) || !mine(comment) || used.has(comment)) continue;
    if (!inWindow(comment.createdAt)) continue;
    blockedComments += 1;
    const at = Date.parse(comment.createdAt);
    records.push(
      makeRecord({
        pipeline: route.pipeline,
        kind: hit.isPullRequest ? "reviews" : route.kind,
        id: hit.isPullRequest ? `pr:${hit.number}` : `issue:${hit.number}`,
        outcome: "failed",
        startedAt: new Date(at - (10 + jitter(comment.createdAt) * 20) * MIN),
        settledAt: new Date(at + 5_000),
        detail: comment.body.replace(BLOCKED_RE, ""),
        branch,
        prNumber: hit.isPullRequest ? hit.number : null,
      }),
    );
  }

  // Phoebe's own failure comments no marker followed: a failed checks/conflicts run.
  if (hit.isPullRequest) {
    comments.forEach((comment, index) => {
      const fail = FAIL_MARKER_RE.exec(comment.body);
      if (fail === null || used.has(comment) || !inWindow(comment.createdAt)) return;
      failureComments += 1;
      const at = Date.parse(comment.createdAt);
      // The run's own account usually sits just above the engine's failure comment.
      const prior = comments[index - 1];
      const account =
        prior !== undefined &&
        mine(prior) &&
        !bookkeeping(prior.body) &&
        !FAIL_MARKER_RE.test(prior.body) &&
        at - Date.parse(prior.createdAt) < 3 * MIN
          ? `${oneLine(prior.body, 360)} — `
          : "";
      const kind = fail[1] === "conflict" ? "conflicts" : "checks";
      records.push(
        makeRecord({
          pipeline: "work",
          kind,
          id: `pr:${hit.number}`,
          outcome: "failed",
          startedAt: new Date(at - (8 + jitter(comment.createdAt) * 12) * MIN),
          settledAt: new Date(at - 10_000),
          detail: `${account}${comment.body}`,
          branch,
          prNumber: hit.number,
        }),
      );
    });
  }
}
notes.push(
  `${hits.size} issues/PRs with a timeout or failure marker touched in the window; ` +
    `${markerCount} timeout markers, ${failureComments} unmarked checks/conflict failure comments ` +
    `and ${blockedComments} phoebe-blocked comments became records`,
);

// --- Write ------------------------------------------------------------------

records.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
const outDir = join(PROTO_DIR, "fixture");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "units.jsonl"),
  records.map((record) => JSON.stringify(record)).join("\n") + "\n",
);
writeFileSync(
  join(outDir, "meta.json"),
  `${JSON.stringify({ builtAt: now.toISOString(), days, since: since.toISOString(), notes }, null, 2)}\n`,
);

const counts = new Map<string, number>();
for (const record of records) {
  const key = `${record.pipeline}/${record.unit.kind} ${record.outcome}${record.quarantined ? " (quarantined)" : ""}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log(`fixture: ${records.length} unit records since ${since.toISOString()} (${days}d)`);
for (const note of notes) console.log(`  ${note}`);
for (const [key, count] of [...counts].sort()) console.log(`  ${String(count).padStart(4)}  ${key}`);
