// The one selection walk (#348): walk the kinds in `workOrder` order, ask each
// registered definition's `select` for its pick against its own gathered slot,
// and take the first kind that offers a unit. Selection and the idle report
// are the same walk — the skip record covers exactly the kinds that were
// actually considered, so the report can only ever describe the walk the loop
// actually made.

import type {
  AnyWorkKindDefinition,
  WorkKindCtx,
  WorkKindSelection,
  WorkUnitShape,
} from "./definition.ts";
import type { WorkKindRegistry } from "./registry.ts";

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
  unit: PickedWorkUnit | null;
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

function registeredKind(registry: WorkKindRegistry, kind: string) {
  const registered = registry.get(kind);
  if (!registered) {
    // Unreachable after boot validation; a loud throw beats a silent no-op walk.
    throw new Error(`Work kind "${kind}" is not registered.`);
  }
  return registered;
}

export function selectFirstWorkUnit(opts: {
  registry: WorkKindRegistry;
  kinds: readonly string[];
  gathered: ReadonlyMap<string, unknown>;
  ctxFor(kind: string): WorkKindCtx;
}): WorkSelection {
  const skipped: WorkUnitSkip[] = [];
  for (const kind of opts.kinds) {
    const { definition } = registeredKind(opts.registry, kind);
    const selection = definition.select(
      opts.gathered.get(kind),
      opts.ctxFor(kind),
    ) as WorkKindSelection<WorkUnitShape>;
    for (const skip of selection.skipped) {
      skipped.push({ kind, ...skip });
    }
    if (selection.unit) {
      const ref = selection.unit.ref;
      // The one runtime check of the ref contract: quarantine keys, logs, and
      // reports all assume a printable single-line identity.
      if (typeof ref !== "string" || ref.length === 0 || ref.includes("\n")) {
        throw new Error(
          `Work kind "${kind}" selected a unit with an invalid ref ` +
            `(${JSON.stringify(ref)}): refs must be non-empty single-line strings.`,
        );
      }
      return { unit: { kind, definition, unit: selection.unit }, skipped };
    }
    if (selection.total > 0) {
      skipped.push({ kind, reason: NONE_WORKABLE, count: selection.total });
    }
  }
  return { unit: null, skipped };
}
