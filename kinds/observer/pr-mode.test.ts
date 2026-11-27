// PR mode end to end against real git (#936): an origin holding the files that
// steer Phoebe, the hub clone the engine works from, and a runtime root with
// the governing config. GitHub is the stub; the agent is a fake that groups on
// the first call and edits the worktree it is handed on every call after.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { UnitRecord } from "../../src/contracts/unit-record.ts";
import { resolveConfig } from "../../src/config-schema.ts";
import type { MentioningPr, UnitTarget } from "../../src/github-client.ts";
import { stubGitHub } from "../../src/github-stub.ts";
import { selectPipeline } from "../../src/pipeline.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { unitKeyOf } from "./evidence.ts";
import { createObserverKind } from "./index.ts";
import { resolveObserverOptions } from "./options.ts";
import { BENCH_HINT, EDIT_PROMPT_FILE } from "./pr-proposal.ts";
import { parseFindingMarker, renderFindingMarker, renderUnitsMarker } from "./proposals.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-11-25T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

const saved: Record<string, string | undefined> = {};
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "phoebe-observer-pr-"));
  const globalConfig = join(root, "gitconfig");
  writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n");
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: "Phoebe",
    GIT_AUTHOR_EMAIL: "phoebe@example.com",
    GIT_COMMITTER_NAME: "Phoebe",
    GIT_COMMITTER_EMAIL: "phoebe@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const LOCK = JSON.stringify({
  version: 2,
  skills: {
    tdd: {
      source: "acme/skills",
      sourceType: "github",
      ref: "v1",
      skillPath: "skills/tdd/SKILL.md",
      computedHash: "abc",
    },
  },
});

const ORIGIN_FILES: Record<string, string> = {
  "AGENTS.md": "# AGENTS.md\n\nRun `npm test`.\n",
  "prompts/issues-prompt.md": "# Issues\n\nDo the work.\n",
  "skills-lock.json": `${LOCK}\n`,
  ".agents/skills/tdd/SKILL.md": "# tdd\n",
  ".agents/skills/release/SKILL.md": "# release\n",
  "src/index.ts": "export {};\n",
};

const GOVERNING_CONFIG = 'export default { installCommand: "npm ci" };\n';

/** An origin with the files above, the hub clone, and a runtime root with the live config. */
function fixture() {
  const base = mkdtempSync(join(root, "fx-"));
  const seed = join(base, "seed");
  const origin = join(base, "origin.git");
  const dataBase = join(base, "data");
  const runtimeRoot = join(base, "runtime");
  mkdirSync(seed);
  git(seed, ["init", "--quiet", "-b", "main"]);
  write(seed, ORIGIN_FILES);
  git(seed, ["add", "--all"]);
  git(seed, ["commit", "--quiet", "-m", "init"]);
  git(base, ["clone", "--quiet", "--bare", seed, origin]);
  const repoDir = join(dataBase, "acme/widget/repo");
  mkdirSync(dirname(repoDir), { recursive: true });
  git(base, ["clone", "--quiet", origin, repoDir]);
  write(runtimeRoot, {
    "phoebe.config.ts": GOVERNING_CONFIG,
    // Tracked at the same path in origin, so never seeded.
    "prompts/issues-prompt.md": "# Issues\n\nDo the work.\n",
  });
  return { origin, dataBase, runtimeRoot, repoDir };
}

function unitRecord(id: string, days: number): UnitRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    unit: { kind: "issues", id },
    outcome: "failed",
    quarantined: false,
    detail: `pnpm install failed for ${id}`,
    startedAt: daysAgo(days),
    settledAt: daysAgo(days),
    durationMs: 1_000,
    runBudgetMs: 3_600_000,
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: null,
    branch: null,
    headSha: null,
    prNumber: null,
    engineCommit: null,
    agentRuns: [],
  };
}

const RECORDS = ["issue:1", "issue:2", "issue:3", "issue:4", "issue:5", "issue:6"].map((id, i) =>
  unitRecord(id, 6 - i),
);

type FindingSpec = { category: string; target: string; title: string; units: string[] };

/** What the fake edit run does to the tree for a finding, keyed by its target. */
type Edits = Record<string, Record<string, string>>;

function harness(opts: {
  findings: FindingSpec[];
  edits?: Edits;
  options?: Record<string, unknown>;
  prProposals?: MentioningPr[];
  prComments?: Record<number, string[]>;
}) {
  const fx = fixture();
  const scratch = mkdtempSync(join(root, "scratch-"));
  const config = selectPipeline(
    resolveConfig(
      {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: "npm ci",
        checkCommand: "npm run check",
        testCommand: "npm test",
        defaultProvider: "claude",
        pipelines: {
          intake: { kinds: { triage: { path: "./triage.ts" } } },
          observe: { kinds: { observer: { path: "phoebe-agent/kinds/observer" } } },
        },
      },
      { dataBase: fx.dataBase },
    ),
    "observe",
  );
  const logged: string[] = [];
  const issues: Array<{ number: number; title: string; body: string }> = [];
  const prs: Array<{ number: number; head: string; base: string; title: string; body: string }> =
    [];
  const labels: Array<{ target: string; label: string }> = [];
  const comments: Array<{ target: UnitTarget; body: string }> = [];
  const agentCalls: Array<{ promptFile: string | undefined; args: Record<string, string> }> = [];
  let nextIssue = 41;
  let nextPr = 57;
  const github = stubGitHub({
    listIssuesMentioning: () => [],
    listPrsMentioning: () => opts.prProposals ?? [],
    prCommentBodies: (n) => opts.prComments?.[n] ?? [],
    createIssue: (issue) => {
      const number = nextIssue++;
      issues.push({ number, ...issue });
      return number;
    },
    addIssueLabel: (number, label) => {
      labels.push({ target: `issue #${number}`, label });
    },
    addUnitLabel: (target, label) => {
      labels.push({ target: `${target.objectType} #${target.id}`, label });
    },
    postUnitComment: (target, body) => {
      comments.push({ target, body });
    },
    createPullRequest: (pr) => {
      const number = nextPr++;
      prs.push({ number, ...pr });
      return number as never;
    },
  }).forCycle() as unknown as WorkKindRunCtx["github"];

  const ctx: WorkKindRunCtx = {
    kind: "observer",
    config,
    options: undefined,
    env: {},
    github,
    origin: {
      fetch: () => {
        git(fx.repoDir, ["fetch", "--quiet", "--prune", "origin"]);
      },
      branchHead: () => {
        throw new Error("unused");
      },
      commitsBehind: () => 0,
    },
    cycle: {
      issueBody: () => null,
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: () => null,
    },
    clock: { now: () => NOW, sleep: async () => {} },
    inFlight: new Set(),
    quarantined: new Set(),
    log: (line) => logged.push(line),
    workspace: { mode: "readonly", dir: scratch, scratch },
    signal: new AbortController().signal,
    agent: {
      run: async (runOpts) => {
        const args = runOpts?.promptArgs ?? {};
        agentCalls.push({ promptFile: runOpts?.promptFile, args });
        if (runOpts?.promptFile === EDIT_PROMPT_FILE) {
          write(runOpts.worktreeDir!, opts.edits?.[args["FINDING_TARGET"]!] ?? {});
          return;
        }
        const flagged = JSON.parse(readFileSync(args["FLAGGED_JSON"]!, "utf8")) as Array<{
          id: string;
          ref: string;
        }>;
        const idOf = (ref: string) => flagged.find((unit) => unit.ref === ref)!.id;
        writeFileSync(
          args["FINDINGS_JSON"]!,
          JSON.stringify({
            findings: opts.findings.map((f) => ({ ...f, units: f.units.map(idOf) })),
          }),
        );
      },
      prWorkflow: async () => {
        throw new Error("unused");
      },
      issueWorkflow: async () => {
        throw new Error("unused");
      },
      cleanMerge: () => "failed",
    },
  };
  const kind = createObserverKind(
    config,
    resolveObserverOptions(opts.options ?? {}, "kinds.observer"),
    {
      readHistory: (dir) => (basename(dir) === "intake" ? RECORDS : []),
      runtimeRoot: fx.runtimeRoot,
    },
  );
  return {
    run: () => kind.run({ ref: "observer", revision: "never" }, ctx),
    fx,
    logged,
    issues,
    prs,
    labels,
    comments,
    agentCalls,
    /** The paths a pushed branch changes against main, on origin. */
    changedOn: (branch: string) =>
      git(fx.origin, ["diff", "--name-only", "main", branch]).trim().split("\n"),
    branches: () =>
      git(fx.origin, ["branch", "--format=%(refname:short)"])
        .trim()
        .split("\n")
        .filter((name) => name !== "main"),
  };
}

const THREE: FindingSpec[] = [
  {
    category: "convention",
    target: "AGENTS.md",
    title: "Agents never learn the install command",
    units: ["issue:1", "issue:2", "issue:3"],
  },
  {
    category: "factory",
    target: "prompts/issues-prompt.md",
    title: "The issues prompt skips the install step",
    units: ["issue:4", "issue:5"],
  },
  {
    category: "convention",
    target: "release",
    title: "The release skill omits the changeset",
    units: ["issue:6"],
  },
];

const THREE_EDITS: Edits = {
  "AGENTS.md": { "AGENTS.md": "# AGENTS.md\n\nRun `npm test`.\nInstall with `pnpm i`.\n" },
  "prompts/issues-prompt.md": {
    "prompts/issues-prompt.md": "# Issues\n\nInstall first, then do the work.\n",
  },
  release: { ".agents/skills/release/SKILL.md": "# release\n\nWrite a changeset.\n" },
};

describe("PR mode", () => {
  test("three convention and factory findings open three PRs over four agent runs", async () => {
    const h = harness({ findings: THREE, edits: THREE_EDITS });
    const result = await h.run();

    expect(h.agentCalls).toHaveLength(4);
    expect(h.agentCalls.slice(1).every((call) => call.promptFile === EDIT_PROMPT_FILE)).toBe(true);
    expect(h.issues).toEqual([]);
    expect(h.prs.map((pr) => [pr.number, pr.title, pr.base])).toEqual([
      [57, "Observer: Agents never learn the install command", "main"],
      [58, "Observer: The issues prompt skips the install step", "main"],
      [59, "Observer: The release skill omits the changeset", "main"],
    ]);
    expect(h.changedOn(h.prs[0]!.head)).toEqual(["AGENTS.md"]);
    expect(h.changedOn(h.prs[1]!.head)).toEqual(["prompts/issues-prompt.md"]);
    expect(h.changedOn(h.prs[2]!.head)).toEqual([".agents/skills/release/SKILL.md"]);
    for (const pr of h.prs) expect(pr.head).toMatch(/^phoebe\/observer\//);
    expect(parseFindingMarker(h.prs[0]!.body)).toBe("convention:AGENTS.md");
    expect(h.prs[0]!.body).toContain("A person reviews it");
    expect(h.labels).toEqual([
      { target: "pr #57", label: "phoebe:observer" },
      { target: "pr #58", label: "phoebe:observer" },
      { target: "pr #59", label: "phoebe:observer" },
    ]);
    expect(h.labels.some((entry) => entry.label === "ready-for-agent")).toBe(false);
    // Only the PR that edits a prompt suggests a bench, and nothing adds the label.
    expect(h.prs.map((pr) => pr.body.includes(BENCH_HINT))).toEqual([false, true, false]);
    expect(h.prs[1]!.body).toContain("add the `phoebe:bench` label");
    expect(h.labels.some((entry) => entry.label === "phoebe:bench")).toBe(false);
    expect(result).toEqual({
      summary: "3 proposals filed (#57, #58, #59); coverage work none, intake 6d",
    });
    // The edit worktrees are gone from the hub.
    expect(git(h.fx.repoDir, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
  });

  test("an edit that strays outside the allowlist is an issue, and nothing is pushed", async () => {
    const h = harness({
      findings: [THREE[0]!],
      edits: {
        "AGENTS.md": {
          "AGENTS.md": "# AGENTS.md\n\nInstall with `pnpm i`.\n",
          "src/index.ts": "export const x = 1;\n",
        },
      },
    });
    await h.run();
    expect(h.prs).toEqual([]);
    expect(h.branches()).toEqual([]);
    expect(h.issues).toHaveLength(1);
    const body = h.issues[0]!.body;
    expect(parseFindingMarker(body)).toBe("convention:AGENTS.md");
    expect(body).toContain("## Why this is an issue and not a PR");
    expect(body).toContain("Outside the allowlist:\n\n- `src/index.ts`");
    expect(body).toContain("- `AGENTS.md`");
    expect(h.labels).toEqual([{ target: "issue #41", label: "phoebe:observer" }]);
    expect(h.logged).toContain(
      "convention:AGENTS.md: filed #41 as an issue: the edit run changed paths outside the allowlist.",
    );
  });

  test("an edit to a vendored skill is an issue, not a PR", async () => {
    const h = harness({
      findings: [{ ...THREE[2]!, target: "tdd" }],
      edits: { tdd: { ".agents/skills/tdd/SKILL.md": "# tdd\n\nchanged\n" } },
    });
    await h.run();
    expect(h.prs).toEqual([]);
    expect(h.branches()).toEqual([]);
    expect(h.issues[0]!.body).toContain(
      "Outside the allowlist:\n\n- `.agents/skills/tdd/SKILL.md`",
    );
  });

  test("a factory fix to a config the repository does not track is an issue carrying the diff", async () => {
    const h = harness({
      findings: [
        {
          category: "factory",
          target: "phoebe.config.ts",
          title: "Installs need a frozen lockfile",
          units: ["issue:1", "issue:2"],
        },
      ],
      edits: {
        "phoebe.config.ts": {
          "phoebe.config.ts": 'export default { installCommand: "npm ci --prefer-offline" };\n',
        },
      },
    });
    await h.run();
    // The edit run was handed the live config to change, not a blank file.
    expect(h.agentCalls[1]!.args["SEEDED_PATHS"]).toBe("`phoebe.config.ts`");
    expect(h.prs).toEqual([]);
    expect(h.branches()).toEqual([]);
    const body = h.issues[0]!.body;
    expect(body).toContain("does not track at these paths");
    expect(body).toContain("```diff\n");
    expect(body).toContain('-export default { installCommand: "npm ci" };');
    expect(body).toContain('+export default { installCommand: "npm ci --prefer-offline" };');
  });

  test("an edit run that changes nothing is an issue", async () => {
    const h = harness({ findings: [THREE[0]!], edits: {} });
    await h.run();
    expect(h.prs).toEqual([]);
    expect(h.issues[0]!.body).toContain("changed nothing");
  });

  test("ticket and engine findings stay issues with no edit run", async () => {
    const h = harness({
      findings: [
        { category: "ticket", target: "acceptance-criteria", title: "T", units: ["issue:1"] },
        { category: "engine", target: "worktree-cleanup", title: "E", units: ["issue:2"] },
      ],
    });
    await h.run();
    expect(h.agentCalls).toHaveLength(1);
    expect(h.prs).toEqual([]);
    expect(h.issues.map((issue) => issue.title)).toEqual(["Observer: T", "Observer: E"]);
  });

  test("issue mode files a convention finding as an issue with no edit run", async () => {
    const h = harness({ findings: [THREE[0]!], edits: THREE_EDITS, options: { mode: "issues" } });
    await h.run();
    expect(h.agentCalls).toHaveLength(1);
    expect(h.prs).toEqual([]);
    expect(h.issues).toHaveLength(1);
  });

  test("new evidence for an open PR proposal is a comment on the PR", async () => {
    const listed = unitKeyOf("intake", RECORDS[0]!);
    const h = harness({
      findings: [THREE[0]!],
      edits: THREE_EDITS,
      prProposals: [
        {
          number: 50,
          body: `${renderFindingMarker("convention:AGENTS.md")}\n${renderUnitsMarker([listed])}`,
          state: "open",
          merged: false,
          closedAt: null,
        },
      ],
      prComments: { 50: [] },
    });
    expect(await h.run()).toEqual({
      summary: "1 folded into #50; coverage work none, intake 6d",
    });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]!.target).toEqual({ objectType: "pr", id: 50 });
    expect(h.comments[0]!.body).toContain("in 2 more unit(s):");
  });

  test("a merged PR proposal is filed again as a regression; one closed unmerged keeps quiet", async () => {
    const h = harness({
      findings: THREE.slice(0, 2),
      edits: THREE_EDITS,
      prProposals: [
        {
          number: 50,
          body: renderFindingMarker("convention:AGENTS.md"),
          state: "closed",
          merged: true,
          closedAt: daysAgo(4.5),
        },
        {
          number: 51,
          body: renderFindingMarker("factory:prompts/issues-prompt.md"),
          state: "closed",
          merged: false,
          closedAt: daysAgo(20),
        },
      ],
    });
    expect(await h.run()).toEqual({
      summary: "1 proposal filed (#57), 1 skipped; coverage work none, intake 6d",
    });
    expect(h.prs[0]!.body).toContain("**Regression of #50.**");
    expect(h.logged).toContain(
      "factory:prompts/issues-prompt.md: skipped, turned down within 90 days (#51).",
    );
  });
});
