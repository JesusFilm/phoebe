// What a reader is told about a tenant's secrets: which keys are present, where
// each value came from, and which of them a console may write (#504, #550; map
// #497).
//
// **Presence and provenance, and never a value.** Not the value, not its last
// four characters, not a hash, not a length. A console that showed any of those
// would be a console an operator could read a credential out of, which is the
// one thing write-only secrets exist to prevent — and "just the last four" is
// how that erosion starts. `phoebe secret ls` prints exactly these fields and
// section 6 of the deployment report carries them, so the terminal and the
// browser can say nothing different.
//
// **A key that cannot be set says why, and stays on the list.** The App
// credentials are deployment scope: their blast radius spans every repository
// the App is installed on, so no relay may set one. Hiding them would leave an
// operator searching a page for a key that is plainly in use; listing them with
// the reason is how the page answers "why can't I set this" before it is asked.

/**
 * Where the value an engine child would hold came from. The store is the top
 * tier, above the tenant's `.env` and above whatever the process inherited;
 * `missing` is nowhere at all, which is a fact and not an error.
 */
export type SecretSource = "store" | "tenantEnv" | "process" | "missing";

/** One key, as a terminal or a console shows it: presence and provenance only. */
export type SecretListing = {
  key: string;
  present: boolean;
  source: SecretSource;
  /**
   * The store set this key and a lower tier also holds one (#504). The store
   * wins, and it says so out loud here and in a doctor warn — a silent win is
   * an operator editing a `.env` that changes nothing.
   */
  shadowed?: boolean;
  /** When the store entry was written, from the ledger. Never the value. */
  setAt?: string;
  /** Who wrote it: an address the relay stamped, or `local` for a shell. */
  by?: string;
  /**
   * Why a console may not set this key, or absent when it may. A sentence, not
   * a code: it is shown to the person who just tried.
   */
  unsettable?: string;
};

/** One tenant's keys. `error` replaces them when its config would not load. */
export type TenantSecrets = {
  /** The tenant's `repoSlug`, which is also the name a set request carries. */
  tenant: string;
  /** The tenant's directory, for a console that shows where this is. */
  path: string;
  /**
   * Why this tenant's keys are unknown, or null when they are known. A held
   * tenant, an unreadable config and a missing `repoSlug` all report
   * identically, because from here they are the same fact.
   */
  error: string | null;
  keys: readonly SecretListing[];
};

/**
 * Section 6 of the deployment report: every tenant's secrets as the deployment
 * itself reads them.
 *
 * It is the deployment that derives this, once, for the same reason it derives
 * a pipeline's state (#501): the settable set comes from loading each tenant's
 * work kinds, and nothing outside the container can do that. A console renders
 * what it is given.
 */
export type SecretsSection = {
  tenants: readonly TenantSecrets[];
  /** When this section last moved. */
  updatedAt: string;
};

/**
 * How a secret request ended, as the receipt says it (#503, #550). Two words,
 * and the walk stops at both:
 *
 *  - `written` — the store holds what was asked for. Not "the child is using
 *    it": pickup is a relaunch the supervisor performs on its own clock, and
 *    the report is where an operator watches that happen.
 *  - `refused` — the deployment declined. An off-catalogue key, a
 *    deployment-scope key, an envelope that would not open. The detail says
 *    which, in a sentence.
 *
 * A third word can still come back on the wire and it is not the deployment's:
 * `undelivered` is what the relay writes when the socket went away with the
 * request in flight (`RELAY_UNDELIVERED`). Nothing is queued and nothing is
 * replayed.
 */
export type SecretOutcome = "written" | "refused";

/**
 * What a `refused` or `written` receipt carries beyond its one word. The key and
 * the tenant come back so a console that fired two sets can tell the answers
 * apart, and `detail` is the sentence a person reads.
 */
export type SecretReceiptDetail = {
  tenant: string;
  key: string;
  /** The ledger entry this edit became, on a `written`. */
  editId?: string;
  detail: string;
};
