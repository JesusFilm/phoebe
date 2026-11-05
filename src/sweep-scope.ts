// Which tracker-side sweeps a pipeline runs, and over what (#418).
//
// The four sweeps run once per cycle and repair state on GitHub objects nobody
// is holding. With one engine process per tenant that was safe by arithmetic.
// With two, both would sweep the same objects every cycle — and the
// stranded-unit sweep re-arms an issue whose run produced no PR, which is
// exactly what a sibling's in-flight run looks like from outside.
//
// Partition by ownership, not by leader election (#403): a sweep touches an
// object only when the object's work kind is one this pipeline schedules. Two
// pipelines that between them schedule every kind still cover every object
// exactly once, with no coordination and nothing to fail over.
//
// A kind says what its units are through its definition's `unitKey` (#753), so
// a custom or catalog kind gets the same sweeps as the built-in it resembles.
// Each sweep names the unit key whose objects it repairs; where a listing
// already carries enough to name the owning kind of one object (the stranded
// sweep's labels), the filter is applied per object, and where it does not the
// sweep runs only if the pipeline schedules at least one kind of that key. A
// pipeline whose kinds are all `none` runs an empty sweep.
//
// Every issue kind claims with the same processing label, so a claimed ticket
// names its kind only through the queue label it still wears, the kind's
// `unitLabel`. Nothing in the engine removes a queue label, so a claimed
// ticket still wears the one it was selected by. A pipeline's registry holds
// every built-in but only its own custom kinds, so a pipeline cannot know
// every queue label the tenant uses. The rule therefore fails closed: a kind
// owns a ticket only when the ticket wears that kind's label, and a ticket
// wearing no label this pipeline knows is some other pipeline's.

import type { WorkKindRegistry } from "./work-kinds/registry.ts";
import { registeredKind } from "./work-kinds/walk.ts";

/** The kind a claimed ticket belongs to, by the queue label the ticket wears. */
export type IssueOwner = { readonly kind: string; readonly unitLabel: string };

/**
 * What this pipeline's scheduled kinds let it sweep. Built once per engine
 * from the pipeline's work order, so a sweep asks a boolean rather than re-deriving
 * a set every cycle.
 */
export type SweepScope = {
  /** Does this pipeline schedule a kind whose units are issues? */
  readonly issues: boolean;
  /** Does this pipeline schedule a kind whose units are PRs? */
  readonly prs: boolean;
  /**
   * The owner of one claimed issue when this pipeline schedules it, else null.
   * A ticket belongs to the issue kind whose queue label it wears. The
   * tenant's `readyLabel` is the weakest claim: a ticket wearing it and another
   * kind's label (`research`'s, say) belongs to the other kind. A ticket two
   * kinds could claim belongs to neither, and a ticket wearing no queue label
   * known here belongs to nobody here. Both stay claimed for a person to sort
   * out, because a wrong guess hands one ticket to two agents.
   */
  issueOwner(labels: readonly string[]): IssueOwner | null;
};

/**
 * Build the scope for a pipeline scheduling `kinds`, each read from `registry`.
 * `readyLabel` is the tenant's: it is on nearly every ticket, so wearing it
 * says nothing about which kind a ticket belongs to unless no other kind's
 * label is there.
 */
export function sweepScope(
  kinds: readonly string[],
  registry: WorkKindRegistry,
  readyLabel: string,
): SweepScope {
  const unitKeyOf = (kind: string) => registeredKind(registry, kind).definition.unitKey ?? "none";
  const scheduled = new Set(kinds);
  const issueKinds: IssueOwner[] = [];
  for (const [kind, { definition }] of registry) {
    if (definition.unitKey === "issue" && definition.unitLabel !== undefined) {
      issueKinds.push({ kind, unitLabel: definition.unitLabel });
    }
  }
  const specific = issueKinds.filter((owner) => owner.unitLabel !== readyLabel);
  const general = issueKinds.filter((owner) => owner.unitLabel === readyLabel);
  return {
    issues: kinds.some((kind) => unitKeyOf(kind) === "issue"),
    prs: kinds.some((kind) => unitKeyOf(kind) === "pr"),
    issueOwner: (labels) => {
      const wearing = specific.filter((owner) => labels.includes(owner.unitLabel));
      const claimants =
        wearing.length > 0 ? wearing : general.filter((owner) => labels.includes(owner.unitLabel));
      if (claimants.length !== 1) return null;
      const [owner] = claimants;
      return owner !== undefined && scheduled.has(owner.kind) ? owner : null;
    },
  };
}
