// The work-kind registry (#348 Q7): one map the engine walks, assembled at
// boot from the five built-in factories plus whatever custom kinds the tenant
// declared. After assembly the engine cannot tell built-in from custom — that
// invariant is the map's whole contract. `WORK_KIND_NAMES` stays the primitive
// in config-schema.ts (the import-cycle reason its comment documents); the
// assertion below pins registry keys ≡ names.

import {
  WORK_KIND_NAMES,
  workKindOverride,
  type PhoebeConfig,
  type WorkKindName,
} from "../config-schema.ts";
import type { AnyWorkKindDefinition } from "./definition.ts";
import { validateWorkKindDefinition } from "./validate.ts";
import { conflictsKind } from "./conflicts.ts";
import { checksKind } from "./checks.ts";
import { reviewsKind } from "./reviews.ts";
import { issuesKind } from "./issues.ts";
import { researchKind } from "./research.ts";

/**
 * One registered kind: the (type-erased) definition plus the tenant's
 * `options` payload for it — extra fields from a `{ module, options }` wrapper
 * entry, `undefined` for built-ins and the other declaration arms.
 */
export type RegisteredWorkKind = {
  definition: AnyWorkKindDefinition;
  options: unknown;
};

export type WorkKindRegistry = ReadonlyMap<string, RegisteredWorkKind>;

/** A custom kind as the loader hands it to registry assembly. */
export type LoadedCustomKind = {
  name: string;
  definition: AnyWorkKindDefinition;
  options: unknown;
};

/**
 * The built-in modules export factories, invoked at boot registration so a
 * definition can bake config-flavored values (nouns, prompt paths) in — and
 * stay invisible post-registration, which is what keeps the invariant.
 */
export const BUILT_IN_WORK_KIND_FACTORIES: Record<
  WorkKindName,
  (config: PhoebeConfig) => AnyWorkKindDefinition
> = {
  conflicts: conflictsKind,
  checks: checksKind,
  reviews: reviewsKind,
  issues: issuesKind,
  research: researchKind,
};

/**
 * Assemble the registry: built-ins first, then the tenant's custom kinds.
 * Every definition — built-in, custom, or a built-in's replacement — passes
 * the same validation. A loaded kind bearing a built-in name is that
 * built-in's declared replacement module (#465): it takes the shipped
 * factory's slot, and the name's tuning knobs keep applying to it.
 */
export function buildRegistry(
  config: PhoebeConfig,
  customs: readonly LoadedCustomKind[] = [],
): WorkKindRegistry {
  const registry = new Map<string, RegisteredWorkKind>();
  // The keys a kind may not declare that only the config knows (#425): every
  // provider API key this tenant names. The rest of the reserved set is fixed
  // and lives in declared-env.ts.
  const providerKeys = Object.values(config.providerEnv);

  // A kind block's `promptFile` re-points whichever definition lands under that
  // name (#415), so the knob means the same thing for a custom kind as for a
  // built-in. Built-ins reach the same value through `config.promptFiles`,
  // which pipeline selection has already folded the block into; re-applying it here
  // is a no-op for them and the only path for a custom kind.
  const withDeclaredPrompt = (
    name: string,
    definition: AnyWorkKindDefinition,
  ): AnyWorkKindDefinition => {
    const declared = workKindOverride(config.workKinds, name)?.promptFile;
    return declared === undefined ? definition : { ...definition, promptFile: declared };
  };

  const replacements = new Map(
    customs
      .filter((custom) => (WORK_KIND_NAMES as readonly string[]).includes(custom.name))
      .map((custom) => [custom.name, custom]),
  );

  for (const name of WORK_KIND_NAMES) {
    const replacement = replacements.get(name);
    const at = replacement === undefined ? `built-in work kind "${name}"` : `kinds.${name}`;
    const definition = validateWorkKindDefinition(
      replacement?.definition ?? BUILT_IN_WORK_KIND_FACTORIES[name](config),
      at,
      providerKeys,
    );
    if (definition.name !== name) {
      throw new Error(`${at}: its definition names itself "${definition.name}", not "${name}".`);
    }
    registry.set(name, {
      definition: withDeclaredPrompt(name, definition),
      options: replacement?.options,
    });
  }

  for (const custom of customs) {
    if (replacements.has(custom.name)) continue;
    const at = `kinds.${custom.name}`;
    const definition = validateWorkKindDefinition(custom.definition, at, providerKeys);
    if (definition.name !== custom.name) {
      throw new Error(
        `${at}: the definition's \`name\` ("${definition.name}") must match its declaration key.`,
      );
    }
    registry.set(custom.name, {
      definition: withDeclaredPrompt(custom.name, definition),
      options: custom.options,
    });
  }

  return registry;
}
