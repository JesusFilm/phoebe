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

import type { WorkUnitKey } from "./work-kinds/definition.ts";
import type { WorkKindRegistry } from "./work-kinds/registry.ts";
import { registeredKind } from "./work-kinds/walk.ts";

/**
 * The one issue-keyed kind the tracker can tell apart: its tickets carry the
 * tenant's research label. Every other issue-keyed kind shares the unlabelled
 * remainder, because no definition field says which label its tickets wear.
 */
const RESEARCH_KIND = "research";

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
   * The owning kind of one queue-labelled issue: `research` when it carries the
   * research label, else any other issue-keyed kind. The producers are told
   * apart by nothing else — same processing label, same PR shape — and the
   * label is already on every issue the stranded sweep lists, so the partition
   * costs no extra call.
   */
  ownsIssue(labels: readonly string[]): boolean;
};

/**
 * Build the scope for a pipeline scheduling `kinds`, each read from `registry`.
 * `researchLabel` is the tenant's, because that is what distinguishes a
 * `research` unit from any other issue-keyed one on the tracker.
 */
export function sweepScope(
  kinds: readonly string[],
  registry: WorkKindRegistry,
  researchLabel: string,
): SweepScope {
  const unitKeyOf = (kind: string): WorkUnitKey =>
    registeredKind(registry, kind).definition.unitKey ?? "none";
  const issueKinds = kinds.filter((kind) => unitKeyOf(kind) === "issue");
  const schedulesResearch = issueKinds.includes(RESEARCH_KIND);
  const schedulesUnlabelled = issueKinds.some((kind) => kind !== RESEARCH_KIND);
  return {
    issues: issueKinds.length > 0,
    prs: kinds.some((kind) => unitKeyOf(kind) === "pr"),
    ownsIssue: (labels) =>
      labels.includes(researchLabel) ? schedulesResearch : schedulesUnlabelled,
  };
}
