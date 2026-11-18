// The GitHub calls the `skill-updates` kind makes (#877), behind one seam so
// the kind is testable without `gh`. Every PR the kind opens sits on a stable
// branch per source, so listing the PRs on that branch is the whole record:
// the open one to refresh, and the closed ones that veto a ref.

import { createGhExecutor, type GhExecutor } from "../../src/github-client.ts";
import { addUnitLabelCreatingIfMissing } from "../../src/labels.ts";
import { asPrNumber } from "../../src/branded.ts";
import type { WorkKindCtx } from "../../src/work-kinds/definition.ts";
import type { SourcePr } from "./plan.ts";

export type SkillPrs = {
  /** Every PR, open or not, whose head is `branch`, newest first. */
  list(branch: string): SourcePr[];
  comments(pr: number): string[];
  create(opts: {
    branch: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): number;
  edit(pr: number, opts: { title: string; body: string }): void;
  markDraft(pr: number): void;
  comment(pr: number, body: string): void;
  addLabel(pr: number, label: string): void;
};

type PrRow = { number: number; state: string; body: string | null; isDraft: boolean };

const PR_URL_RE = /\/pull\/(\d+)/;

/** The real seam: `gh` with the kind's env, against the tenant's repository. */
export function ghSkillPrs(ctx: Pick<WorkKindCtx, "config" | "env" | "github" | "log">): SkillPrs {
  const exec: GhExecutor = createGhExecutor({ ...ctx.env });
  const repo = ["-R", ctx.config.repoSlug];
  return {
    list: (branch) => {
      const rows = JSON.parse(
        exec([
          "pr",
          "list",
          ...repo,
          "--head",
          branch,
          "--state",
          "all",
          "--limit",
          "100",
          "--json",
          "number,state,body,isDraft",
        ]),
      ) as PrRow[];
      return rows.map((row) => ({
        number: row.number,
        state: row.state === "OPEN" ? "open" : row.state === "MERGED" ? "merged" : "closed",
        body: row.body ?? "",
        isDraft: row.isDraft,
      }));
    },
    comments: (pr) => ctx.github.prCommentBodies(asPrNumber(pr)),
    create: (opts) => {
      const out = exec(
        [
          "pr",
          "create",
          ...repo,
          "--head",
          opts.branch,
          "--base",
          opts.base,
          "--title",
          opts.title,
          "--body-file",
          "-",
          ...(opts.draft ? ["--draft"] : []),
        ],
        { input: opts.body },
      );
      const match = PR_URL_RE.exec(out);
      if (match === null) throw new Error(`gh pr create printed no PR URL: ${out.trim()}`);
      return Number(match[1]);
    },
    edit: (pr, opts) => {
      exec(["pr", "edit", String(pr), ...repo, "--title", opts.title, "--body-file", "-"], {
        input: opts.body,
      });
    },
    markDraft: (pr) => {
      exec(["pr", "ready", String(pr), ...repo, "--undo"]);
    },
    comment: (pr, body) => {
      exec(["pr", "comment", String(pr), ...repo, "--body-file", "-"], { input: body });
    },
    addLabel: (pr, label) => {
      addUnitLabelCreatingIfMissing(
        ctx.github,
        { objectType: "pr", id: pr },
        { name: label, description: "Added by the skill-updates kind" },
        ctx.log,
      );
    },
  };
}
