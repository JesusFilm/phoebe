// Which credential a tenant authenticates with. The resolver that decides it
// reads a GitHub App key out of the deployment env and so cannot live here
// (bootstrap/credential-arm.ts); the answer it returns rides in the deployment
// report, which a console renders (#532, map #497).

/**
 * `pat` — the tenant's own `GH_TOKEN`. `app` — no explicit token, and the
 * deployment mints a short-lived installation token for it per poll.
 */
export type CredentialArm = "pat" | "app";
