// What a **local `secret set`** decided — and, above all, *which writer took it*
// (#527 §8, map #497).
//
// A local install has two places a secret can land, and which one it was is not
// a detail. A running install has a container with a data volume under it, and
// the value goes into that tenant's secret store the way an operator's own
// `phoebe secret set` would put it there. A stopped or freshly initialised one
// has no container to reach, so the companion writes the root `.env` on the
// host — which is the operator's own hand, and the only place `GH_TOKEN` can be
// typed for the first time.
//
// The two are not interchangeable and the outcome says so plainly. A value in
// the `.env` is read at container start and is visible to anyone who can read
// the folder; a value in the store is tenant scope and mode `0600` on the
// volume. An operator who set one thinking they had set the other would have a
// secret in a place they did not choose.
//
// **Nothing here carries a value.** Not the outcome, not an error off it, not a
// line the run printed. The value reaches main as a run argument and is held for
// the run only (#527 §7); what survives it is this object.

/**
 * Which of the two writers took the value.
 *
 * `container` is `phoebe secret set` inside the running container — the tenant
 * secret store on the data volume (#504). `host-env` is the deployment `.env`
 * beside `phoebe.config.ts` on this machine.
 */
export type SecretWriter = "container" | "host-env";

/** One local `secret set`, finished. */
export type SecretSetOutcome = {
  /** The key that was set. The value is nowhere on this type. */
  key: string;
  /** The tenant it was set for, or null when the write was not tenant scope. */
  tenant: string | null;
  writer: SecretWriter;
  /** Where the value landed, in the words the operator would use to find it. */
  target: string;
  at: string;
};
