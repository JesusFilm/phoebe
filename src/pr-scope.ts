// Which open PRs each janitor scans (#656) — the `prScope` vocabulary.
//
// `prScope` was one tenant-wide enum, read in one place: the PR listing's
// filter. Two things made that too coarse. A tenant that wants Phoebe to chase
// a bot's red CI had to admit *every* same-repo branch to get it, and a tenant
// that wants `checks` wider than `reviews` had no way to say so. So the field
// gained an array arm — the literal set of admitted branch prefixes — and each
// PR janitor gained its own copy of the field, on the ladder every other
// per-kind knob already uses.
//
// That splits the one filter in two, because the three kinds share one listing:
//
//   - The **listing** admits the widest scope any janitor this engine child
//     runs asks for ({@link prScanListingScope}), which is what keeps one
//     `gh pr list` per base serving all three.
//   - Each **kind** narrows that listing to its own scope as it walks it
//     (src/work-kinds/pr-stack.ts), which is what makes the narrowing real.
//
// Admission is the only thing this module decides. Whether a branch is
// *Phoebe's* stays a `branchPrefix` question — the draft rule asks it — so
// admitting someone else's prefix never makes their drafts Phoebe's business.

import {
  workKindOverride,
  type PhoebeConfig,
  type PrScope,
  type WorkKindsField,
} from "./config-schema.ts";
import { kindEnvNames, readEnv, settingAt } from "./settings-catalogue.ts";

const PR_SCOPE_SETTING = settingAt("prScope");

/**
 * The kinds that scan open PRs, and so the only readers of a kind's `prScope`.
 * A subset of the built-ins rather than all of them: `issues` and `research`
 * are producers, and a scope on either would sit inert.
 */
export const PR_SCAN_KIND_NAMES = ["conflicts", "checks", "reviews"] as const;

/**
 * The prefixes a scope admits, or `"all"` for every same-repo branch.
 * `"phoebe"` is sugar for `[branchPrefix]`, spelled once here.
 */
export function prScopePrefixes(scope: PrScope, branchPrefix: string): "all" | readonly string[] {
  if (scope === "all") return "all";
  if (scope === "phoebe") return [branchPrefix];
  return scope;
}

/** Whether a scope admits a PR's head branch. */
export function prScopeAdmits(scope: PrScope, branch: string, branchPrefix: string): boolean {
  const prefixes = prScopePrefixes(scope, branchPrefix);
  return prefixes === "all" || prefixes.some((prefix) => branch.startsWith(prefix));
}

/**
 * One env name's value as a scope. Enum-only: an array has no `.env` spelling
 * an operator could be expected to guess, so a value outside the closed set
 * throws naming the variable that supplied it — the same answer the tenant-level
 * overlay gives, and the same shape `selectProviderForKind` gives an unknown
 * provider name.
 */
function readPrScopeEnv(env: NodeJS.ProcessEnv, names: readonly string[]): PrScope | undefined {
  const read = readEnv(env, names);
  if (read === undefined) return undefined;
  const values = PR_SCOPE_SETTING.values ?? [];
  if (!values.includes(read.value)) {
    throw new Error(
      `${read.via} must be one of ${values.join(", ")} (got "${read.value}"). ` +
        `A list of branch prefixes is a config-file value.`,
    );
  }
  return read.value as PrScope;
}

/**
 * One kind's PR scope:
 *
 *   1. per-kind env    (`PHOEBE_CHECKS_PR_SCOPE`)
 *   2. per-kind config (`kinds.checks.prScope`)
 *   3. the tenant's    `prScope`
 *
 * Two rungs rather than four, because `prScope` is written onto the config as it
 * is built (the catalogue's `overlay: "all"`): `configValue` is already
 * `PHOEBE_PR_SCOPE` over the file's value, and the kind block sits above both —
 * durable policy that a blanket env var does not push aside, which is the rule
 * the provider knobs and `runTimeoutMs` follow.
 */
export function resolvePrScopeForKind(opts: {
  kind: string;
  env: NodeJS.ProcessEnv;
  workKinds: WorkKindsField;
  configValue: PrScope;
}): PrScope {
  const perKind = readPrScopeEnv(opts.env, kindEnvNames(PR_SCOPE_SETTING, opts.kind));
  if (perKind !== undefined) return perKind;
  return workKindOverride(opts.workKinds, opts.kind)?.prScope ?? opts.configValue;
}

/**
 * The scope the shared PR listing runs on: the widest any of the three janitors
 * admits. A PR no kind would work is never listed, and one some kind would work
 * is listed once — the per-PR mergeability read the janitors make is memoized
 * per cycle, so the union is also what the cycle pays for.
 *
 * `workKinds` is this engine child's pipeline (src/pipeline.ts flattens it), so
 * a tenant that runs `checks` in a pipeline of its own gets a listing per child
 * scoped to the kinds that child actually runs.
 */
export function prScanListingScope(opts: {
  env: NodeJS.ProcessEnv;
  config: Pick<PhoebeConfig, "prScope" | "branchPrefix" | "workKinds">;
}): PrScope {
  const { env, config } = opts;
  const scopes = PR_SCAN_KIND_NAMES.map((kind) =>
    resolvePrScopeForKind({ kind, env, workKinds: config.workKinds, configValue: config.prScope }),
  );
  if (scopes.some((scope) => scope === "all")) return "all";
  const prefixes = new Set(
    scopes.flatMap((scope) => prScopePrefixes(scope, config.branchPrefix) as readonly string[]),
  );
  return [...prefixes];
}
