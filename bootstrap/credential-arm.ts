// The credential-arm resolver — one function, shared by boot, `phoebe list`,
// `doctor`, and the preflight so no surface can silently diverge (#162).
//
// Two arms:
//   pat   An explicit, non-empty `GH_TOKEN` — the fine-grained PAT arm.
//         Authentication is one line in the tenant's `.env`. The supervisor
//         scrubs the env between tenants so one child never inherits another's
//         secret (#61).
//   app   No explicit token, and the deployment carries a GitHub App key
//         (`GH_APP_ID` / `GH_APP_PRIVATE_KEY`, read by `github-app.ts`). A
//         short-lived installation token (ghs_…) is minted per tenant at
//         runtime; no per-tenant `GH_TOKEN` is expected.
//
// The rule composes two scopes, exactly as #162's handoff states it: an
// explicit `GH_TOKEN` ⇒ `pat`, else App vars present ⇒ `app`. The token is a
// *tenant* fact read from that tenant's `.env`; the App key is a *deployment*
// fact that lives only in the supervisor's env and is never copied per tenant.
// Both scopes are needed, which is why callers pass both — a resolver reading
// only the tenant env cannot see the App key, and one reading only the
// deployment env cannot honour #156's "an explicit token always wins".
//
// With neither an explicit token nor an App key the answer is `pat`: nothing
// can mint, so a missing `GH_TOKEN` is a genuine PAT-arm shortfall rather than
// a healthy App deployment. That is the distinction `doctor` reports on, and
// reading it as `app` would render every unconfigured tenant as healthy.
//
// `token` was rejected as the PAT arm's name because both arms end in a token
// and a child that only sees its own env cannot tell them apart — that
// indistinguishability is the whole point of the seam (#162).

// The same key `readAppCredentials` reads, so the arm a surface reports can
// never disagree with whether boot can actually mint.
import { GH_APP_ID_KEY } from "./github-app.ts";

export type CredentialArm = "pat" | "app";

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the credential arm in force for one tenant.
 *
 * @param env The tenant's own environment — its parsed `.env` in workspace
 *   mode, or the ambient env for a solo deployment (where the root *is* the
 *   tenant). A non-empty `GH_TOKEN` here selects `pat` and always wins.
 * @param deploymentEnv The supervisor's environment, which is where the App
 *   key lives. Defaults to `env` for solo, where the two are the same env.
 */
export function resolveCredentialArm(
  env: Record<string, string | undefined>,
  deploymentEnv: Record<string, string | undefined> = env,
): CredentialArm {
  if (isSet(env["GH_TOKEN"])) return "pat";
  return isSet(deploymentEnv[GH_APP_ID_KEY]) ? "app" : "pat";
}
