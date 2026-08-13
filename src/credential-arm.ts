// The credential-arm resolver — one function, shared by boot, `phoebe list`,
// `doctor`, and the preflight so no surface can silently diverge.
//
// Two arms:
//   pat   An explicit, non-empty `GH_TOKEN` in the tenant env — the
//         fine-grained PAT arm.  Authentication is one line in `.env`.
//   app   No explicit token; the deployment reads `PHOEBE_GH_APP_ID` and
//         `PHOEBE_GH_APP_PRIVATE_KEY` from the deployment env-file and mints
//         per-tenant installation tokens from the App private key.
//
// The test is binary: token present → pat, anything else → app.  `token` was
// rejected as the PAT arm's name because both arms end in a token and a child
// that only sees its own env cannot tell them apart — that indistinguishability
// is the whole point of the seam (#162).

export type CredentialArm = "pat" | "app";

/**
 * Resolve which credential arm a tenant's env selects: an explicit, non-empty
 * `GH_TOKEN` yields `pat`; absent or blank yields `app`.
 */
export function resolveCredentialArm(env: Record<string, string | undefined>): CredentialArm {
  const token = env["GH_TOKEN"];
  return typeof token === "string" && token.length > 0 ? "pat" : "app";
}
