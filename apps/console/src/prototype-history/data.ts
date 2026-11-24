// PROTOTYPE — throwaway, map #914 ticket #919. Not production code.
//
// Fake unit history shaped like the contracts #917 and #918 settled
// (`UnitRecord`, `HistorySummary`, `HistoryPage`), generated deterministically
// so every reload shows the same rows. The real types will live in
// `src/contracts/unit-record.ts`; these are local copies.

export type Outcome = "completed" | "failed" | "timed-out" | "abandoned";
export type CostBasis = "api" | "subscription-estimate" | null;

export type AgentRun = {
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  promptSha: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  turns: number | null;
  providerDurationMs: number | null;
  stopReason: string | null;
  reportedModels: string[];
  usageComplete: boolean;
  costBasis: CostBasis;
  toolCalls: Record<string, number>;
};

export type UnitRecord = {
  v: 1;
  tenant: string;
  pipeline: string;
  cell: string;
  unit: { kind: string; id: string };
  title: string;
  outcome: Outcome;
  quarantined: boolean;
  detail: string | null;
  startedAt: string;
  settledAt: string | null;
  durationMs: number | null;
  runBudgetMs: number | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  branch: string | null;
  headSha: string | null;
  prNumber: number | null;
  engineCommit: string;
  agentRuns: AgentRun[];
};

export type Window = {
  units: number;
  byOutcome: Record<Outcome, number>;
  quarantined: number;
  costUsd: { api: number; estimate: number };
  unitsWithoutCost: number;
  usageIncomplete: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export type HistorySummary = { asOf: string; h24: Window; d7: Window };

export const REPO = "JesusFilm/youtube-studio";
const TENANT_ID = "/etc/phoebe";

// ── deterministic generator ────────────────────────────────────────────────

let seed = 914;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}
function hex(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += "0123456789abcdef"[Math.floor(rand() * 16)];
  return out;
}

type KindPlan = {
  pipeline: "work" | "intake";
  kind: string;
  provider: "claude" | "cursor" | "codex";
  model: string;
  effort: string | null;
  basis: CostBasis;
  weight: number;
  budgetMin: number;
  /** Typical minutes and dollars. */
  minutes: number;
  dollars: number;
};

const PLANS: KindPlan[] = [
  {
    pipeline: "work",
    kind: "issues",
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    basis: "subscription-estimate",
    weight: 5,
    budgetMin: 60,
    minutes: 22,
    dollars: 3.4,
  },
  {
    pipeline: "work",
    kind: "reviews",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: null,
    basis: "api",
    weight: 4,
    budgetMin: 30,
    minutes: 7,
    dollars: 0.62,
  },
  {
    pipeline: "work",
    kind: "checks",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: null,
    basis: "api",
    weight: 3,
    budgetMin: 30,
    minutes: 9,
    dollars: 0.81,
  },
  {
    pipeline: "work",
    kind: "conflicts",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: null,
    basis: "api",
    weight: 2,
    budgetMin: 30,
    minutes: 4,
    dollars: 0.35,
  },
  {
    pipeline: "intake",
    kind: "research",
    provider: "cursor",
    model: "sonnet-5.5",
    effort: null,
    basis: null,
    weight: 2,
    budgetMin: 45,
    minutes: 14,
    dollars: 0,
  },
  {
    pipeline: "intake",
    kind: "dependencies",
    provider: "codex",
    model: "gpt-6-codex",
    effort: "medium",
    basis: null,
    weight: 2,
    budgetMin: 40,
    minutes: 11,
    dollars: 0,
  },
];

const TITLES: Record<string, string[]> = {
  issues: [
    "Add captions export to the studio editor",
    "Thumbnail picker drops the last frame",
    "Cache channel analytics for 10 minutes",
    "Bulk-edit video visibility",
    "Retry failed uploads from the queue view",
    "Show quota usage on the dashboard",
  ],
  reviews: ["Address review on captions export", "Address review on upload retry"],
  checks: ["Fix failing lint on analytics cache", "Fix e2e timeout in upload spec"],
  conflicts: ["Rebase thumbnail picker onto main"],
  research: ["Research: YouTube Data API quota rules", "Research: caption format support"],
  dependencies: ["Update @vitejs/plugin-react bundle", "Update googleapis to 171"],
};

const FAIL_DETAILS = [
  "Agent exited with code 1.",
  "push rejected: branch protection requires a review",
  "installCommand failed: pnpm install exited 1",
  "gh: GraphQL: Resource not accessible by integration",
];

function weightedPlan(): KindPlan {
  const total = PLANS.reduce((sum, plan) => sum + plan.weight, 0);
  let roll = rand() * total;
  for (const plan of PLANS) {
    roll -= plan.weight;
    if (roll <= 0) return plan;
  }
  return PLANS[0] as KindPlan;
}

function agentRun(plan: KindPlan, startedAt: number, ms: number, killed: boolean): AgentRun {
  const scale = 0.4 + rand() * 1.6;
  const input = Math.round(18_000 * scale);
  const output = killed ? null : Math.round(9_000 * scale);
  const cacheRead = Math.round(420_000 * scale);
  const cacheWrite = plan.provider === "codex" ? null : Math.round(60_000 * scale);
  const cost =
    plan.provider === "claude" && !killed ? Math.round(plan.dollars * scale * 100) / 100 : null;
  return {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: ms,
    exitCode: killed ? null : 0,
    promptSha: `sha256:${hex(8)}`,
    inputTokens: plan.provider === "codex" && killed ? null : input,
    outputTokens: output,
    cacheReadTokens: plan.provider === "codex" && killed ? null : cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: output === null ? null : Math.round(output * 0.3),
    costUsd: cost,
    turns: plan.provider === "claude" && !killed ? Math.round(20 + 40 * scale) : null,
    providerDurationMs: plan.provider === "codex" || killed ? null : ms - 1500,
    stopReason: plan.provider === "claude" && !killed ? "end_turn" : null,
    reportedModels: plan.provider === "codex" ? [] : [plan.model],
    usageComplete: !killed,
    costBasis: plan.basis,
    toolCalls: {
      Bash: Math.round(30 * scale),
      Edit: Math.round(12 * scale),
      Read: Math.round(25 * scale),
      Grep: Math.round(8 * scale),
    },
  };
}

function generate(now: number): UnitRecord[] {
  seed = 914;
  const records: UnitRecord[] = [];
  let issue = 1180;
  let t = now - 12 * 86_400_000;
  while (t < now - 20 * 60_000) {
    t += (40 + rand() * 140) * 60_000;
    const plan = weightedPlan();
    const roll = rand();
    const outcome: Outcome =
      roll < 0.8 ? "completed" : roll < 0.9 ? "failed" : roll < 0.975 ? "timed-out" : "abandoned";
    const budgetMs = plan.budgetMin * 60_000;
    const workMs =
      outcome === "timed-out"
        ? budgetMs
        : Math.round(plan.minutes * 60_000 * (0.5 + rand()) * (outcome === "failed" ? 0.4 : 1));
    const clean = plan.kind === "conflicts" && rand() < 0.4;
    const killed = outcome === "timed-out" || outcome === "abandoned";
    const runs =
      outcome === "abandoned" || clean
        ? []
        : plan.kind === "dependencies" && rand() < 0.5
          ? [
              agentRun(plan, t, Math.round(workMs * 0.45), false),
              agentRun(plan, t + workMs * 0.5, Math.round(workMs * 0.45), killed),
            ]
          : [agentRun(plan, t, workMs - 20_000, killed)];
    issue += 1;
    const isPrKind = ["reviews", "checks", "conflicts"].includes(plan.kind);
    const pr = isPrKind ? 900 + Math.floor(rand() * 60) : rand() < 0.7 ? issue + 3 : null;
    const branch =
      plan.kind === "research"
        ? null
        : plan.kind === "dependencies"
          ? `phoebe/deps-${hex(4)}`
          : `phoebe/issue-${issue}`;
    records.push({
      v: 1,
      tenant: REPO,
      pipeline: plan.pipeline,
      cell: `${TENANT_ID}#${plan.pipeline}`,
      unit: {
        kind: plan.kind,
        id: isPrKind
          ? `pr:${pr}`
          : plan.kind === "dependencies"
            ? `bundle:${hex(6)}`
            : `issue:${issue}`,
      },
      title: pick(TITLES[plan.kind] ?? ["Untitled"]),
      outcome,
      quarantined: outcome === "timed-out" && rand() < 0.35,
      detail:
        outcome === "failed"
          ? pick(FAIL_DETAILS)
          : outcome === "timed-out"
            ? `${plan.budgetMin * 60}s budget exceeded`
            : outcome === "abandoned"
              ? "the pipeline process ended mid-unit"
              : null,
      startedAt: new Date(t).toISOString(),
      settledAt: outcome === "abandoned" ? null : new Date(t + workMs).toISOString(),
      durationMs: outcome === "abandoned" ? null : workMs,
      runBudgetMs: budgetMs,
      provider: plan.provider,
      model: plan.model,
      effort: plan.effort,
      branch,
      headSha: branch === null || outcome === "abandoned" ? null : hex(7),
      prNumber: outcome === "completed" ? pr : null,
      engineCommit: rand() < 0.6 ? "dd6f67d" : "a1b2c3d",
      agentRuns: runs,
    });
  }
  return records.reverse();
}

export const NOW_MS = Date.now();
export const RECORDS: UnitRecord[] = generate(NOW_MS);

// ── derivations the deployment would do ────────────────────────────────────

export function costOf(record: UnitRecord): {
  usd: number | null;
  basis: CostBasis;
  partial: boolean;
} {
  if (record.agentRuns.length === 0) return { usd: null, basis: null, partial: false };
  const costs = record.agentRuns.map((run) => run.costUsd);
  const known = costs.filter((cost): cost is number => cost !== null);
  return {
    usd: known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
    basis: record.agentRuns[0]?.costBasis ?? null,
    partial: record.agentRuns.some((run) => !run.usageComplete),
  };
}

export function tokensOf(record: UnitRecord): { input: number | null; output: number | null } {
  if (record.agentRuns.length === 0) return { input: null, output: null };
  const sum = (pick: (run: AgentRun) => number | null): number | null => {
    const known = record.agentRuns.map(pick).filter((n): n is number => n !== null);
    return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
  };
  return { input: sum((run) => run.inputTokens), output: sum((run) => run.outputTokens) };
}

function emptyWindow(): Window {
  return {
    units: 0,
    byOutcome: { completed: 0, failed: 0, "timed-out": 0, abandoned: 0 },
    quarantined: 0,
    costUsd: { api: 0, estimate: 0 },
    unitsWithoutCost: 0,
    usageIncomplete: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function fold(window: Window, record: UnitRecord): void {
  window.units += 1;
  window.byOutcome[record.outcome] += 1;
  if (record.quarantined) window.quarantined += 1;
  const cost = costOf(record);
  if (cost.usd === null) window.unitsWithoutCost += 1;
  else if (cost.basis === "api") window.costUsd.api += cost.usd;
  else window.costUsd.estimate += cost.usd;
  if (cost.partial) window.usageIncomplete += 1;
  for (const run of record.agentRuns) {
    window.tokens.input += run.inputTokens ?? 0;
    window.tokens.output += run.outputTokens ?? 0;
    window.tokens.cacheRead += run.cacheReadTokens ?? 0;
    window.tokens.cacheWrite += run.cacheWriteTokens ?? 0;
  }
}

export function summarize(records: readonly UnitRecord[]): HistorySummary {
  const h24 = emptyWindow();
  const d7 = emptyWindow();
  for (const record of records) {
    const age = NOW_MS - Date.parse(record.startedAt);
    if (age <= 7 * 86_400_000) fold(d7, record);
    if (age <= 86_400_000) fold(h24, record);
  }
  return { asOf: new Date(NOW_MS - 7 * 60_000).toISOString(), h24, d7 };
}

export function cellsOfHistory(): string[] {
  return [...new Set(RECORDS.map((record) => record.cell))];
}

export function retainedSince(cell?: string): string {
  const own = RECORDS.filter((record) => cell === undefined || record.cell === cell);
  return own[own.length - 1]?.startedAt ?? new Date(NOW_MS).toISOString();
}

export type Filters = {
  cell?: string;
  kind?: string;
  outcome?: Outcome;
  model?: string;
};

export function filterRecords(filters: Filters): UnitRecord[] {
  return RECORDS.filter(
    (record) =>
      (filters.cell === undefined || record.cell === filters.cell) &&
      (filters.kind === undefined || record.unit.kind === filters.kind) &&
      (filters.outcome === undefined || record.outcome === filters.outcome) &&
      (filters.model === undefined || record.model === filters.model),
  );
}

// ── formatting ─────────────────────────────────────────────────────────────

export function usd(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

export function compact(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function mins(ms: number | null): string {
  if (ms === null) return "—";
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ageOf(iso: string): string {
  const s = Math.max(0, Math.round((NOW_MS - Date.parse(iso)) / 1000));
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function githubHref(record: UnitRecord): string | null {
  if (record.prNumber !== null) return `https://github.com/${REPO}/pull/${record.prNumber}`;
  const [type, n] = record.unit.id.split(":");
  if (type === "issue") return `https://github.com/${REPO}/issues/${n}`;
  if (type === "pr") return `https://github.com/${REPO}/pull/${n}`;
  return null;
}

export const KINDS = [...new Set(RECORDS.map((record) => record.unit.kind))];
export const MODELS = [...new Set(RECORDS.map((record) => record.model ?? "unknown"))];
export const OUTCOMES: Outcome[] = ["completed", "failed", "timed-out", "abandoned"];
