// PR mode's git half (#936, spec #924): one edit run per proposal in a fresh
// worktree, then code reads the diff, checks it against the allowlist, and
// either pushes a branch and opens the PR or hands back what the issue the
// proposal becomes should say.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { SKILL_LOCK_FILE } from "../../src/skill-lock.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { git, originSha } from "../skill-updates/upstream.ts";
import type { EditAttemptNote } from "./body.ts";
import {
  ALLOWLIST_TEXT,
  checkEdit,
  GOVERNING_CONFIG,
  PROMPTS_DIR,
  vendoredSkills,
} from "./edit.ts";
import { CATEGORY_TEXT, type Finding } from "./findings.ts";

/** The edit run's prompt, an absolute path into the engine checkout. */
export const EDIT_PROMPT_FILE = join(import.meta.dirname, "edit-prompt.md");

export type EditOutcome =
  | { action: "pr"; number: number; branch: string }
  | { action: "issue"; attempt: EditAttemptNote };

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

function tracked(tree: string, commit: string, path: string): boolean {
  try {
    git(["cat-file", "-e", `${commit}:${path}`], tree);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the governing config and prompts from the runtime root into the tree,
 * at the paths a repository would track them, wherever it does not. The edit
 * run then changes the live files rather than writing new ones from nothing,
 * and the diff an issue carries applies where they live.
 */
function seedGoverningFiles(tree: string, base: string, runtimeRoot: string): string[] {
  const candidates = [
    GOVERNING_CONFIG,
    ...filesUnder(join(runtimeRoot, PROMPTS_DIR)).map((file) => `${PROMPTS_DIR}/${file}`),
  ];
  const seeded: string[] = [];
  for (const path of candidates) {
    const source = join(runtimeRoot, path);
    if (!existsSync(source) || tracked(tree, base, path) || existsSync(join(tree, path))) continue;
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    cpSync(source, join(tree, path));
    seeded.push(path);
  }
  return seeded;
}

function findingText(finding: Finding): string {
  return [
    `# ${finding.title}`,
    "",
    `Category: ${CATEGORY_TEXT[finding.category]}`,
    `Target: ${finding.target}`,
    "",
    "## What keeps going wrong",
    "",
    finding.problem === "" ? finding.title : finding.problem,
    "",
    "## Suggested fix",
    "",
    finding.fix === "" ? "(none given)" : finding.fix,
    "",
  ].join("\n");
}

/**
 * Make one proposal's edit and turn it into a PR or an issue's account of the
 * attempt. The worktree is detached at the default branch and always removed.
 */
export async function proposeByPr(opts: {
  ctx: WorkKindRunCtx;
  finding: Finding;
  /** Unique within the run: names the worktree and the finding file. */
  slot: number;
  branch: string;
  title: string;
  body: string;
  runtimeRoot: string;
  /** Renders the evidence the edit run reads beside the finding. */
  evidence: string;
}): Promise<EditOutcome> {
  const { ctx, finding } = opts;
  const repoDir = ctx.config.paths.repoDir;
  const defaultBranch = ctx.config.defaultBranch;
  const scratch = ctx.workspace.scratch;
  const tree = join(scratch, `edit-${opts.slot}`);
  ctx.origin.fetch();
  git(["worktree", "add", "--quiet", "--detach", tree, `origin/${defaultBranch}`], repoDir);
  try {
    const base = git(["rev-parse", "HEAD"], tree).trim();
    const seeded = seedGoverningFiles(tree, base, opts.runtimeRoot);
    if (seeded.length > 0) {
      git(["add", "--force", "--", ...seeded], tree);
      git(["commit", "--quiet", "--no-verify", "-m", "observer: governing files, untracked"], tree);
    }
    const start = git(["rev-parse", "HEAD"], tree).trim();

    let lockText: string | null = null;
    try {
      lockText = git(["show", `${base}:${SKILL_LOCK_FILE}`], tree);
    } catch {
      lockText = null;
    }
    const vendored = vendoredSkills(lockText);

    const findingFile = join(scratch, `finding-${opts.slot}.md`);
    writeFileSync(findingFile, `${findingText(finding)}\n## Evidence\n\n${opts.evidence}\n`);
    await ctx.agent.run({
      worktreeDir: tree,
      promptFile: EDIT_PROMPT_FILE,
      promptArgs: {
        FINDING_FILE: findingFile,
        FINDING_CATEGORY: finding.category,
        FINDING_TARGET: finding.target,
        ALLOWED_PATHS: ALLOWLIST_TEXT.map((line) => `- ${line}`).join("\n"),
        VENDORED_SKILLS:
          vendored === null
            ? `every skill under the skills directory, because \`${SKILL_LOCK_FILE}\` does not parse`
            : vendored.size === 0
              ? "(none)"
              : [...vendored].map((name) => `\`${name}\``).join(", "),
        SEEDED_PATHS:
          seeded.length === 0 ? "(none)" : seeded.map((path) => `\`${path}\``).join(", "),
      },
    });

    // Whatever the run committed becomes changes over `start`, read whole.
    git(["reset", "--quiet", "--soft", start], tree);
    git(["add", "--all"], tree);
    const changed = git(["diff", "--cached", "--name-only", "--no-renames", "-z", start], tree)
      .split("\0")
      .filter((path) => path !== "");
    const verdict = checkEdit(changed, {
      vendored,
      tracked: (path) => tracked(tree, base, path),
    });
    if (verdict.action === "issue") {
      if (verdict.reason === "empty") return { action: "issue", attempt: { reason: "empty" } };
      if (verdict.reason === "outside") {
        return {
          action: "issue",
          attempt: { reason: "outside", changed: verdict.changed, outside: verdict.outside },
        };
      }
      const diff = git(["diff", "--cached", "--no-renames", start], tree);
      return {
        action: "issue",
        attempt: { reason: "untracked", untracked: verdict.untracked, diff },
      };
    }

    // The PR carries the edit alone: back onto the base, the seeds unstaged.
    git(["reset", "--quiet", "--soft", base], tree);
    if (seeded.length > 0) git(["reset", "--quiet", "--", ...seeded], tree);
    git(["commit", "--quiet", "--no-verify", "-m", `Phoebe: ${opts.title}`], tree);
    ctx.origin.fetch();
    const expected = originSha(repoDir, opts.branch) ?? "";
    git(
      [
        "push",
        "--quiet",
        `--force-with-lease=refs/heads/${opts.branch}:${expected}`,
        "origin",
        `HEAD:refs/heads/${opts.branch}`,
      ],
      tree,
    );
    const number = ctx.github.createPullRequest({
      head: opts.branch,
      base: defaultBranch,
      title: opts.title,
      body: opts.body,
    });
    return { action: "pr", number, branch: opts.branch };
  } finally {
    try {
      git(["worktree", "remove", "--force", tree], repoDir);
    } catch {
      rmSync(tree, { recursive: true, force: true });
      git(["worktree", "prune"], repoDir);
    }
  }
}
