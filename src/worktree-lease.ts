// The worktree lease (#418) — how two engine processes on one tenant stay off
// each other's trees.
//
// Before pipelines, one process owned `worktrees/` outright and
// `prepareWorktree` could clear any tree it found: a stale directory was
// always its own. With a second process working the same clone that stops
// being true, and the old teardown's recursive-delete fallback would take a
// sibling's live tree out from under a running agent.
//
// The lease is `git worktree lock` with a reason this module writes and reads:
//
//     pipeline=<name> pid=<n>
//
// git enforces it for us — a locked tree refuses `worktree remove --force`
// without a second `-f`, and `worktree prune` skips it — so the lease is one
// mechanism, not a lock plus a convention. `pid=` is diagnostic: it names the
// process in a log line and nothing reads it back. Ownership is the pipeline
// segment alone, which is what lets the per-unit isolation ticket widen the
// owner to `<pipeline>#<unit-ref>` without touching the boot-time break.

/** One row of `git worktree list --porcelain`, reduced to what the lease cares about. */
export type WorktreeEntry = {
  dir: string;
  /**
   * The lock's reason, `""` for a tree locked without one, and `null` when the
   * tree is not locked at all. The empty-string case is a real lock — a human's
   * bare `git worktree lock` — so it must not read as unlocked.
   */
  reason: string | null;
};

/** The lease this process writes on a tree it creates. */
export function formatLeaseReason(opts: { pipeline: string; pid: number }): string {
  return `pipeline=${opts.pipeline} pid=${opts.pid}`;
}

/**
 * Which pipeline holds a lease, from its reason string — or `null` when the
 * reason is not one of ours (a hand-placed lock, an older engine's).
 *
 * The owner is read as everything up to the first `#`, so the widened
 * `pipeline=work#issue:88` form the per-unit ticket introduces already parses
 * to `work` here. That is deliberate: the boot-time break must keep clearing a
 * process's own leases after that change without being taught about it.
 */
export function leasePipeline(reason: string | null): string | null {
  if (reason === null) return null;
  const match = /(?:^|\s)pipeline=(\S+)/.exec(reason);
  const owner = match?.[1]?.split("#")[0];
  return owner !== undefined && owner.length > 0 ? owner : null;
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated and
 * each opens with `worktree <path>`; `locked` carries its reason on the same
 * line when there is one.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      current = { dir: line.slice("worktree ".length), reason: null };
      entries.push(current);
      continue;
    }
    if (current && (line === "locked" || line.startsWith("locked "))) {
      current.reason = line.slice("locked".length).trim();
    }
  }
  return entries;
}

/**
 * A unit whose tree is leased by another pipeline. Thrown out of workspace
 * preparation and caught by the loop, which skips the unit for this cycle
 * rather than failing it: the sibling is mid-run and will let go.
 */
export class WorktreeLeasedError extends Error {
  readonly worktreeDir: string;
  readonly holder: string | null;

  constructor(worktreeDir: string, holder: string | null) {
    super(
      `worktree ${worktreeDir} is leased by ` +
        `${holder === null ? "another writer (lock reason is not Phoebe's)" : `pipeline ${holder}`}`,
    );
    this.name = "WorktreeLeasedError";
    this.worktreeDir = worktreeDir;
    this.holder = holder;
  }
}
