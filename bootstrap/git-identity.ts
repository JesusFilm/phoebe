// Bootstrapper-only `gitIdentity` reader (#199).
//
// Mirrors `config-dir.ts` / `engine-source.ts` / `workspace-source.ts`:
// `gitIdentity` is a bootstrapper concern the engine never reads
// (`resolveConfig` drops it, the same as `engine`/`workspace`/`configDir`). It
// declares how a repo's commits are attributed — "how should this repo's
// commits be signed?" is a property of the repo, not of whichever deployment
// happens to supervise it, so a `.env`-only answer means every deployment that
// adopts the repo has to re-state it.
//
// **The precedence ladder** (#161's objection, answered). With this field there
// are three channels; later wins:
//
//   1. the deployment-global base (`ENGINE_CHILD_BASE_KEYS` — the supervisor's
//      own `GIT_*`, shared by every tenant it supervises)
//   2. the App-mode bot fallback (`mintedEnv`, #161)
//   3. **`gitIdentity`** — this repo's own declaration
//   4. the tenant's co-located `.env` — this deployment's statement about
//      *this* tenant
//
// One sentence: the config field outranks everything said deployment-wide and
// is outranked by anything said about this tenant specifically. So no existing
// deployment's attribution moves — a `.env` that sets `GIT_AUTHOR_*` today still
// wins tomorrow — and a repo that declares nothing behaves byte-for-byte as it
// does now.
//
// Solo collapses channels 1 and 4 into one: the container's env *is* the single
// tenant's env-file, so it wins and the config only fills the gaps
// ({@link fillGitIdentityGaps}). That is the same rule read from the other end.
//
// Both halves are required. #161 established that the email must be *exact* for
// GitHub's commit→account linkage, so a name-only field would be a trap: it
// would look like it worked and quietly attribute nothing.

/** A repo's declared commit attribution. Both halves, always. */
export type GitIdentity = { name: string; email: string };

function fail(detail: string, got: unknown): never {
  throw new Error(
    `phoebe.config.ts \`gitIdentity\` ${detail} (got ${JSON.stringify(got)}). ` +
      `It must be \`{ name: "…", email: "…" }\` — both halves, and the email exactly ` +
      `as GitHub knows it, or the commits link to no account.`,
  );
}

/**
 * Validate an arbitrary `gitIdentity` value and return it normalized (trimmed).
 * Shared with the engine's `validateUserConfig` (src/config-schema.ts) so a
 * mistyped consumer config fails the same way at both entry points — the
 * `validateWorkspaceField` precedent (#128), which exists precisely so the two
 * readers cannot drift.
 */
export function validateGitIdentityField(value: unknown): GitIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("must be an object", value);
  }
  const { name, email } = value as { name?: unknown; email?: unknown };
  if (typeof name !== "string" || name.trim().length === 0) {
    fail("needs a non-empty `name`", name);
  }
  if (typeof email !== "string" || email.trim().length === 0) {
    fail("needs a non-empty `email`", email);
  }
  const trimmedEmail = email.trim();
  // Deliberately shallow: enough to catch a name pasted into the email slot or
  // a `Name <addr>` mash-up, not an RFC validator. GitHub is the real authority
  // on whether an address links to an account.
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmedEmail)) {
    fail("`email` must be a bare address like `12345+login@users.noreply.github.com`", email);
  }
  return { name: name.trim(), email: trimmedEmail };
}

/**
 * Extract the declared identity from a loaded config, or null when the field is
 * absent. A present but malformed value is a hard error — silently ignoring it
 * would attribute commits to whatever the deployment happened to set, which is
 * exactly what declaring the field was meant to stop.
 */
export function readGitIdentity(config: Record<string, unknown>): GitIdentity | null {
  const field = config["gitIdentity"];
  if (field === undefined) return null;
  return validateGitIdentityField(field);
}

/**
 * The declared identity as its four env vars, or `{}` when nothing is declared.
 * Author and committer are deliberately not separable: "how are this repo's
 * commits attributed" is one question, and the author/committer split is git
 * plumbing with no repo-scoped meaning.
 */
export function gitIdentityEnv(identity: GitIdentity | null | undefined): Record<string, string> {
  if (!identity) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/** What solo should spawn its engine child with, and what the env overrode. */
export type SoloIdentityEnv = {
  /**
   * The child's env — `base` with the identity vars it left unset filled from
   * the declaration — or null when nothing is declared, meaning the child
   * inherits the supervisor's env exactly as it always has.
   */
  env: Record<string, string | undefined> | null;
  /**
   * Identity vars the ambient env already set, so the declaration did not reach
   * the child. Boot logs these: a solo deployment that carries a leftover
   * `GIT_AUTHOR_NAME` would otherwise make a repo's declaration inert with
   * nothing said about it.
   */
  overridden: readonly string[];
};

/**
 * Solo's arm of the ladder. There is no deployment-global rung here: solo has
 * exactly one env-file, and it is *the tenant's* — the same `.env` a fleet
 * tenant carries co-located, which wins rung 4 there too. So it wins every
 * identity var it sets, per var (as a fleet tenant's `.env` overrides only the
 * keys it declares), and the declaration fills the rest.
 */
export function soloIdentityEnv(
  base: Record<string, string | undefined>,
  identity: GitIdentity | null | undefined,
): SoloIdentityEnv {
  if (!identity) return { env: null, overridden: [] };
  const env = { ...base };
  const overridden: string[] = [];
  for (const [key, value] of Object.entries(gitIdentityEnv(identity))) {
    const current = env[key];
    if (current === undefined || current === "") {
      env[key] = value;
    } else if (current !== value) {
      overridden.push(key);
    }
  }
  return { env, overridden };
}
