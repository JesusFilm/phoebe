// The one selection walk (#348/#422): walk the kinds in `workOrder` order, ask
// each registered definition's `select` for its pick against its own gathered
// slot, and take units depth-first until the pass has none of its free slots
// left. Selection and the idle report are the same walk — the skip record
// covers exactly the kinds that were actually considered, so the report can
// only ever describe the walk the loop actually made.
//
// Depth-first is what keeps `order` meaning priority once a pass may admit
// several units (#422): the first kind is asked again and again until it runs
// out, and only then does the walk move on. `select` stays pure and is simply
// called more than once; what makes the repeats terminate is `ctx.inFlight`,
// which carries this kind's already-running refs plus the ones this very walk
// picked. A kind that ignores it offers the same ref twice, the walk drops the
// repeat and stops asking that kind — so the worst a careless kind gets is
// concurrency 1, never two agents on one unit.

import type {
  AnyWorkKindDefinition,
  WorkKindCtx,
  WorkKindSelection,
  WorkUnitShape,
} from "./definition.ts";
import type { RegisteredWorkKind, WorkKindRegistry } from "./registry.ts";

/** The one engine-synthesized skip reason: units existed, none were picked. */
export const NONE_WORKABLE = "none-workable";

export type PickedWorkUnit = {
  kind: string;
  definition: AnyWorkKindDefinition;
  unit: WorkUnitShape;
};

/** One idle-report entry: a kind's own skip reason, or `none-workable`. */
export type WorkUnitSkip = {
  kind: string;
  reason: string;
  count: number;
};

export type WorkSelection = {
  /** The picks, in walk order — at most `limit` of them. */
  units: PickedWorkUnit[];
  /** What each kind walked passed over, in walk order. */
  skipped: WorkUnitSkip[];
};

/** The kinds of `order` eligible under `--run-once`. */
export function oneShotWorkKinds(
  order: readonly string[],
  registry: WorkKindRegistry,
): readonly string[] {
  return order.filter((kind) => registeredKind(registry, kind).definition.oneShotEligible);
}

/**
 * The registry lookup every walk-adjacent consumer shares. Unreachable after
 * boot validation; a loud throw beats a silent no-op walk.
 */
export function registeredKind(registry: WorkKindRegistry, kind: string): RegisteredWorkKind {
  const registered = registry.get(kind);
  if (!registered) {
    throw new Error(`Work kind "${kind}" is not registered.`);
  }
  return registered;
}

/**
 * The one runtime check of the ref contract: quarantine keys, logs, and reports
 * all assume a printable single-line identity, and the in-flight set keys on it.
 */
function assertRefShape(kind: string, ref: unknown): asserts ref is string {
  if (typeof ref !== "string" || ref.length === 0 || ref.includes("\n")) {
    throw new Error(
      `Work kind "${kind}" selected a unit with an invalid ref ` +
        `(${JSON.stringify(ref)}): refs must be non-empty single-line strings.`,
    );
  }
}

export function selectWorkUnits(opts: {
  registry: WorkKindRegistry;
  kinds: readonly string[];
  gathered: ReadonlyMap<string, unknown>;
  ctxFor(kind: string): WorkKindCtx;
  /** How many units this pass may still admit — the pipeline's free slots. */
  limit: number;
  /** This kind's refs that were already running when the walk started. */
  inFlight(kind: string): ReadonlySet<string>;
  /** Told when a kind offered a ref that is already running. */
  onDropped?(kind: string, ref: string): void;
}): WorkSelection {
  const units: PickedWorkUnit[] = [];
  const skipped: WorkUnitSkip[] = [];
  for (const kind of opts.kinds) {
    if (units.length >= opts.limit) break;
    const { definition } = registeredKind(opts.registry, kind);
    // A copy, not the engine's own set: a walk that ends up admitting nothing
    // must leave the in-flight bookkeeping exactly as it found it.
    const running = new Set(opts.inFlight(kind));
    // Only the first ask of a kind feeds the idle report. Later asks are the
    // same cycle's data minus what this walk already took, so their skips would
    // double-count rules the report already named — and the report is only ever
    // printed for a pass that picked nothing, where there was only one ask.
    let asked = false;
    while (units.length < opts.limit) {
      const ctx: WorkKindCtx = { ...opts.ctxFor(kind), inFlight: running };
      const selection = definition.select(
        opts.gathered.get(kind),
        ctx,
      ) as WorkKindSelection<WorkUnitShape>;
      const first = !asked;
      asked = true;
      if (first) {
        for (const skip of selection.skipped) {
          skipped.push({ kind, ...skip });
        }
      }
      if (!selection.unit) {
        if (first && selection.total > 0) {
          skipped.push({ kind, reason: NONE_WORKABLE, count: selection.total });
        }
        break;
      }
      const ref = selection.unit.ref;
      assertRefShape(kind, ref);
      if (running.has(ref)) {
        opts.onDropped?.(kind, ref);
        break;
      }
      running.add(ref);
      units.push({ kind, definition, unit: selection.unit });
    }
  }
  return { units, skipped };
}
