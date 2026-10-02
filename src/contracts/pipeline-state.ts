// What a pipeline is doing, and whether it smells stuck — the two derived
// answers every reader of a deployment shares.
//
// The derivation itself stays in src/pipeline-listing.ts, which is the one owner
// of both (#501): `phoebe list` computes them for a tenant on disk, the
// bootstrapper computes them for the whole fleet into `state/deployment.json`,
// and a consumer of that file recomputes nothing. Only the vocabulary lives
// here, where a renderer can load it.

/** Where a pipeline line came from — see src/pipeline-listing.ts. */
export type PipelineSource = "enumerated" | "stale" | "disk";

/**
 * What a pipeline is doing, from its own snapshot. Tested in this order, so a
 * pipeline that is both working and parked on a second slot reads as working: the
 * unit already in flight is the more useful fact.
 */
export type PipelineState = "no status" | "working" | "waiting for slot" | "idle";

/**
 * Is this pipeline wedged, and on which clause (#507)?
 *
 * Two clauses, either of which is enough. `unit-overdue`: some in-flight unit
 * has outlived its own run budget plus one poll interval — long enough that the
 * loop should have reaped it. `no-pass`: the engine has completed no loop pass
 * in three poll intervals while not waiting for a slot, which is how a process
 * that is alive but whose loop has stopped becomes visible at all (an idle
 * engine writes no snapshot, so it reads `idle` forever).
 *
 * `noPassForMs` is stamped when the verdict is taken and is the only form the
 * pass clock is ever published in: `lastPassAt` itself is never rendered as an
 * age, because between two reports it goes stale on a perfectly healthy idle
 * pipeline.
 *
 * A question, not a state the engine records — which is why it is derived on
 * every read of the fleet rather than written down by the thing being judged.
 */
export type WedgedVerdict =
  | { wedged: false }
  | { wedged: true; reason: "unit-overdue" }
  | { wedged: true; reason: "no-pass"; noPassForMs: number };
