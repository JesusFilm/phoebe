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
// The mapping below is the whole of it. Each sweep names the kinds whose
// objects it repairs; where a listing already carries enough to name the
// owning kind of one object (the stranded sweep's labels), the filter is
// applied per object, and where it does not the sweep runs only if it owns at
// least one of the kinds involved. A pipeline that schedules none of them —
// one running only custom kinds, say — runs an empty sweep.

/**
 * The kinds whose units are queue-labelled issues. What the stranded-unit
 * sweep re-arms and the issue half of the quarantine sweep clears; also the
 * producers whose runs create the native stacks and feature integration PRs
 * the other two sweeps maintain.
 */
export const ISSUE_UNIT_KINDS = ["issues", "research"] as const;

/** The kinds whose units are Phoebe's own open PRs — the PR half of the quarantine sweep. */
export const PR_UNIT_KINDS = ["conflicts", "checks", "reviews"] as const;

/**
 * What this pipeline's scheduled kinds let it sweep. Built once per engine
 * from the row's work order, so a sweep asks a boolean rather than re-deriving
 * a set every cycle.
 */
export type SweepScope = {
  /** Does this pipeline schedule a kind whose units are issues? */
  readonly issues: boolean;
  /** Does this pipeline schedule a kind whose units are PRs? */
  readonly prs: boolean;
  /**
   * The owning kind of one queue-labelled issue: `research` when it carries the
   * research label, else `issues`. The two producers are told apart by nothing
   * else — same processing label, same PR shape — and the label is already on
   * every row the stranded sweep lists, so the partition costs no extra call.
   */
  ownsIssue(labels: readonly string[]): boolean;
};

/**
 * Build the scope for a pipeline scheduling `kinds`. `researchLabel` is the
 * tenant's, because that is what distinguishes a `research` unit from an
 * `issues` one on the tracker.
 */
export function sweepScope(kinds: readonly string[], researchLabel: string): SweepScope {
  const scheduled = new Set(kinds);
  const [plainProducer, researchProducer] = ISSUE_UNIT_KINDS;
  const schedulesIssues = scheduled.has(plainProducer);
  const schedulesResearch = scheduled.has(researchProducer);
  return {
    issues: schedulesIssues || schedulesResearch,
    prs: PR_UNIT_KINDS.some((kind) => scheduled.has(kind)),
    ownsIssue: (labels) => (labels.includes(researchLabel) ? schedulesResearch : schedulesIssues),
  };
}
