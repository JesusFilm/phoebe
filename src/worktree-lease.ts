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
//     pipeline=<name>#<kind>:<ref> pid=<n>
//
// git enforces it for us — a locked tree refuses `worktree remove --force`
// without a second `-f`, and `worktree prune` skips it — so the lease is one
// mechanism, not a lock plus a convention. `pid=` is diagnostic: it names the
// process in a log line and nothing reads it back.
//
// The owner is read at two grains, which is the whole design. A *unit* holds
// the lease, so a sibling unit of the same row finding the tree busy skips its
// cycle instead of tearing down a live agent's tree (#423). A *pipeline* breaks
// the lease at boot, since a killed engine leaves its trees locked and only the
// row that took them may clear them. `leaseHolder` answers the first question
// and `leasePipeline` the second, off the one reason string. The unit segment's
// composition lives in unit-scope.ts, which is also where the two per-unit
// directories get their names.

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

/**
 * The lease this process writes on a tree it creates. `owner` is one unit's
 * `<pipeline>#<kind>:<ref>`, from `unitOwner` — whitespace-free, because the
 * reason is parsed back out of a porcelain listing on whitespace.
 */
export function formatLeaseReason(opts: { owner: string; pid: number }): string {
  return `pipeline=${opts.owner} pid=${opts.pid}`;
}

/**
 * Who holds a lease, whole — pipeline *and* unit — or `null` when the reason is
 * not one of ours (a hand-placed lock, an older engine's).
 *
 * This is the identity a unit compares its own against before it takes a tree
 * apart, so it must be the whole string: a lease held by a sibling unit of this
 * very pipeline is as much someone else's as another row's.
 */
export function leaseHolder(reason: string | null): string | null {
  if (reason === null) return null;
  const owner = /(?:^|\s)pipeline=(\S+)/.exec(reason)?.[1];
  return owner !== undefined && owner.length > 0 ? owner : null;
}

/**
 * Which pipeline holds a lease, from its reason string — or `null` when the
 * reason is not one of ours.
 *
 * The row is everything up to the first `#`, so both the unit-keyed form and a
 * bare `pipeline=work` left by an older engine parse to `work`. That is what
 * lets the boot-time break clear a process's own leases without knowing units
 * exist, and the stale-state sweep that lands after this will read the same
 * segment.
 */
export function leasePipeline(reason: string | null): string | null {
  const owner = leaseHolder(reason)?.split("#")[0];
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
 * A unit whose tree is leased by someone else — another pipeline, or a sibling
 * unit of this one. Thrown out of workspace preparation and caught by the loop,
 * which skips the unit for this cycle rather than failing it: the holder is
 * mid-run and will let go.
 *
 * `holder` is the whole owner, unit segment included, so the skip line names
 * exactly which run is sitting in the tree.
 */
export class WorktreeLeasedError extends Error {
  readonly worktreeDir: string;
  readonly holder: string | null;

  constructor(worktreeDir: string, holder: string | null) {
    super(
      `worktree ${worktreeDir} is leased by ` +
        `${holder === null ? "another writer (lock reason is not Phoebe's)" : holder}`,
    );
    this.name = "WorktreeLeasedError";
    this.worktreeDir = worktreeDir;
    this.holder = holder;
  }
}
