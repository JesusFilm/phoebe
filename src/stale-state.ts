// The stale-state sweep (#426) — what reclaims a pipeline's disk once no pipeline
// answers for it.
//
// Renaming a pipeline, deleting one, or retiring a work kind leaves
// `state/<pipeline>/`, kind-keyed scratch and read-only trees, and locked
// worktrees behind with no owner and nobody to break their lease. #418 gave a
// pipeline the right to break *its own* leases at boot; that does nothing for a
// pipeline that no longer exists. This module is the second authorized
// lease-breaker (#411 amends #403), and the only thing in the engine that
// deletes disk a pipeline is not currently using.
//
// Four properties, all from #411:
//
//   - **Stateless.** Orphanhood is a diff of disk against the current pipeline
//     enumeration, re-derived on every sweep. No cursors, no timestamps, no
//     record of a previous sweep. State is orphaned iff its pipeline name — or,
//     for kind-keyed state, its kind — is absent from the enumeration, so a
//     `disabled` pipeline (still enumerated) is *stopped*, not orphaned; a rename is
//     a delete plus a create; and a kind that moved to another pipeline keeps
//     its scratch, because ownership moved rather than ended.
//   - **Never load-bearing.** Every item is attempted on its own and one
//     failure does not stop the next. A sweep that cannot run at all is
//     reported and skipped — the supervisor spawns as if it had never run.
//     Unknown state is never read as "everything is orphaned": a config that
//     will not load throws out of {@link sweepStaleState} before a single
//     deletion.
//   - **Tiered.** The re-derivable tier goes without asking — leases, orphaned
//     `state/<pipeline>/` directories, unowned scratch and read-only trees, and
//     *clean* worktrees. A worktree that is dirty, or that carries commits
//     `origin` does not have, is never auto-deleted: it is reported with its
//     exact path and a one-line reclaim hint, because the alternative is
//     deleting an agent's unpushed work to save a directory.
//   - **The lease is the liveness invariant.** Worktrees are branch-keyed, so
//     the name diff cannot classify them; the #418 lease can. A tree is locked
//     for exactly the duration of its unit, so locked-by-a-live-pipeline is
//     untouchable, and orphan-locked or unlocked is a candidate for the tier
//     rules above. That is what finally collects the never-recurring-branch
//     trees no mechanism reclaimed before.
//
// The stray `.<pid>.status.json.tmp` files `writeStatus` can leave behind are in
// scope only *inside* an orphaned pipeline's directory, which is exactly where
// this sweep reclaims them — with the directory itself, never on their own. The
// sweep never reaches into a live pipeline's `state/` dir, where a tmp file between
// write and rename is a healthy writer rather than litter (#411 decision 9).
//
// Credential leases are out of scope: they are spawn-channel IPC, nothing on
// disk.

import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { matchConfigFlag } from "./cli-flags.ts";
import { CLONE_LOCK_DIR } from "./clone-lock.ts";
import { resolveConfig, type PathsConfig, type PhoebeConfig } from "./config-schema.ts";
import {
  commitCount,
  defaultGit,
  dirtyFileCount,
  listWorktrees,
  removeWorktree,
  unlockWorktree,
  type GitRunner,
} from "./git-model.ts";
import { applyEnvOverlay, loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { READONLY_WORKTREES_SEGMENT, resolveDataBase } from "./paths.ts";
import { pipelineOwnedKinds } from "./pipeline.ts";
import { leasePipeline, type WorktreeEntry } from "./worktree-lease.ts";

/** The output contract's version, on the same additive terms as `phoebe pipelines`. */
export const STALE_STATE_VERSION = 1;

/** Which keyspace an orphan came out of — how the report groups what it found. */
export type StaleTier = "state" | "tmp" | "scratch" | "readonly" | "worktree";

/** One orphaned thing on disk, and whether the sweep may reclaim it. */
export type StaleItem = {
  tier: StaleTier;
  /** Absolute path, because an operator reclaiming it by hand needs exactly that. */
  path: string;
  /** Why nothing owns it, in the enumeration's terms. */
  detail: string;
  /**
   * `null` when the sweep deletes it. Otherwise the one-line hint an operator
   * needs to reclaim it themselves — the protected tier is never auto-deleted.
   */
  reclaim: string | null;
};

/** The name and kind axes of the current pipeline enumeration — the whole of "owned". */
export type PipelineOwnership = {
  /** Every pipeline the enumeration produces, `disabled` ones included. */
  pipelines: ReadonlySet<string>;
  /** Every kind some enumerated pipeline owns, `disabled` ones included. */
  kinds: ReadonlySet<string>;
};

/**
 * The enumeration's two axes, off the resolved tenant config.
 *
 * `phoebe pipelines` answers a different question — fingerprints, concurrency,
 * whether a pipeline needs the clone — and assembles a registry per pipeline to do it.
 * The sweep needs neither: a name is orphaned or it is not, and a kind is owned
 * by declaration. Both read the same `pipelines` block, so the two agree; this
 * one just refuses to load a custom kind's module to learn a name the config
 * already spells out.
 *
 * `pipelineOwnedKinds` counts kinds a pipeline has switched off, which is the point:
 * `disabled` is hot, and a hot knob must not decide whether a directory is
 * deleted.
 */
export function pipelineOwnership(config: PhoebeConfig): PipelineOwnership {
  const pipelines = new Set<string>();
  const kinds = new Set<string>();
  for (const [name, pipeline] of Object.entries(config.pipelines)) {
    pipelines.add(name);
    for (const kind of pipelineOwnedKinds({ pipelines: config.pipelines, name, pipeline })) {
      kinds.add(kind);
    }
  }
  return { pipelines, kinds };
}

/**
 * What the sweep can learn about, and do to, the tenant's worktrees. Injected
 * so the classification is tested without a clone, and so doctor can run the
 * same scan with the deletion half unavailable.
 */
export type WorktreeInspector = {
  /** Every registered worktree, with the lock reason that names its owner. */
  list(): readonly WorktreeEntry[];
  /**
   * What a tree holds that `origin` does not: changed files, and commits ahead
   * of its own remote branch. `ahead` is null when git will not say — an
   * unknown answer protects the tree rather than condemning it. The whole
   * result is null when the path is not a working tree git can talk about at
   * all, which is a directory a killed run left behind rather than a worktree.
   */
  inspect(dir: string): { changed: number; ahead: number | null } | null;
  /** Drop any lease and remove the tree; the sweep's only write. */
  release(dir: string): void;
};

/**
 * The inspector for a tenant's own clone, or `null` when there is no clone —
 * a tenant every pipeline of which runs `scratch` kinds never has one (#418), and
 * doctor may be looking at a data directory from the host.
 */
export function createWorktreeInspector(opts: {
  repoDir: string;
  defaultBranch: string;
  git?: GitRunner;
}): WorktreeInspector | null {
  const git = opts.git ?? defaultGit;
  const { repoDir, defaultBranch } = opts;
  if (!existsSync(join(repoDir, ".git")) && !existsSync(join(repoDir, "HEAD"))) return null;
  return {
    list: () => listWorktrees(repoDir, git),
    inspect(dir) {
      let changed: number;
      try {
        changed = dirtyFileCount(dir, git);
      } catch {
        return null;
      }
      return { changed, ahead: aheadOfOrigin(dir, defaultBranch, git) };
    },
    release(dir) {
      unlockWorktree(repoDir, dir, git);
      removeWorktree(repoDir, dir, git);
    },
  };
}

/**
 * How many commits in `dir` no `origin` ref has.
 *
 * Against the tree's *own* remote branch first: a pushed unit branch is
 * published work, and counting it as unpushed would protect every worktree the
 * engine ever made and leave the sweep with nothing to do. A branch origin has
 * never seen falls back to the default branch, where every commit on it is
 * genuinely unpublished, and a detached tree — every read-only workspace —
 * measures against the default branch it was cut from.
 */
function aheadOfOrigin(dir: string, defaultBranch: string, git: GitRunner): number | null {
  const branch = worktreeBranch(dir, git);
  const ranges =
    branch === null
      ? [`origin/${defaultBranch}..HEAD`]
      : [`origin/${branch}..HEAD`, `origin/${defaultBranch}..HEAD`];
  for (const range of ranges) {
    try {
      const count = commitCount(dir, range, git);
      if (Number.isFinite(count)) return count;
    } catch {
      // The next range, or an unknown answer that protects the tree.
    }
  }
  return null;
}

/** The branch checked out in `dir`, or null when it is detached (or unreadable). */
function worktreeBranch(dir: string, git: GitRunner): string | null {
  try {
    const name = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).trim();
    return name.length === 0 || name === "HEAD" ? null : name;
  } catch {
    return null;
  }
}

/** Directory names directly under `dir`; empty when the directory is not there. */
function childDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The `.<pid>.status.json.tmp` files `writeStatus` leaves when it dies mid-write. */
function strayStatusTmpFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".status.json.tmp"))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * The path with every symlink resolved, or the absolute path when it does not
 * exist. git reports canonical paths in `worktree list`, while the data base
 * comes from config, so a symlinked data volume would otherwise make the two
 * spellings of one directory look like different places — and the sweep would
 * quietly find no worktrees at all.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Is `path` inside `root`? Guards the sweep against ever leaving the tenant's tree. */
function isInside(root: string, path: string): boolean {
  const rel = relative(canonical(root), canonical(path));
  return rel.length > 0 && !rel.startsWith("..") && !rel.includes("\0");
}

/** The kind a read-only tree belongs to, or null when the path is not one. */
function readonlyKind(worktreesDir: string, dir: string): string | null {
  const root = join(worktreesDir, READONLY_WORKTREES_SEGMENT);
  if (!isInside(root, dir)) return null;
  const rel = relative(canonical(root), canonical(dir));
  const [kind] = rel.split(/[\\/]/);
  return kind !== undefined && kind.length > 0 ? kind : null;
}

/** The hint a protected worktree is reported with — one line, runnable. */
function reclaimHint(repoDir: string, dir: string): string {
  return (
    `inspect it, then \`git -C ${repoDir} worktree unlock ${dir}\` and ` +
    `\`git -C ${repoDir} worktree remove --force ${dir}\` once nothing there is worth keeping`
  );
}

/**
 * Classify one registered worktree. Returns null for a tree the sweep must not
 * touch — one a live pipeline holds, or one locked by someone whose lock reason
 * Phoebe did not write.
 */
function classifyWorktree(
  entry: WorktreeEntry,
  ctx: { paths: PathsConfig; ownership: PipelineOwnership; inspector: WorktreeInspector },
): StaleItem | null {
  const { paths, ownership, inspector } = ctx;
  // The clone itself is the first pipeline of `git worktree list`, and anything
  // outside `worktrees/` is not this sweep's business whatever it is.
  if (!isInside(paths.worktreesDir, entry.dir)) return null;

  const owner = leasePipeline(entry.reason);
  if (entry.reason !== null && owner === null) {
    // A lock Phoebe did not write is a deliberate act by someone else. Report
    // it — an unexplained untouchable tree is worse than a noisy line — and
    // leave it exactly as found.
    return {
      tier: "worktree",
      path: entry.dir,
      detail: `locked with a reason Phoebe did not write (${JSON.stringify(entry.reason)})`,
      reclaim: `\`git -C ${paths.repoDir} worktree unlock ${entry.dir}\` when the lock is yours`,
    };
  }
  if (owner !== null && ownership.pipelines.has(owner)) return null;

  const kind = readonlyKind(paths.worktreesDir, entry.dir);
  const tier: StaleTier = kind === null ? "worktree" : "readonly";
  const why =
    owner !== null
      ? `leased by pipeline "${owner}", which the enumeration does not produce`
      : kind !== null && !ownership.kinds.has(kind)
        ? `a read-only workspace for "${kind}", a kind no pipeline owns`
        : "unlocked — no pipeline holds it, so no unit is using it";

  const state = inspector.inspect(entry.dir);
  if (state === null) {
    return {
      tier,
      path: entry.dir,
      detail: `${why}; git does not recognize it as a working tree`,
      reclaim: null,
    };
  }
  if (state.changed > 0 || state.ahead === null || state.ahead > 0) {
    const holds =
      state.ahead === null
        ? "git could not say what it holds"
        : `${state.changed} changed file(s), ${state.ahead} commit(s) not on origin`;
    return {
      tier,
      path: entry.dir,
      detail: `${why}, but it is not clean — ${holds}`,
      reclaim: reclaimHint(paths.repoDir, entry.dir),
    };
  }
  return { tier, path: entry.dir, detail: why, reclaim: null };
}

/**
 * Everything on this tenant's disk that the current enumeration does not
 * account for. Pure with respect to the filesystem — it reads, never writes —
 * so doctor runs exactly the sweep's classification without the deletions.
 */
export function scanStaleState(deps: {
  paths: PathsConfig;
  ownership: PipelineOwnership;
  /** Null when the tenant has no clone: the worktree tiers are then unreadable. */
  inspector: WorktreeInspector | null;
}): StaleItem[] {
  const { paths, ownership, inspector } = deps;
  const items: StaleItem[] = [];

  // `state/<pipeline>/` — the snapshot and anything else the pipeline wrote beside
  // it. The clone lock is a live tenant-wide mechanism, not a pipeline's directory.
  for (const name of childDirectories(paths.stateDir)) {
    if (name === CLONE_LOCK_DIR || ownership.pipelines.has(name)) continue;
    const dir = join(paths.stateDir, name);
    items.push({
      tier: "state",
      path: dir,
      detail: `no pipeline named "${name}" — its status snapshot is unowned`,
      reclaim: null,
    });
    for (const tmp of strayStatusTmpFiles(dir)) {
      items.push({
        tier: "tmp",
        path: tmp,
        detail: `a half-written snapshot inside orphaned "${name}"`,
        reclaim: null,
      });
    }
  }

  // `scratch/<kind>` — kind-keyed, so it follows the kind rather than the pipeline.
  // A kind that moved to another pipeline is still owned and keeps its scratch.
  for (const kind of childDirectories(paths.scratchDir)) {
    if (ownership.kinds.has(kind)) continue;
    items.push({
      tier: "scratch",
      path: join(paths.scratchDir, kind),
      detail: `no pipeline owns the kind "${kind}"`,
      reclaim: null,
    });
  }

  if (inspector === null) return items;

  const seen = new Set<string>();
  for (const entry of inspector.list()) {
    const item = classifyWorktree(entry, { paths, ownership, inspector });
    seen.add(canonical(entry.dir));
    if (item !== null) items.push(item);
  }

  // A read-only tree for a retired kind that git no longer knows about — the
  // residue of a `worktree remove` that failed, or of a clone rebuilt under it.
  // Only unowned kinds: an owned kind's directory is either registered (handled
  // above) or being built right now by a live pipeline.
  //
  // The kind's trees sit one level down, at `readonly/<kind>/<ref>`, one per
  // unit (#423), so "git has no record of it" has to hold for the whole subtree:
  // a registered tree inside was classified on its own terms above, and deleting
  // the kind directory would take one the sweep deliberately kept with it. Once
  // those trees are gone the empty directory is nobody's, and the next sweep
  // reclaims it.
  for (const kind of childDirectories(join(paths.worktreesDir, READONLY_WORKTREES_SEGMENT))) {
    if (ownership.kinds.has(kind)) continue;
    const dir = join(paths.worktreesDir, READONLY_WORKTREES_SEGMENT, kind);
    if ([...seen].some((path) => path === canonical(dir) || isInside(dir, path))) continue;
    items.push({
      tier: "readonly",
      path: dir,
      detail: `a read-only workspace for "${kind}", a kind no pipeline owns; git has no record of it`,
      reclaim: null,
    });
  }

  return items;
}

/** What one sweep did, per item, in the order it did it. */
export type SweepStaleStateResult = {
  version: number;
  /** Reclaimed. */
  removed: StaleItem[];
  /** Found and deliberately left: the protected tier, with its hints. */
  kept: StaleItem[];
  /** Attempted and failed. One item's failure never stops the next. */
  failed: Array<{ item: StaleItem; error: string }>;
};

/**
 * Reclaim what the scan found. Best-effort per item, on the discipline every
 * other engine sweep follows: a directory that will not delete is reported and
 * the sweep carries on to the next one.
 */
export function applyStaleStateSweep(
  items: readonly StaleItem[],
  inspector: WorktreeInspector | null,
): SweepStaleStateResult {
  const result: SweepStaleStateResult = {
    version: STALE_STATE_VERSION,
    removed: [],
    kept: [],
    failed: [],
  };
  for (const item of items) {
    if (item.reclaim !== null) {
      result.kept.push(item);
      continue;
    }
    try {
      if ((item.tier === "worktree" || item.tier === "readonly") && inspector !== null) {
        // Through git, and through the lease: `release` drops the lock this
        // sweep is authorized to break, then removes the tree and prunes the
        // clone's administrative record of it.
        inspector.release(item.path);
      } else {
        rmSync(item.path, { recursive: true, force: true });
      }
      result.removed.push(item);
    } catch (error) {
      result.failed.push({
        item,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/** Scan and reclaim in one call — the sweep as the supervisor invokes it. */
export function sweepStaleState(deps: {
  paths: PathsConfig;
  ownership: PipelineOwnership;
  inspector: WorktreeInspector | null;
}): SweepStaleStateResult {
  return applyStaleStateSweep(scanStaleState(deps), deps.inspector);
}

/** One human line per item — what a hand run prints, and what boot echoes. */
export function formatSweepResult(result: SweepStaleStateResult): string[] {
  const lines: string[] = [];
  for (const item of result.removed) {
    lines.push(`removed ${item.tier} ${item.path}: ${item.detail}`);
  }
  for (const { item, error } of result.failed) {
    lines.push(`could not remove ${item.tier} ${item.path}: ${error}`);
  }
  for (const item of result.kept) {
    lines.push(`kept ${item.tier} ${item.path}: ${item.detail}. To reclaim, ${item.reclaim}.`);
  }
  if (lines.length === 0)
    lines.push("nothing stale: every directory on disk has a pipeline behind it.");
  return lines;
}

export type ParsedSweepStateArgs = {
  configPath: string | undefined;
  json: boolean;
  help: boolean;
};

export function parseSweepStateArgs(argv: readonly string[]): ParsedSweepStateArgs {
  let configPath: string | undefined;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const config = matchConfigFlag(argv, i);
    if (config !== undefined) {
      configPath = config.value;
      i += config.consumed - 1;
      continue;
    }
    throw new Error(
      `Unknown argument \`${String(arg)}\` for \`phoebe sweep-state\`. ` +
        `See \`phoebe sweep-state --help\`.`,
    );
  }
  return { configPath, json, help };
}

const SWEEP_STATE_HELP_TEXT = `phoebe sweep-state — reclaim disk no pipeline owns

Usage:
  phoebe sweep-state [--config <path>] [--json]

Diffs this tenant's data directory against the pipelines its config declares and
deletes what nothing owns: orphaned state/<pipeline>/ directories, scratch and
read-only trees for retired kinds, worktree leases held by a pipeline that no
longer exists, and the clean worktrees behind them. A worktree that is dirty, or
that holds commits origin does not have, is never deleted — it is reported with
a reclaim hint.

The supervisor runs this at facility boot and after a pipeline-set change. Run by
hand only while the tenant's pipelines are stopped: it is safe beside a live pipeline (a
pipeline's own worktrees are leased while it works), but it reclaims trees no pipeline
currently holds.
`;

/**
 * `phoebe sweep-state`. Exits non-zero — deleting nothing — when the tenant's
 * config will not load or resolve: unknown state is not "everything is
 * orphaned", and the supervisor reads the failure as "spawn as if the sweep had
 * never run".
 */
export async function runSweepStateCli(argv: readonly string[]): Promise<void> {
  const parsed = parseSweepStateArgs(argv);
  if (parsed.help) {
    process.stdout.write(SWEEP_STATE_HELP_TEXT);
    return;
  }
  const configPath = resolveConfigPath(parsed.configPath, process.cwd());
  const userConfig = await loadUserConfig(configPath);
  if ((userConfig as { workspace?: unknown }).workspace !== undefined) {
    throw new Error(
      `${configPath} is a workspace root (it carries a \`workspace\` block). Pipelines — and the ` +
        `state they leave — live inside one tenant: sweep a tenant's config instead.`,
    );
  }
  const overlaid = applyEnvOverlay(userConfig, process.env);
  const config = resolveConfig(overlaid, { dataBase: resolveDataBase(process.env) });
  const result = sweepStaleState({
    paths: config.paths,
    ownership: pipelineOwnership(config),
    inspector: createWorktreeInspector({
      repoDir: config.paths.repoDir,
      defaultBranch: config.defaultBranch,
    }),
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`${formatSweepResult(result).join("\n")}\n`);
}

/**
 * The tenant data directory a slug's paths hang off — what doctor checks for
 * before reporting on a data volume that may not be mounted where it is
 * running.
 */
export function tenantDataDir(paths: PathsConfig): string {
  return dirname(paths.stateDir);
}

/** Does this tenant have a data directory at all? */
export function hasTenantData(paths: PathsConfig): boolean {
  try {
    return statSync(tenantDataDir(paths)).isDirectory();
  } catch {
    return false;
  }
}
