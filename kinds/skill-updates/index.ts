// The `skill-updates` catalog kind (#877, ADR 0004): it keeps the skills a
// repository vendors under `skills-lock.json` in step with upstream, one PR per
// source. It is one kind rather than the dependency feature's detector and
// worker: the PR is where a person reviews a skill bump, so an issue first
// would be a second place to say the same thing.
//
// It ships in the engine and registers only when a tenant declares it
// (`path: "phoebe-agent/kinds/skill-updates"`), so it may value-import engine
// helpers where a tenant module could not.
//
// Shape:
//   - `fetch` scans once per `every` window, kept in memory like the
//     dependency detectors. A scan reads the lock off the default branch,
//     works out each source's next ref with `git ls-remote` (or a treeless
//     clone, for a SHA-pinned source), reads the PRs on the source's branch,
//     and yields one unit per source with something to do. Units not yet run
//     wait in memory until the next scan replaces them;
//   - `run` syncs in the engine (./sync.ts), runs the agent pass over the
//     result, puts back anything it changed under a vendored path, checks the
//     hashes, force-pushes the source's branch and opens or rewrites its PR;
//   - the record is GitHub: the PRs on a source's branch. An open one is the
//     PR to refresh, and one closed unmerged vetoes the ref its marker names.
//
// The kind never merges. Vendored skills are instructions every agent in the
// repo follows, so a person reads every bump.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhoebeConfig } from "../../src/config-schema.ts";
import { parseSkillLock } from "../../src/skill-lock.ts";
import {
  defineWorkKind,
  type WorkKindCtx,
  type WorkKindDefinition,
  type WorkKindRunCtx,
  type WorkUnitGitHubTarget,
} from "../../src/work-kinds/definition.ts";
import { prTitle, renderBody, renderNewerComment, shortRef } from "./body.ts";
import { everyMs, resolveSkillUpdatesOptions, type SkillUpdatesOptions } from "./options.ts";
import {
  decide,
  groupSources,
  matureCommit,
  nextTag,
  sourceBranch,
  vetoedRefs,
  type SkillSource,
  type SourcePr,
} from "./plan.ts";
import { ghSkillPrs, type SkillPrs } from "./prs.ts";
import { hashMismatches, protectedPaths, syncSource } from "./sync.ts";
import {
  branchLog,
  checkoutUpstream,
  defaultSourceUrl,
  git,
  hasForeignCommits,
  listTags,
  originSha,
} from "./upstream.ts";

export const SKILL_UPDATES_KIND_NAME = "skill-updates";

/** The kind's own prompt, an absolute path into the engine checkout. */
export const SKILL_UPDATES_PROMPT_FILE = join(
  import.meta.dirname,
  "..",
  "..",
  "prompts",
  "skill-updates-prompt.md",
);

/** One source with something to do: open its PR, refresh it, or say a newer ref is out. */
export type SkillUnit = {
  ref: string;
  revision: string;
  github?: WorkUnitGitHubTarget;
  action: "open" | "refresh" | "notify";
  source: string;
  url: string;
  branch: string;
  /** The ref the lock is on: a tag, or a commit for a SHA-pinned source. */
  from: string;
  /** The ref proposed: a tag, or a commit. */
  to: string;
  /** Whether `to` is a tag. */
  tag: boolean;
  lockedCommit: string | null;
  pr: SourcePr | null;
};

export type SkillUpdatesGathered = { units: SkillUnit[] };

/** Test seams: the GitHub calls and where a source is cloned from. */
export type SkillUpdatesDeps = {
  prs?: (ctx: WorkKindCtx) => SkillPrs;
  sourceUrl?: (source: string, sourceType: string | null) => string | null;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSkillUpdatesKind(
  options: SkillUpdatesOptions,
  deps: SkillUpdatesDeps = {},
): WorkKindDefinition<SkillUpdatesGathered, SkillUnit> {
  const makePrs = deps.prs ?? ghSkillPrs;
  const sourceUrl = deps.sourceUrl ?? defaultSourceUrl;
  const window = everyMs(options.every);
  const minAgeMs = everyMs(options.minAge);
  let lastScanAt: number | null = null;
  const pending = new Map<string, SkillUnit>();

  /** The units one source yields this scan: none, or one. */
  function planSource(
    entry: SkillSource,
    ctx: WorkKindCtx,
    prs: SkillPrs,
    scratch: string,
  ): SkillUnit | null {
    const { source } = entry;
    const url = sourceUrl(source, entry.sourceType);
    if (url === null) {
      ctx.log(
        `${source}: a ${entry.sourceType ?? "github"} source has no upstream to read; skipped.`,
      );
      return null;
    }
    const branch = sourceBranch(ctx.config.branchPrefix, source);
    const onBranch = prs.list(branch);
    const vetoed = vetoedRefs(onBranch, source);

    let proposal: string | null;
    let from: string;
    if (entry.pin.kind === "tag") {
      from = entry.pin.ref;
      proposal = nextTag(entry.pin.ref, listTags(url), vetoed);
    } else {
      from = entry.lockedCommit ?? "(no commit)";
      const log = branchLog(url, entry.pin.branch, join(scratch, "log"));
      proposal = matureCommit(log, entry.pin.commits, ctx.clock.now().getTime(), minAgeMs, vetoed);
    }
    if (proposal === null) {
      ctx.log(`${source}: nothing newer to propose from ${shortRef(from)}.`);
      return null;
    }

    const open = onBranch.find((pr) => pr.state === "open") ?? null;
    const foreign =
      open !== null &&
      hasForeignCommits(ctx.config.paths.repoDir, ctx.config.defaultBranch, branch);
    const decision = decide({
      source,
      proposal,
      open,
      foreign,
      comments: open !== null && foreign ? prs.comments(open.number) : [],
    });
    if (decision.action === "nothing") {
      ctx.log(`${source}: ${decision.reason}.`);
      return null;
    }
    const pr = decision.action === "open" ? null : decision.pr;
    ctx.log(
      `${source}: ${shortRef(from)} → ${shortRef(proposal)}; ` +
        (pr === null ? "opening a PR." : `${decision.action} PR #${pr.number}.`),
    );
    return {
      ref: `${SKILL_UPDATES_KIND_NAME}:${source}`,
      revision: proposal,
      ...(pr !== null ? { github: { objectType: "pr" as const, id: pr.number } } : {}),
      action: decision.action,
      source,
      url,
      branch,
      from,
      to: proposal,
      tag: entry.pin.kind === "tag",
      lockedCommit: entry.lockedCommit,
      pr,
    };
  }

  /** One scan: read the lock off the default branch and plan every source in it. */
  function scan(ctx: WorkKindCtx): SkillUnit[] {
    const repoDir = ctx.config.paths.repoDir;
    let text: string;
    try {
      text = git(["show", `origin/${ctx.config.defaultBranch}:${options.lockPath}`], repoDir);
    } catch {
      ctx.log(`no ${options.lockPath} on ${ctx.config.defaultBranch}; nothing to scan.`);
      return [];
    }
    let sources: SkillSource[];
    try {
      sources = groupSources(parseSkillLock(text, options.lockPath), options.ignore);
    } catch (error) {
      ctx.log(`${message(error)}. No skill PRs opened.`);
      return [];
    }

    const prs = makePrs(ctx);
    const scratch = mkdtempSync(join(tmpdir(), "phoebe-skill-scan-"));
    const units: SkillUnit[] = [];
    try {
      for (const [i, entry] of sources.entries()) {
        const dir = join(scratch, String(i));
        try {
          const unit = planSource(entry, ctx, prs, dir);
          if (unit !== null) units.push(unit);
        } catch (error) {
          ctx.log(`${entry.source}: scan failed; the other sources still run. ${message(error)}`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    return units;
  }

  /** Point out a newer ref on a PR someone else has pushed to. */
  function notify(unit: SkillUnit, pr: number, prs: SkillPrs, ctx: WorkKindRunCtx): void {
    prs.comment(pr, renderNewerComment(unit.source, unit.to));
    ctx.log(`PR #${pr} has commits from someone else; commented that ${shortRef(unit.to)} is out.`);
  }

  /** Sync, agent pass, revert, hash check, push, PR. */
  async function bump(
    unit: SkillUnit,
    ctx: WorkKindRunCtx,
    prs: SkillPrs,
    tree: string,
  ): Promise<void> {
    const { lockPath } = options;
    const scratch = ctx.workspace.scratch;
    const base = git(["rev-parse", "HEAD"], tree).trim();

    const upstream = checkoutUpstream({
      url: unit.url,
      target: unit.tag ? { tag: unit.to } : { commit: unit.to },
      lockedCommit: unit.lockedCommit,
      dir: join(scratch, "upstream"),
    });
    const report = syncSource({
      repoDir: tree,
      lockPath,
      source: unit.source,
      tag: unit.tag ? unit.to : null,
      ignore: options.ignore,
      upstream,
    });
    const guarded = protectedPaths(tree, lockPath);
    git(["add", "--all", "--", ...guarded.filter((p) => existsSync(join(tree, p)))], tree);
    if (git(["diff", "--cached", "--name-only"], tree).trim() === "") {
      ctx.log(`${unit.source}@${shortRef(unit.to)} changes nothing here; no PR.`);
      return;
    }
    commit(tree, `Phoebe: update ${unit.source} skills to ${shortRef(unit.to)}`);
    const synced = git(["rev-parse", "HEAD"], tree).trim();

    const diffFile = join(scratch, "upstream.diff");
    const summaryFile = join(scratch, "summary.md");
    const flagsFile = join(scratch, "flags.md");
    writeFileSync(diffFile, git(["diff", base, synced], tree));
    await ctx.agent.run({
      worktreeDir: tree,
      promptArgs: {
        SKILL_SOURCE: unit.source,
        FROM_REF: shortRef(unit.from),
        TO_REF: shortRef(unit.to),
        SYNCED_SKILLS: report.synced.map((s) => s.name).join(", ") || "(none)",
        RENAMED_SKILLS:
          report.synced
            .filter((s) => s.from !== null && s.from !== s.to)
            .map((s) => `${s.name}: ${s.from} → ${s.to}`)
            .join("; ") || "(none)",
        LOCK_PATH: lockPath,
        VENDORED_PATHS: guarded.join("\n"),
        DIFF_FILE: diffFile,
        SUMMARY_FILE: summaryFile,
        FLAGS_FILE: flagsFile,
      },
    });

    const reverted = revertGuarded(tree, synced, guarded);
    if (reverted.length > 0) {
      ctx.log(
        `put back ${reverted.length} vendored path(s) the agent changed: ${reverted.join(", ")}`,
      );
    }
    git(["add", "--all"], tree);
    if (git(["diff", "--cached", "--name-only", synced], tree).trim() !== "") {
      commit(tree, `Phoebe: fix references to the ${unit.source} skills`);
    }

    const mismatched = hashMismatches(
      tree,
      lockPath,
      report.synced.map((s) => s.name),
    );
    if (mismatched.length > 0) {
      throw new Error(
        `vendored skill(s) ${mismatched.join(", ")} do not match their lock hash after the sync; nothing pushed.`,
      );
    }

    ctx.origin.fetch();
    const repoDir = ctx.config.paths.repoDir;
    const open = prs.list(unit.branch).find((pr) => pr.state === "open") ?? null;
    if (open !== null && hasForeignCommits(repoDir, ctx.config.defaultBranch, unit.branch)) {
      notify(unit, open.number, prs, ctx);
      return;
    }
    const expected = originSha(repoDir, unit.branch) ?? "";
    git(
      [
        "push",
        "--quiet",
        `--force-with-lease=refs/heads/${unit.branch}:${expected}`,
        "origin",
        `HEAD:refs/heads/${unit.branch}`,
      ],
      tree,
    );

    const flags = readText(flagsFile);
    const title = prTitle(unit.source, unit.to);
    const body = renderBody({
      source: unit.source,
      from: unit.from,
      to: unit.to,
      lockPath,
      report,
      summary: readText(summaryFile),
      flags,
      reverted,
    });
    if (open === null) {
      const number = prs.create({
        branch: unit.branch,
        base: ctx.config.defaultBranch,
        title,
        body,
        draft: flags !== null,
      });
      for (const label of options.labels) prs.addLabel(number, label);
      ctx.log(`opened PR #${number}${flags !== null ? " as a draft, with flagged lines" : ""}.`);
    } else {
      prs.edit(open.number, { title, body });
      if (flags !== null && !open.isDraft) prs.markDraft(open.number);
      ctx.log(`refreshed PR #${open.number} to ${shortRef(unit.to)}.`);
    }
  }

  return defineWorkKind<SkillUpdatesGathered, SkillUnit>({
    name: SKILL_UPDATES_KIND_NAME,
    oneShotEligible: true,
    promptFile: SKILL_UPDATES_PROMPT_FILE,
    workspace: "scratch",
    unitKey: "none",
    report: {
      noun: "skill source(s)",
      describe: (unit) =>
        unit.action === "notify"
          ? `newer-ref note for ${unit.source} on PR #${unit.pr?.number}`
          : `skill update for ${unit.source} to ${shortRef(unit.to)}`,
    },

    async fetch(ctx) {
      const now = ctx.clock.now().getTime();
      if (lastScanAt === null || now - lastScanAt >= window) {
        ctx.origin.fetch();
        lastScanAt = now;
        pending.clear();
        for (const unit of scan(ctx)) pending.set(unit.ref, unit);
      }
      return { units: [...pending.values()] };
    },

    select(gathered, ctx) {
      const skipped: { reason: string; count: number }[] = [];
      let inFlight = 0;
      let quarantined = 0;
      let unit: SkillUnit | null = null;
      for (const candidate of gathered.units) {
        if (ctx.inFlight.has(candidate.ref)) inFlight++;
        else if (ctx.quarantined.has(candidate.ref)) quarantined++;
        else unit ??= candidate;
      }
      if (inFlight > 0) skipped.push({ reason: "in flight", count: inFlight });
      if (quarantined > 0) skipped.push({ reason: "quarantined in memory", count: quarantined });
      return { unit, skipped, total: gathered.units.length };
    },

    async run(unit, ctx) {
      // Taken off the list first: a run that fails waits for the next scan.
      pending.delete(unit.ref);
      const prs = makePrs(ctx);
      if (unit.action === "notify") {
        notify(unit, unit.pr!.number, prs, ctx);
        return;
      }
      const repoDir = ctx.config.paths.repoDir;
      const tree = join(ctx.workspace.scratch, "repo");
      ctx.origin.fetch();
      git(
        ["worktree", "add", "--quiet", "--detach", tree, `origin/${ctx.config.defaultBranch}`],
        repoDir,
      );
      try {
        await bump(unit, ctx, prs, tree);
      } finally {
        try {
          git(["worktree", "remove", "--force", tree], repoDir);
        } catch {
          rmSync(tree, { recursive: true, force: true });
          git(["worktree", "prune"], repoDir);
        }
      }
    },
  });
}

function commit(tree: string, subject: string): void {
  git(["commit", "--quiet", "--no-verify", "-m", subject], tree);
}

/** A file's trimmed text, or null when it is missing or blank. */
function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  return text === "" ? null : text;
}

/**
 * Put every guarded path back as the sync commit left it, keeping whatever
 * else the agent did, committed or not. Returns the guarded paths it changed.
 */
function revertGuarded(tree: string, synced: string, guarded: readonly string[]): string[] {
  // The agent's commits, if any, become uncommitted changes over the sync commit.
  git(["reset", "--quiet", "--soft", synced], tree);
  git(["add", "--all"], tree);
  const changed = git(["diff", "--cached", "--name-only", "-z", synced], tree)
    .split("\0")
    .filter((p) => p !== "");
  const touched = guarded.filter((g) => changed.some((p) => p === g || p.startsWith(`${g}/`)));
  for (const path of touched) {
    git(["rm", "--quiet", "-r", "--cached", "--ignore-unmatch", "--", path], tree);
    rmSync(join(tree, path), { recursive: true, force: true });
    try {
      git(["cat-file", "-e", `${synced}:${path}`], tree);
    } catch {
      continue;
    }
    git(["checkout", synced, "--", path], tree);
  }
  return changed.filter((p) => touched.some((g) => p === g || p.startsWith(`${g}/`)));
}

/**
 * The catalog entry point: the loader hands a factory the resolved config and
 * the block's root options. Validation throws here, at registration, so a bad
 * block fails `phoebe pipelines` and the pipeline's boot rather than a scan.
 */
export default function skillUpdatesKind(
  _config: PhoebeConfig,
  options: unknown,
): WorkKindDefinition<SkillUpdatesGathered, SkillUnit> {
  return createSkillUpdatesKind(
    resolveSkillUpdatesOptions(options, `kinds.${SKILL_UPDATES_KIND_NAME}`),
  );
}
