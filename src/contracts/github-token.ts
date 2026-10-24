// A GitHub token, checked against the repo it is for before it is saved.
//
// A fine-grained PAT cannot be read back: GitHub has no endpoint that says
// what a token may do. What it has is status codes, and scripts/verify-tenant-
// token.mjs turned those into a probe per grant that mutates nothing (every
// write probe aims at a target that does not exist). The companion runs the
// same five probes when a token is pasted into the setup steps, so the operator
// learns which checkbox they missed before the deployment 403s an hour in.
//
// Nothing here carries the token. The verdict names the grants and what each
// answered; the value went to main as an argument and was held for the call.

/** The five grants Phoebe needs, in the order the onboarding doc lists them. */
export type GithubGrantId = "metadata" | "contents" | "pull_requests" | "issues" | "actions";

/** One grant, as the probe read it. */
export type GithubGrant = {
  id: GithubGrantId;
  /** What the checkbox on GitHub's page is called, e.g. "Contents: Read and write". */
  label: string;
  /** Why Phoebe needs it. */
  why: string;
  /**
   * `granted` and `missing` are the two answers the probe can stand behind.
   * `unknown` is everything else: a rate limit, SSO in the way, GitHub down.
   * Never a colour, because a wrong red sends someone re-minting a token that
   * was fine.
   */
  state: "granted" | "missing" | "unknown";
  /** The status code and, for `unknown`, what the body said. */
  detail: string;
};

/** What the token's prefix says it is. Only the fine-grained PAT is what Phoebe is built for. */
export type GithubTokenKind = {
  id: "fine-grained" | "classic" | "installation" | "oauth" | "unknown";
  label: string;
  /** Something worth saying about this kind, or null for the one that fits. */
  note: string | null;
};

/** The whole reading. */
export type GithubTokenVerdict = {
  /** The `owner/repo` the probes ran against. */
  slug: string;
  kind: GithubTokenKind;
  grants: GithubGrant[];
  /** Every grant answered `granted`. */
  ok: boolean;
};
