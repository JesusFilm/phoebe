// Reference custom work kind — the full form (issue #303).
//
// Nudges stale PRs: any open in-scope PR whose review threads have been silent
// for `staleDays` (default 7) gets one agent-posted comment asking for a
// human decision. The comment ends with an HTML marker, and fetch skips PRs
// already carrying it — the thread itself is the state store (the house
// watermark pattern), so Phoebe needs no database and a restart loses nothing.
//
// Two conventions to copy (see ../README.md for why they are load-bearing):
//
//   • Only TYPE imports from `phoebe-agent` — kind code can never value-import
//     the engine; every capability arrives on `ctx`.
//   • The default export may be a plain definition object or, as here, a
//     `(config) => definition` factory — the same shape the built-ins use —
//     so config values can be baked in at boot registration.

import type { PhoebeConfig, WorkKindDefinition } from "phoebe-agent";

/** The marker the nudge comment carries; its presence is the watermark. */
export const NUDGE_MARKER = "<!-- stale-pr-nudge -->";

const DAY_MS = 24 * 60 * 60 * 1000;

type StalePr = {
  /** Stable per-kind unit identity; nothing ever parses it. */
  ref: string;
  /** The engine's timeout/quarantine escalation target. */
  github: { objectType: "pr"; id: number };
  prNumber: number;
  branch: string;
  /** Newest review-thread comment, or null when the threads are empty. */
  lastActivityAt: string | null;
};

type Gathered = {
  stale: StalePr[];
  /** PRs turned away because a nudge comment already exists. */
  alreadyNudged: number;
};

export default function stalePrNudger(config: PhoebeConfig): WorkKindDefinition<Gathered, StalePr> {
  return {
    name: "stale-pr-nudger",
    oneShotEligible: false,
    promptFile: "prompts/stale-pr-nudge-prompt.md",
    // This kind posts one comment and never touches a file, let alone a
    // branch: `"scratch"` (#358) hands `run` an empty directory instead of a
    // checkout. The cost is that `gh` can no longer infer the repo from a
    // remote, so the prompt names it — see `REPO_SLUG` in `run`.
    workspace: "scratch",
    report: {
      noun: "stale PR(s)",
      describe: (unit) => `stale-PR nudge for PR #${unit.prNumber} (${unit.branch})`,
    },
    async fetch(ctx) {
      // `ctx.options` is whatever the config's `{ module, options }` wrapper
      // declared — opaque to the engine, validated by the kind.
      const options = (ctx.options ?? {}) as { staleDays?: number };
      const staleDays = options.staleDays ?? 7;
      const cutoff = ctx.clock.now().getTime() - staleDays * DAY_MS;

      const stale: StalePr[] = [];
      let alreadyNudged = 0;
      for (const pr of ctx.github.openPrs()) {
        // Per-unit failures are absorbed (warn, drop); a thrown fetch would
        // kill the whole cycle — the same failure contract as every kind.
        try {
          let newest: string | null = null;
          for (const thread of ctx.github.reviewThreads(pr.number)) {
            for (const comment of thread.comments) {
              if (newest === null || comment.createdAt > newest) newest = comment.createdAt;
            }
          }
          if (newest !== null && Date.parse(newest) >= cutoff) continue; // recently active
          if (ctx.github.prCommentBodies(pr.number).some((body) => body.includes(NUDGE_MARKER))) {
            alreadyNudged++;
            continue;
          }
          stale.push({
            ref: `pr:${pr.number}`,
            github: { objectType: "pr", id: Number(pr.number) },
            prNumber: Number(pr.number),
            branch: pr.headRefName,
            lastActivityAt: newest,
          });
        } catch (error) {
          console.warn(
            `[phoebe] Skipping PR #${pr.number} for stale-pr-nudger this cycle — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { stale, alreadyNudged };
    },
    select(gathered) {
      // Oldest PR first; the skip reason is a free string, rendered verbatim
      // in the idle report as "N stale PR(s) skipped (already nudged)".
      const unit = [...gathered.stale].sort((a, b) => a.prNumber - b.prNumber)[0] ?? null;
      return {
        unit,
        skipped:
          gathered.alreadyNudged > 0
            ? [{ reason: "already nudged", count: gathered.alreadyNudged }]
            : [],
        total: gathered.stale.length + gathered.alreadyNudged,
      };
    },
    async run(unit, ctx) {
      ctx.log(`Nudging PR #${unit.prNumber} (${unit.branch}).`);
      // The bare agent helper: provider ladder, prompt render, env allowlist,
      // and the run deadline are engine-fixed; the prompt (this kind's
      // `promptFile`) tells the agent to post the nudge comment — ending with
      // NUDGE_MARKER — via `gh`. Default cwd is the prepared workspace
      // (`ctx.workspace.dir`) — here an empty directory, created only because
      // this line reads it.
      await ctx.agent.run({
        promptArgs: {
          PR_NUMBER: String(unit.prNumber),
          PR_BRANCH: unit.branch,
          // A factory can bake resolved-config values in like this.
          DEFAULT_BRANCH: config.defaultBranch,
          // Every `gh` call in the prompt needs `-R` under a scratch
          // workspace: there is no remote to infer the repo from.
          REPO_SLUG: config.repoSlug,
          LAST_ACTIVITY_AT: unit.lastActivityAt ?? "unknown",
          NUDGE_MARKER,
        },
      });
    },
  };
}
