// The supervisor's global concurrency broker — scheduling across N repos (#59).
// One per container, covering every row the supervisor runs in either arm: solo
// is a one-tenant fleet, so it contends here too rather than against a broker of
// its own (#416).
//
// One engine child per row, but one machine: left ungated, N children could run
// N heavy work units (worktree + install + agent + test + push) at once and
// thrash the host. The supervisor holds a single in-memory counting semaphore
// and hands out a bounded number of *slots*; a child requests one per unit it
// admits and releases it when that unit finishes. The cheap poll → fetch →
// select phase stays ungated and parallel across children.
//
// A row holds as many slots as it has units in flight, so the cap can no longer
// be a constant 1 (#407). Three rules replace it:
//
//   - **The effective cap is derived**: `max(declared concurrency)` across the
//     live rows, so a row's own `concurrency` is always achievable when it is
//     the only one working, while the cap still binds across rows. Today's fleet
//     — every row at 1 — derives 1, so the upgrade is a no-op.
//     `PHOEBE_MAX_CONCURRENT_AGENTS` replaces the derived number absolutely,
//     even when lower: the operator knows the machine and the tenant does not.
//     A row declaring more than the cap is not clamped locally; it queues.
//   - **The slot floor**: a row holding zero slots with a waiter is *starved*
//     and may be granted one slot over the cap, at most `floorBudget` such
//     over-grants fleet-wide at once (`PHOEBE_SLOT_FLOOR_BUDGET`, default 1;
//     0 is a hard ceiling). It guarantees progress, not throughput — one long
//     unit elsewhere must not make a Slack reporter wait 45 minutes. The
//     arithmetic that keeps the breach bounded is two rules: a release consumes
//     the over-grant first, and no freed slot is handed to a waiter while
//     `inUse` exceeds the cap.
//   - **Priority orders the queue**: round-robin picks the tenant, then the
//     row's `priority` (higher first, ties FIFO) picks among that tenant's
//     waiting rows. Tenant-local by design — the knob lives in tenant config,
//     so a globally-comparable value would let a tenant revoke cross-tenant
//     fairness. Waiters are sorted at grant time, not at enqueue, which is what
//     makes `priority` hot: a change lands on everyone already queued with no
//     queue surgery.
//
// Fairness stays per *row*: a tenant declaring three pipelines gets three queue
// positions against a one-pipeline tenant's one, deliberately, because that is
// what declaring three independent streams means.
//
// The broker is the only entity that sees all rows — the natural fairness
// authority — and crash-reclaim is clean: when a child dies (crash / OOM /
// reconcile-SIGTERM) the supervisor reclaims every slot it held and restores any
// floor budget it was holding, so no failure mode can permanently shrink the cap
// or permanently inflate it (#59/#72 carry-forward). This module is the pure
// semaphore + owner bookkeeping; the IPC adapter that maps child messages onto
// it lives in bootstrap/broker-ipc.ts.

/** Default over-cap grants allowed fleet-wide at once (#407). */
export const DEFAULT_SLOT_FLOOR_BUDGET = 1;

/**
 * A live row as the broker orders and sizes for it: who it contends against,
 * how it ranks among its tenant's rows, and what it declared it would admit.
 * The supervisor pushes the whole matrix on every poll (`setRows`), so a hot
 * `priority` edit takes effect without relaunching anything.
 */
export type BrokerRow = {
  /** The owner id — `<tenantId>#<pipeline>`, the same key `acquire` uses. */
  id: string;
  /** The tenant this row belongs to; round-robin is over tenants. */
  tenantId: string;
  /** Tenant-local rank among that tenant's waiting rows. Higher wins. */
  priority: number;
  /** What the row declared it may hold in flight — the cap's derivation input. */
  concurrency: number;
  /** How an operator reads the row in a log line (`<slug>:<pipeline>`). */
  label?: string;
};

/** The effective cap, and enough of its derivation to log why it is that. */
export type EffectiveCap = {
  /** What the broker will run concurrently, floor excluded. */
  capacity: number;
  /** `max(declared concurrency)` across the live rows — the derived number. */
  declared: number;
  /** Whether the operator's env replaced the derivation. */
  source: "env" | "derived";
  /** Labels of the rows the derivation took its max from. */
  from: readonly string[];
  /** Rows declaring more than the cap. They queue; nothing is clamped locally. */
  clamped: readonly { label: string; concurrency: number }[];
};

/** How an owner reads in a log line when the supervisor gave no label. */
function labelOf(row: BrokerRow): string {
  return row.label ?? row.id;
}

/**
 * The effective cap for a live row matrix: `max(declared concurrency)`, or
 * `PHOEBE_MAX_CONCURRENT_AGENTS` when it is set to a valid value. The env
 * *replaces* the derivation, winning even when lower — that is what the variable
 * has always meant. A missing, non-numeric or < 1 value is no override at all.
 *
 * An empty matrix derives 1: a container with no rows has nothing to size for,
 * and the first row reshape recomputes.
 */
export function resolveEffectiveCap(
  rows: readonly BrokerRow[],
  env: NodeJS.ProcessEnv = process.env,
): EffectiveCap {
  const declaredBy = rows
    .map((row) => Math.floor(row.concurrency))
    .filter((n) => Number.isInteger(n) && n >= 1);
  const declared = Math.max(1, ...declaredBy);
  const raw = Number(env["PHOEBE_MAX_CONCURRENT_AGENTS"]);
  const override = Number.isInteger(raw) && raw >= 1 ? raw : null;
  const capacity = override ?? declared;
  return {
    capacity,
    declared,
    source: override === null ? "derived" : "env",
    from: rows.filter((row) => Math.floor(row.concurrency) === declared).map(labelOf),
    clamped: rows
      .filter((row) => row.concurrency > capacity)
      .map((row) => ({ label: labelOf(row), concurrency: row.concurrency })),
  };
}

/**
 * Read the floor budget from `PHOEBE_SLOT_FLOOR_BUDGET`. It lives in env beside
 * the cap rather than in root config: same kind of knob (host protection,
 * operator-side, deliberately not tenant-authored), read together to state the
 * worst case, which is `capacity + floorBudget`. **0 is a valid value** — an
 * operator who needs a hard ceiling sets it and accepts what it costs a starved
 * row. A negative or non-integer value is no answer, so the default stands.
 */
export function resolveFloorBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["PHOEBE_SLOT_FLOOR_BUDGET"]);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_SLOT_FLOOR_BUDGET;
}

/** How many rows a boot line names before it summarizes the rest. */
const MAX_NAMED_ROWS = 3;

function nameRows(labels: readonly string[]): string {
  const named = labels.slice(0, MAX_NAMED_ROWS).join(", ");
  const rest = labels.length - MAX_NAMED_ROWS;
  return rest > 0 ? `${named} (+${rest} more)` : named;
}

/**
 * The cap, its derivation and the clamp warning, on one line — the two numbers
 * of the worst-case formula stated where an operator can read them without
 * reverse-engineering the row set (#407).
 */
export function describeCap(cap: EffectiveCap, floorBudget: number): string {
  const derivation =
    cap.source === "env"
      ? `PHOEBE_MAX_CONCURRENT_AGENTS=${cap.capacity} replaces max(concurrency)=${cap.declared}`
      : cap.from.length > 0
        ? `max(concurrency)=${cap.declared} from ${nameRows(cap.from)}`
        : `max(concurrency)=${cap.declared}, no live rows yet`;
  const clamp =
    cap.clamped.length > 0
      ? `; declaring more than the cap and queuing for it (not clamped): ` +
        nameRows(cap.clamped.map((row) => `${row.label}(${row.concurrency})`))
      : "";
  return `slot cap ${cap.capacity} — ${derivation}; floorBudget=${floorBudget}${clamp}`;
}

/** One over-cap grant, or one returning — low-volume by construction. */
export type OverGrantEvent = {
  owner: string;
  /** The owner's label when the supervisor gave one, else the owner id. */
  label: string;
  inUse: number;
  capacity: number;
  /** Over-cap grants outstanding fleet-wide once this event has landed. */
  outstanding: number;
  floorBudget: number;
};

type Waiter = { owner: string; grant: () => void };

export type SlotBroker = {
  /** Request a slot for `owner`. Resolves immediately if one is free, else queues. */
  acquire(owner: string): Promise<void>;
  /** Release one slot held by `owner`, handing it on if the cap allows. */
  release(owner: string): void;
  /** A child died: drop its queued requests and release every slot it held. */
  reclaim(owner: string): void;
  /**
   * The live row matrix, as of this poll. Hot: it refreshes each row's tenant
   * and `priority` for the next grant and never touches the cap.
   */
  setRows(rows: readonly BrokerRow[]): void;
  /**
   * Resize on a row-reshaping reconcile. Slots already granted are never
   * recalled — a shrink lets `inUse` fall back to the new ceiling instead.
   */
  setCapacity(capacity: number): void;
  /** Slots currently held across all owners, over-grants included. */
  readonly inUse: number;
  /** How many acquires are blocked waiting. */
  readonly waiting: number;
  /** Over-cap grants outstanding fleet-wide. */
  readonly overGranted: number;
  readonly capacity: number;
  readonly floorBudget: number;
};

/**
 * Create the broker. Tracks how many slots each owner holds — and which of them
 * are over-cap floor grants — so a dead owner's slots and budget are reclaimed
 * exactly, without double-counting or leaking.
 */
export function createSlotBroker(opts: {
  capacity: number;
  floorBudget?: number;
  /** A starved row was let over the cap. */
  onOverGrant?: (event: OverGrantEvent) => void;
  /** An over-cap grant came back, restoring the budget. */
  onOverGrantReturned?: (event: OverGrantEvent) => void;
}): SlotBroker {
  const floorBudget = Math.max(0, Math.floor(opts.floorBudget ?? DEFAULT_SLOT_FLOOR_BUDGET));
  let cap = Math.max(1, Math.floor(opts.capacity));
  const held = new Map<string, number>();
  /** Which of an owner's held slots are over-cap. At most one per row, by rule. */
  const overGrants = new Map<string, number>();
  const rows = new Map<string, BrokerRow>();
  const queue: Waiter[] = [];

  const total = (counts: ReadonlyMap<string, number>): number => {
    let sum = 0;
    for (const n of counts.values()) sum += n;
    return sum;
  };
  const inUse = (): number => total(held);
  const overGranted = (): number => total(overGrants);

  // An owner the supervisor has not described yet is its own tenant at priority
  // 0: it keeps a queue position of its own and outranks nobody.
  const tenantOf = (owner: string): string => rows.get(owner)?.tenantId ?? owner;
  const priorityOf = (owner: string): number => rows.get(owner)?.priority ?? 0;
  const nameOf = (owner: string): string => rows.get(owner)?.label ?? owner;

  const take = (owner: string): void => {
    held.set(owner, (held.get(owner) ?? 0) + 1);
  };

  const drop = (counts: Map<string, number>, owner: string): void => {
    const current = counts.get(owner) ?? 0;
    if (current <= 1) counts.delete(owner);
    else counts.set(owner, current - 1);
  };

  const event = (owner: string): OverGrantEvent => ({
    owner,
    label: nameOf(owner),
    inUse: inUse(),
    capacity: cap,
    outstanding: overGranted(),
    floorBudget,
  });

  /**
   * The grant-time ordering, over the waiters this pass may serve: round-robin
   * picks the tenant — the one whose waiter has been queued longest — and
   * `priority` picks among that tenant's waiting rows, ties falling back to
   * FIFO. Read fresh on every grant, so a `priority` edit needs no queue
   * surgery. Returns the queue index to serve, or -1 when nothing is eligible.
   */
  const pick = (eligible: (waiter: Waiter) => boolean): number => {
    let chosen = -1;
    let tenant: string | null = null;
    let best = 0;
    for (let i = 0; i < queue.length; i += 1) {
      const waiter = queue[i];
      if (waiter === undefined || !eligible(waiter)) continue;
      if (chosen === -1) {
        chosen = i;
        tenant = tenantOf(waiter.owner);
        best = priorityOf(waiter.owner);
        continue;
      }
      // A different tenant waits its turn however high it ranks: `priority` is
      // tenant-local, and cross-tenant order is the round-robin's to keep.
      if (tenantOf(waiter.owner) !== tenant) continue;
      const rank = priorityOf(waiter.owner);
      if (rank > best) {
        chosen = i;
        best = rank;
      }
    }
    return chosen;
  };

  const grantAt = (index: number, overCap: boolean): void => {
    const waiter = queue.splice(index, 1)[0];
    if (waiter === undefined) return;
    take(waiter.owner);
    if (overCap) {
      overGrants.set(waiter.owner, (overGrants.get(waiter.owner) ?? 0) + 1);
      opts.onOverGrant?.(event(waiter.owner));
    }
    waiter.grant();
  };

  /**
   * Hand out everything the cap allows, then everything the floor allows. The
   * two rules that keep a breach bounded live here: the regular loop stops the
   * moment `inUse` reaches the cap — so while `inUse` exceeds it (an over-grant
   * is out) a freed slot lets `inUse` fall rather than going to a waiter — and
   * the floor loop only ever serves a *starved* row, one holding no slot at all.
   */
  const pump = (): void => {
    while (inUse() < cap) {
      const next = pick(() => true);
      if (next === -1) return;
      grantAt(next, false);
    }
    while (overGranted() < floorBudget) {
      const starved = pick((waiter) => (held.get(waiter.owner) ?? 0) === 0);
      if (starved === -1) return;
      grantAt(starved, true);
    }
  };

  return {
    acquire(owner: string): Promise<void> {
      return new Promise<void>((resolve) => {
        queue.push({ owner, grant: resolve });
        // Everything queues, even into a free slot: one ordering serves the
        // regular queue and the floor, so entitlement is decided in one place.
        pump();
      });
    },
    release(owner: string): void {
      // A release only frees a slot the owner actually holds; ignore a spurious
      // release (double-release, release-without-acquire) rather than over-grant.
      if ((held.get(owner) ?? 0) === 0) return;
      drop(held, owner);
      // The over-grant goes back first, so the row drops back to a normal
      // citizen — and the budget frees for the next starved row — as early as
      // possible.
      if ((overGrants.get(owner) ?? 0) > 0) {
        drop(overGrants, owner);
        opts.onOverGrantReturned?.(event(owner));
      }
      pump();
    },
    reclaim(owner: string): void {
      // Drop the dead owner's queued requests first (their promises never
      // resolve — the child is gone), then release each slot it held, budget
      // included, so those capacity units go to live waiters.
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]?.owner === owner) queue.splice(i, 1);
      }
      held.delete(owner);
      const returned = overGrants.delete(owner);
      if (returned) opts.onOverGrantReturned?.(event(owner));
      pump();
    },
    setRows(next: readonly BrokerRow[]): void {
      rows.clear();
      for (const row of next) rows.set(row.id, row);
    },
    setCapacity(capacity: number): void {
      cap = Math.max(1, Math.floor(capacity));
      // A cap that grew has slots to give; one that shrank hands out nothing
      // until `inUse` has fallen back under it, which `pump` already encodes.
      pump();
    },
    get inUse() {
      return inUse();
    },
    get waiting() {
      return queue.length;
    },
    get overGranted() {
      return overGranted();
    },
    get capacity() {
      return cap;
    },
    get floorBudget() {
      return floorBudget;
    },
  };
}
