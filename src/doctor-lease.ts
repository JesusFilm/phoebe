// Credential leases for a spawned `phoebe doctor` (#507 §5).
//
// Under the App arm a tenant's `.env` carries no `GH_TOKEN` — the supervisor
// mints an installation token per tenant and hands it to that tenant's engine
// child. Doctor, spawned as its own process, would find nothing, and `repo`,
// `labels` and `stray-members` would come back `unknown` on exactly the
// deployments that most need them answered.
//
// So the bootstrapper hands over the leases it already holds: the minted tokens
// in its cache, keyed by the tenant slug they were minted for, on the doctor
// child's env. One variable, one JSON object, never written to disk and never
// logged — the same channel and the same discipline as the minted `GH_TOKEN`
// an engine child is spawned with (bootstrap/engine-child-env.ts).
//
// A tenant that carries its own `GH_TOKEN` is not in here and does not need to
// be: doctor reads that tenant's `.env` itself, as its engine child would. And
// a manual `phoebe doctor` sets nothing, so it stays credential-free, which is
// what #507 §5 asks for.

/** The env var one deployment's leases ride on, from the bootstrapper to doctor. */
export const DOCTOR_LEASE_ENV = "PHOEBE_DOCTOR_LEASES";

/** Tenant slug (`owner/repo`) → the installation token leased for it. */
export type DoctorLeases = Record<string, string>;

/** Encode leases for the child's env. Empty in, empty string out — never `{}`. */
export function encodeDoctorLeases(leases: DoctorLeases): string {
  const entries = Object.entries(leases).filter(([slug, token]) => slug !== "" && token !== "");
  return entries.length === 0 ? "" : JSON.stringify(Object.fromEntries(entries));
}

/**
 * Read the leases off an env. Anything malformed is no leases at all: the
 * checks then report what they always reported for an App-arm tenant, which is
 * a report that says less rather than a report that says something wrong.
 */
export function parseDoctorLeases(value: string | undefined): DoctorLeases {
  if (value === undefined || value.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const leases: DoctorLeases = {};
  for (const [slug, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof token === "string" && token.length > 0) leases[slug] = token;
  }
  return leases;
}
