// Credential arm resolution — which token-supply strategy a deployment uses.
//
// Two arms:
//   pat   Each tenant carries its own fine-grained PAT as GH_TOKEN in its
//         `.env`. The supervisor scrubs the env between tenants so one child
//         never inherits another's secret (#61).
//   app   A single GitHub App private key at the deployment root mints a
//         short-lived installation token (ghs_…) per tenant at runtime. No
//         per-tenant GH_TOKEN is expected — its absence is the trigger.
//
// The resolver reads GH_APP_ID from the supplied env. That key is injected by
// the deployment operator at the root level; tenants never carry it. Its
// presence uniquely identifies the App arm without inferring from whether a
// GH_TOKEN happens to be set (the wrong approach: under the App arm it will
// never be set, so absence would always read as broken).
//
// This is the one resolver boot, doctor, and phoebe list all import — they
// cannot disagree about which arm is active.

export type CredentialArm = "pat" | "app";

/**
 * Resolve the deployment-level credential arm from the accessible environment.
 *
 * Presence of `GH_APP_ID` signals the App arm: a GitHub App private key at
 * the deployment root mints per-tenant installation tokens at runtime, so no
 * `GH_TOKEN` in a tenant's `.env` is expected or needed.
 *
 * Absence falls back to the PAT arm: each tenant must carry its own
 * `GH_TOKEN`. A missing token on the PAT arm is a real configuration shortfall.
 */
export function resolveCredentialArm(env: Record<string, string | undefined>): CredentialArm {
  const appId = env["GH_APP_ID"];
  return typeof appId === "string" && appId.trim().length > 0 ? "app" : "pat";
}
