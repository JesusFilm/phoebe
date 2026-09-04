// Definition validation (#350 Q5/Q7): required members present, functions are
// functions, `workspace` a known value. Built-in definitions pass through this
// too at registration — cheap, and it enforces the can't-tell-built-in-from-
// custom invariant mechanically. `at` carries the error voice: config-path for
// custom kinds (`workKinds.custom.<name>`), the built-in's name otherwise.

import { validateDeclaredEnv } from "./declared-env.ts";
import type { AnyWorkKindDefinition, WorkspaceMode } from "./definition.ts";

// Typed against the union so the runtime check and the compile-time mode can
// only drift in one direction: a value here that is not a mode fails to build.
const WORKSPACE_VALUES = [
  "worktree",
  "scratch",
  "readonly",
] as const satisfies readonly WorkspaceMode[];

function fail(at: string, problem: string): never {
  throw new Error(`${at}: ${problem}`);
}

export function validateWorkKindDefinition(
  candidate: unknown,
  at: string,
  /**
   * The tenant's `providerEnv` values, which the declared-key check treats as
   * reserved (#425). Passed by registry assembly, which is the only caller that
   * knows the resolved config; defaulting to none keeps the rest of the
   * validation callable without one.
   */
  providerKeys: readonly string[] = [],
): AnyWorkKindDefinition {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    fail(at, `a work-kind definition must be an object (got ${JSON.stringify(candidate)}).`);
  }
  const def = candidate as Record<string, unknown>;

  if (typeof def["name"] !== "string" || def["name"].length === 0) {
    fail(at, "the definition's `name` must be a non-empty string.");
  }
  if (typeof def["oneShotEligible"] !== "boolean") {
    fail(at, "the definition's `oneShotEligible` must be a boolean.");
  }
  if (typeof def["promptFile"] !== "string" || def["promptFile"].trim().length === 0) {
    fail(at, "the definition's `promptFile` must be a non-empty path string.");
  }
  if (!(WORKSPACE_VALUES as readonly string[]).includes(def["workspace"] as string)) {
    fail(
      at,
      `the definition's \`workspace\` must be one of: ${WORKSPACE_VALUES.join(", ")} ` +
        `(got ${JSON.stringify(def["workspace"])}).`,
    );
  }
  for (const knob of ["model", "effort"] as const) {
    if (def[knob] !== undefined && typeof def[knob] !== "string") {
      fail(at, `the definition's \`${knob}\` must be a string when present.`);
    }
  }

  const report = def["report"];
  if (typeof report !== "object" || report === null) {
    fail(at, "the definition's `report` must be an object with `noun` and `describe`.");
  }
  const reportRecord = report as Record<string, unknown>;
  if (typeof reportRecord["noun"] !== "string" || reportRecord["noun"].length === 0) {
    fail(at, "the definition's `report.noun` must be a non-empty string.");
  }
  if (typeof reportRecord["describe"] !== "function") {
    fail(at, "the definition's `report.describe` must be a function of the unit.");
  }
  if (reportRecord["idle"] !== undefined && typeof reportRecord["idle"] !== "function") {
    fail(at, "the definition's `report.idle` must be a function when present.");
  }

  for (const fn of ["fetch", "select", "run"] as const) {
    if (typeof def[fn] !== "function") {
      fail(at, `the definition's \`${fn}\` must be a function.`);
    }
  }

  const definition = candidate as AnyWorkKindDefinition;
  // Last, so the shape checks above have already run: the declared-key rules
  // (reserved names, `agentEnv ⊆ requiredEnv`) live in declared-env.ts, which
  // owns the vocabulary and raises in the same `at`-prefixed voice.
  validateDeclaredEnv(definition, at, providerKeys);
  return definition;
}
