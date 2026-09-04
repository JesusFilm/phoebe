// Declared keys (#410/#425): the env a work kind names for itself.
//
// A kind that reads a credential out of the process env says so — `requiredEnv`
// names the keys its own code reads, `agentEnv` the subset its agent children
// may also see. Nothing here mints, stores or transports a secret: the tenant's
// one `.env` is still the only home, and a declaration is a statement about
// *reach*, which is what lets the supervisor take a key away from the rows that
// never asked for it (bootstrap/engine-child-env.ts) and lets a boot fail on an
// absence rather than a cycle failing on one.
//
// Deliberately not called a pipeline secret or a kind secret: a declared key is
// a key, declared. The engine never reads its value.

import type { AnyWorkKindDefinition } from "./definition.ts";

/**
 * Keys a kind may never declare, whatever it wants them for. Two families:
 * the GitHub credential and the bot login the engine mints and leases per row,
 * and the git identity every child commits under. Declaring one would put a
 * key the engine owns under a kind's control — and, worse, would let the
 * subtractive scrub take it away from a sibling row that needs it to work at
 * all.
 */
export const RESERVED_DECLARED_ENV_KEYS: readonly string[] = [
  "GH_TOKEN",
  "PHOEBE_GH_LOGIN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

/**
 * Why this key cannot be declared, in the operator's words — or null when it
 * can. `PHOEBE_*` is the engine's own knob namespace, `GH_APP_*` the App
 * credentials that mint the token no child ever holds, and a `providerEnv`
 * value is an agent API key whose reach `buildAgentEnv` already decides.
 */
export function reservedEnvReason(key: string, providerKeys: readonly string[]): string | null {
  if (RESERVED_DECLARED_ENV_KEYS.includes(key)) {
    return "the engine owns it — it is minted, leased or set per row";
  }
  if (key.startsWith("PHOEBE_")) return "`PHOEBE_*` is the engine's own knob namespace";
  if (key.startsWith("GH_APP_")) return "`GH_APP_*` are the App credentials no child holds";
  if (providerKeys.includes(key)) {
    return "it is a `providerEnv` key — the agent allowlist decides its reach";
  }
  return null;
}

/** Read a definition's `requiredEnv` / `agentEnv`, absent ⇒ empty. */
function declarationOf(
  definition: AnyWorkKindDefinition,
  field: "requiredEnv" | "agentEnv",
): readonly string[] {
  return definition[field] ?? [];
}

/**
 * Validate one definition's two declarations. Called from
 * `validateWorkKindDefinition`, so a built-in and a tenant-authored kind are
 * held to it identically.
 *
 * `agentEnv ⊆ requiredEnv` because the agent hop is an *opening* of a key the
 * kind already reads: a key named only in `agentEnv` would reach the agent
 * while the kind's own code could not see it, which is nobody's intent and
 * reads as a typo every time.
 */
export function validateDeclaredEnv(
  definition: AnyWorkKindDefinition,
  at: string,
  providerKeys: readonly string[],
): void {
  for (const field of ["requiredEnv", "agentEnv"] as const) {
    const declared: unknown = definition[field];
    if (declared === undefined) continue;
    if (!Array.isArray(declared) || declared.some((key) => typeof key !== "string")) {
      throw new Error(`${at}: the definition's \`${field}\` must be an array of env key names.`);
    }
    for (const key of declared as readonly string[]) {
      if (key.trim().length === 0) {
        throw new Error(`${at}: the definition's \`${field}\` names an empty env key.`);
      }
      const reason = reservedEnvReason(key, providerKeys);
      if (reason !== null) {
        throw new Error(
          `${at}: the definition's \`${field}\` names the reserved key \`${key}\` — ${reason}.`,
        );
      }
    }
  }
  const required = declarationOf(definition, "requiredEnv");
  for (const key of declarationOf(definition, "agentEnv")) {
    if (!required.includes(key)) {
      throw new Error(
        `${at}: the definition's \`agentEnv\` names \`${key}\`, which its \`requiredEnv\` does ` +
          `not. \`agentEnv\` opens a key the kind already reads; add it to \`requiredEnv\` first.`,
      );
    }
  }
}

/** One scheduled kind as the declared-key helpers read it. */
export type DeclaringKind = { name: string; definition: AnyWorkKindDefinition };

/**
 * The union of `requiredEnv` over these kinds, sorted and deduped — a row's
 * `env`, which is what the enumerator reports and the scrub subtracts against.
 * Sorted so two boots of one config produce the same list.
 */
export function declaredEnvKeys(kinds: readonly DeclaringKind[]): string[] {
  const keys = new Set<string>();
  for (const kind of kinds) {
    for (const key of declarationOf(kind.definition, "requiredEnv")) keys.add(key);
  }
  return [...keys].sort();
}

/** A key this kind declared and the env does not hold — blank counts as absent. */
export type MissingDeclaredKey = { kind: string; key: string };

/** Every declared key these kinds cannot read, in kind then declaration order. */
export function missingDeclaredEnv(
  kinds: readonly DeclaringKind[],
  env: Readonly<Record<string, string | undefined>>,
): MissingDeclaredKey[] {
  const missing: MissingDeclaredKey[] = [];
  for (const kind of kinds) {
    for (const key of declarationOf(kind.definition, "requiredEnv")) {
      const value = env[key];
      if (value === undefined || value.trim().length === 0) {
        missing.push({ kind: kind.name, key });
      }
    }
  }
  return missing;
}

/**
 * Boot check, in the posture of the prompt-file check (src/prompt.ts): a key a
 * scheduled kind declares and this row cannot read is a startup failure naming
 * every kind and key at once, not a cycle that fails once the kind's first unit
 * is dispatched. Scoped to the kinds the row schedules — a kind switched off
 * runs nothing, so its key being absent refuses no boot.
 */
export function assertDeclaredEnvPresent(opts: {
  repoSlug: string;
  pipeline: string;
  kinds: readonly DeclaringKind[];
  env: Readonly<Record<string, string | undefined>>;
}): void {
  const missing = missingDeclaredEnv(opts.kinds, opts.env);
  if (missing.length === 0) return;
  throw new Error(
    `Tenant ${opts.repoSlug} pipeline ${opts.pipeline} is missing ${missing.length} declared ` +
      `env key(s):\n${missing.map((m) => `  ${m.kind}: ${m.key}`).join("\n")}\n` +
      `Add the key(s) to this tenant's .env with a non-blank value, or take the kind out of ` +
      `rotation with \`kinds.<name>.disabled\`.`,
  );
}
