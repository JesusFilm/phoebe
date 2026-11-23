// The provider key (#886): the one credential every pipeline needs and, until
// now, the one nothing checked.
//
// `buildAgentEnv` forwards exactly one env var to an agent child, the one
// `providerEnv[provider]` names. When that var is unset the child gets no key,
// and the agent dies on its first unit with the CLI's own "Not logged in" — after
// a boot and a doctor run that both looked healthy. This module answers the
// question both of them now ask: for each kind a pipeline schedules, which
// provider will it run on, and can that provider sign in?
//
// Presence only. Whether the key is *valid* is not cheap or certain to check, and a
// gateway that ignores the value still needs it non-empty.
//
// One documented setup signs in with no key at all: Claude's on-disk login,
// `~/.claude/.credentials.json` (docs/claude-subscription-auth.md, Approach B).
// The agent child holds `HOME`, so the CLI finds that file, and a missing key
// beside it is not a fault.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PhoebeConfig, ProviderName } from "./config-schema.ts";
import { selectProviderForKind } from "./provider-selection.ts";

/**
 * The login file each provider CLI reads when it holds no key, relative to
 * `HOME`. Only the ones this repo documents: a provider absent here signs in
 * with its key or not at all, as far as these checks are concerned.
 */
export const PROVIDER_LOGIN_FILES: Partial<Record<ProviderName, string>> = {
  claude: join(".claude", ".credentials.json"),
};

/**
 * Whether a provider's login file is there: true or false when it was looked
 * for, null when it could not be (doctor on the host cannot see the container's
 * `HOME`).
 */
export type LoginFileProbe = (provider: ProviderName) => boolean | null;

/** Look for each provider's login file under `home`, the agent child's `HOME`. */
export function loginFileProbe(home: string | undefined): LoginFileProbe {
  return (provider) => {
    const file = PROVIDER_LOGIN_FILES[provider];
    if (file === undefined || home === undefined || home.length === 0) return false;
    return existsSync(join(home, file));
  };
}

/**
 * For a caller that cannot see the agent child's `HOME`: a provider with a login
 * file might have one, and one without cannot.
 */
export const unseenLoginFiles: LoginFileProbe = (provider) =>
  PROVIDER_LOGIN_FILES[provider] === undefined ? false : null;

/** The config fields provider selection and the key lookup read. */
export type ProviderKeyConfig = Pick<
  PhoebeConfig,
  | "defaultProvider"
  | "defaultModels"
  | "defaultEfforts"
  | "workKinds"
  | "providerEnv"
  | "model"
  | "effort"
>;

/** One scheduled kind, under the config its pipeline runs it with. */
export type ProviderKeyKind = {
  kind: string;
  /** How the kind is named in findings; the kind's own name when absent. */
  label?: string;
  config: ProviderKeyConfig;
};

/**
 * - `set`: the key holds a non-blank value.
 * - `login-file`: the key is unset, and the provider's login file is there.
 * - `unverifiable`: the key is unset, and the provider has a login file nobody
 *   could look for.
 * - `missing`: the key is unset and nothing else signs the agent in.
 */
export type ProviderKeyState = "set" | "login-file" | "unverifiable" | "missing";

/** One provider a pipeline's kinds run on, and whether it can sign in. */
export type ProviderKeyUse = {
  provider: ProviderName;
  /** The env var `providerEnv[provider]` names. */
  key: string;
  /** The kinds that run on it, in the order they were given. */
  kinds: string[];
  state: ProviderKeyState;
};

/**
 * Every provider these kinds run on, grouped, in first-use order. The provider
 * is resolved the way the engine resolves it for a unit
 * (`selectProviderForKind`), so a kind block's `provider` and a `PHOEBE_AGENT`
 * flip in `env` both count. Throws what that resolution throws on a provider
 * name outside the closed set.
 *
 * Never reads a value further than asking whether it is blank.
 */
export function providerKeyUses(opts: {
  kinds: readonly ProviderKeyKind[];
  env: Readonly<Record<string, string | undefined>>;
  loginFile: LoginFileProbe;
}): ProviderKeyUse[] {
  const uses = new Map<string, ProviderKeyUse>();
  for (const { kind, label, config } of opts.kinds) {
    const { provider } = selectProviderForKind({ kind, env: opts.env, config });
    const key = config.providerEnv[provider];
    // Grouped by provider *and* key: two pipelines can name different vars for
    // one provider, and each var is its own finding.
    const id = `${provider}\0${key}`;
    const existing = uses.get(id);
    if (existing !== undefined) {
      existing.kinds.push(label ?? kind);
      continue;
    }
    uses.set(id, {
      provider,
      key,
      kinds: [label ?? kind],
      state: keyState(provider, opts.env[key], opts.loginFile),
    });
  }
  return [...uses.values()];
}

function keyState(
  provider: ProviderName,
  value: string | undefined,
  loginFile: LoginFileProbe,
): ProviderKeyState {
  if (value !== undefined && value.trim().length > 0) return "set";
  const found = loginFile(provider);
  if (found === null) return "unverifiable";
  return found ? "login-file" : "missing";
}

/** One line naming a provider whose key is missing, shared by boot and doctor. */
export function describeMissingKey(use: ProviderKeyUse, envLabel: string): string {
  return (
    `providerEnv.${use.provider} names ${use.key}, which is unset in ${envLabel} ` +
    `(used by ${use.kinds.join(", ")})`
  );
}

/**
 * Boot check, in the posture of the declared-key check
 * (work-kinds/declared-env.ts): a scheduled kind whose provider cannot sign in
 * is a startup failure, not a run of units that each die on "Not logged in".
 */
export function assertProviderKeysPresent(opts: {
  repoSlug: string;
  pipeline: string;
  kinds: readonly ProviderKeyKind[];
  env: Readonly<Record<string, string | undefined>>;
  loginFile: LoginFileProbe;
}): void {
  const missing = providerKeyUses(opts).filter((use) => use.state === "missing");
  if (missing.length === 0) return;
  throw new Error(
    `Tenant ${opts.repoSlug} pipeline ${opts.pipeline} has no provider key:\n` +
      `${missing.map((use) => `  ${describeMissingKey(use, "this tenant's env")}`).join("\n")}\n` +
      `Every agent run would fail on "Not logged in". Set the key in this tenant's .env, ` +
      `or point providerEnv at the var that holds the credential.`,
  );
}
