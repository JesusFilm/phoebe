// Which branches a PR janitor may work (#655) — the `prScope` field, read.
//
// `prScope` answers one question at two depths. The tenant says whose branches
// Phoebe's janitors touch at all; a `conflicts`, `checks` or `reviews` block
// says it again for that kind alone. Both take the same three spellings
// ({@link PrScope}): `"phoebe"`, `"all"`, or the literal list of admitted
// prefixes.
//
// Two shapes of read live here, and they are not the same question:
//
//   - {@link prScopeAdmits} is the filter itself, asked of one branch.
//   - {@link widestPrScope} is the union across the tenant and its kinds — what
//     the cycle's single `gh pr list` has to admit so that a kind which widened
//     its own scope can still see the PRs it widened for. The listing is shared
//     and the narrowing is per kind, in that order: list the union once, then
//     let each janitor turn away what its own scope does not admit.
//
// Env overrides stay enum-only on both rungs, which is why nothing here parses
// a list out of a variable. A prefix list is a durable policy decision about
// whose code Phoebe runs, and `PHOEBE_CHECKS_PR_SCOPE=renovate/,dependabot/`
// would have been that decision taken in a shell with no file to read it back
// from. The array is file-only and the docs say so.

import { workKindOverride, type PrScope, type WorkKindsField } from "./config-schema.ts";
import { kindEnvNames, readEnv, settingAt } from "./settings-catalogue.ts";

const PR_SCOPE_SETTING = settingAt("prScope");

/**
 * The values `PHOEBE_PR_SCOPE` and `PHOEBE_<KIND>_PR_SCOPE` take, read off the
 * catalogue rather than restated: the entry's `values` *is* what env accepts,
 * and the list form is the file's alternative to it.
 */
const PR_SCOPE_ENV_VALUES: readonly string[] = PR_SCOPE_SETTING.values ?? [];

/**
 * The prefixes a scope admits, with `"phoebe"` desugared against
 * `branchPrefix`. `null` is `"all"` — no prefix bounds it.
 */
export function admittedPrefixes(scope: PrScope, branchPrefix: string): readonly string[] | null {
  if (scope === "all") return null;
  if (scope === "phoebe") return [branchPrefix];
  return scope;
}

/** Whether `branch` is one this scope admits, matched the way `branchPrefix` matches. */
export function prScopeAdmits(scope: PrScope, branchPrefix: string, branch: string): boolean {
  const prefixes = admittedPrefixes(scope, branchPrefix);
  if (prefixes === null) return true;
  return prefixes.some((prefix) => branch.startsWith(prefix));
}

/**
 * One kind's `prScope`, on the ladder the other per-kind knobs use:
 *
 *   1. per-kind env    (`PHOEBE_CHECKS_PR_SCOPE`, enum-only)
 *   2. per-kind config (`kinds.checks.prScope`)
 *   3. the tenant's    `prScope` — which `PHOEBE_PR_SCOPE` has already written
 *      onto, since that leaf is an overlay setting
 *
 * A per-kind env value that is neither `phoebe` nor `all` is not an answer, so
 * the next rung is asked — the behaviour every validating reader here has.
 */
export function resolvePrScopeForKind(opts: {
  kind: string;
  env: NodeJS.ProcessEnv;
  workKinds: WorkKindsField;
  configValue: PrScope;
}): PrScope {
  const fromEnv = readEnv(opts.env, kindEnvNames(PR_SCOPE_SETTING, opts.kind))?.value;
  if (fromEnv !== undefined && PR_SCOPE_ENV_VALUES.includes(fromEnv)) return fromEnv as PrScope;
  return workKindOverride(opts.workKinds, opts.kind)?.prScope ?? opts.configValue;
}

/**
 * The narrowest scope that admits everything `scopes` do, together — the one
 * the shared PR listing filters on.
 *
 * `"all"` anywhere wins outright: a kind that scans every PR makes the listing
 * every PR. Otherwise the prefixes are unioned, each scope desugared against
 * `branchPrefix` first, so a tenant on `"phoebe"` with `checks` on
 * `["renovate/"]` lists both and lets the janitors sort it out.
 */
export function widestPrScope(scopes: readonly PrScope[], branchPrefix: string): PrScope {
  const prefixes = new Set<string>();
  for (const scope of scopes) {
    const admitted = admittedPrefixes(scope, branchPrefix);
    if (admitted === null) return "all";
    for (const prefix of admitted) prefixes.add(prefix);
  }
  return [...prefixes];
}
