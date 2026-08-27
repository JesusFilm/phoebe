// Reference illustration — custom work kinds (issue #303).
//
// A solo-shaped config whose point is the `workKinds.custom` block: it
// declares one full-form kind loaded from a module in the repo
// (kinds/stale-pr-nudger.ts) and one prompt-only producer written inline
// below. Both implement the same contract as the five built-ins; after boot
// the engine treats all of them identically — `workOrder`, per-kind
// `workKinds` tuning blocks, `PHOEBE_<KIND>_*` env vars (hyphens become
// underscores: PHOEBE_STALE_PR_NUDGER_MODEL), quarantine, and the prompt
// existence check included.
//
// The examples convention (#115) holds: type-only imports from the published
// `phoebe-agent` specifier, never a value import — configs and kind modules
// load from a container mount where no `node_modules` is reachable.

import type { Issue, PhoebeUserConfig, WorkKindDefinition } from "phoebe-agent";

// --- The cheap case, inline: a prompt-only issue producer. -------------------
// A new issue-keyed producer is a label, a prompt file, and one
// `ctx.agent.issueWorkflow` call — the same skeleton the built-in `issues` and
// `research` kinds run on. Inline definitions close over any values they need
// (no `options`; that is the `{ module, options }` wrapper's job).

const DOCS_LABEL = "docs-wanted";

type DocsRequest = {
  ref: string;
  github: { objectType: "issue"; id: number };
  issue: Issue;
};

const docsRequestKind = {
  name: "docs-request",
  oneShotEligible: true,
  promptFile: "prompts/docs-request-prompt.md",
  workspace: "worktree",
  report: {
    noun: `${DOCS_LABEL} issue(s)`,
    describe: (unit) => `docs request #${unit.issue.number}`,
  },
  async fetch(ctx) {
    const issues = ctx.github.listLabeledIssues(DOCS_LABEL);
    // Contribute to the engine's blocker index so `blocked by #N` references
    // in these issues are respected across kinds.
    ctx.cycle.registerIssues(issues);
    return issues;
  },
  select(issues) {
    const pick = issues[0] ?? null;
    return {
      unit: pick
        ? {
            ref: `issue:${pick.number}`,
            github: { objectType: "issue", id: pick.number },
            issue: pick,
          }
        : null,
      skipped: [],
      total: issues.length,
    };
  },
  async run(unit, ctx) {
    await ctx.agent.issueWorkflow({
      issueNumber: unit.issue.number,
      issueTitle: unit.issue.title,
      worktreeBase: `origin/${ctx.config.defaultBranch}`,
      stacked: false,
    });
  },
} satisfies WorkKindDefinition<Issue[], DocsRequest>;

// --- The config. -------------------------------------------------------------

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",

  engine: { source: "github", ref: "v0.1.0" },

  // Custom kinds run only when scheduled — order them among the built-ins.
  workOrder: ["conflicts", "issues", "stale-pr-nudger", "docs-request"],

  workKinds: {
    custom: {
      // Full form: a module in this repo (path relative to this config file's
      // directory), plus tenant knobs the kind reads back as `ctx.options`.
      "stale-pr-nudger": { module: "./kinds/stale-pr-nudger.ts", options: { staleDays: 7 } },
      // Cheap case: the inline definition above. A bare path string also
      // works when there are no knobs: `"docs-request": "./kinds/docs.ts"`.
      "docs-request": docsRequestKind,
    },
    // Custom kinds are tuned exactly like built-ins.
    "stale-pr-nudger": { effort: "low" },
  },
};

export default config;
