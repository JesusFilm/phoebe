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
 * Every definition — built-in or not — passes the same validation; a custom
 * kind colliding with a built-in name is a boot error (shadowing built-ins is
 * out of scope in v1).
 */
export function buildRegistry(
  config: PhoebeConfig,
  customs: readonly LoadedCustomKind[] = [],
): WorkKindRegistry {
  const registry = new Map<string, RegisteredWorkKind>();

  // A kind block's `promptFile` re-points whichever definition lands under that
  // name (#415), so the knob means the same thing for a custom kind as for a
  // built-in. Built-ins reach the same value through `config.promptFiles`,
  // which row selection has already folded the block into; re-applying it here
  // is a no-op for them and the only path for a custom kind.
  const withDeclaredPrompt = (
    name: string,
    definition: AnyWorkKindDefinition,
  ): AnyWorkKindDefinition => {
    const declared = workKindOverride(config.workKinds, name)?.promptFile;
    return declared === undefined ? definition : { ...definition, promptFile: declared };
  };

  for (const name of WORK_KIND_NAMES) {
    const definition = validateWorkKindDefinition(
      BUILT_IN_WORK_KIND_FACTORIES[name](config),
      `built-in work kind "${name}"`,
    );
    if (definition.name !== name) {
      throw new Error(
        `built-in work kind "${name}": its definition names itself "${definition.name}".`,
      );
    }
    registry.set(name, { definition: withDeclaredPrompt(name, definition), options: undefined });
  }

  for (const custom of customs) {
    const at = `workKinds.custom.${custom.name}`;
    const definition = validateWorkKindDefinition(custom.definition, at);
    if (definition.name !== custom.name) {
      throw new Error(
        `${at}: the definition's \`name\` ("${definition.name}") must match its declaration key.`,
      );
    }
    if (registry.has(custom.name)) {
      throw new Error(
        `${at}: "${custom.name}" collides with a built-in work kind. ` +
          `Overriding built-ins is not supported — pick another name.`,
      );
    }
    registry.set(custom.name, {
      definition: withDeclaredPrompt(custom.name, definition),
      options: custom.options,
    });
  }

  return registry;
}
