// What a pairing did. Lives here rather than beside the run that performs it so
// a console can render the result without loading the Compose driver and the
// relay client behind it (#527 §4).
//
// Pairing is the one verb with two ends: the companion writes the deployment's
// half — the relay's address in the root config, a single-use token in the root
// `.env` — and the deployment spends that token itself on its next boot, minting
// the key the relay records as a link (#540). So an outcome reports what was
// written and what the deployment will answer to, and stops there. The
// fingerprint of the key belongs to the boot that mints it and arrives back
// through the relay's own rows, which is where a console reads it from.

/** What one `pair` run wrote, and what the deployment will do with it. */
export type PairOutcome = {
  /** The `wss://…/deployments` URL written into the root config's `relay` block. */
  relayUrl: string;
  /** What this deployment answers to on the relay (#505 §3). */
  deploymentName: string;
  /** ISO 8601: when the token in `.env` stops being spendable (#505 §1). */
  expiresAt: string;
  /**
   * The config already named a different relay and this pairing moved it. Worth
   * saying out loud: the deployment's old link goes dark rather than away, and
   * the operator is the only one who can decide it should be forgotten (#505 §5).
   */
  movedRelay: boolean;
};
