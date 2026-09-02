// Shape of the repo-specific configuration the Phoebe engine runs against.
// The values live in ../phoebe.config.ts — the single file allowed to mention
// this repository. Engine modules (everything under src/) import the resolved
// config from ./resolved-config.ts and stay repo-agnostic;
// src/config-seam.test.ts enforces it.
//
// Two shapes live here. `PhoebeUserConfig` is what a consumer writes: only the
// unavoidable repo/toolchain fields are required; everything else is optional
// and filled from `CONFIG_DEFAULTS` by `resolveConfig()`. `PhoebeConfig` is the
// fully-resolved shape the engine sees at runtime — every field populated.

import { isAbsolute } from "node:path";

// One shared validator for the `workspace` block, owned by the bootstrapper
// (which must check it before the engine exists) and imported here so the two
// entry points cannot drift as the discovery arms grow (#128).
import { validateWorkspaceField } from "../bootstrap/workspace-source.ts";
// Same reason for `gitIdentity` (#199): the bootstrapper validates it before
// the engine exists, and the engine re-validates the consumer's config here.
import { validateGitIdentityField, type GitIdentity } from "../bootstrap/git-identity.ts";
import { derivePaths } from "./paths.ts";
// Type-only (erased at runtime, so no import cycle): the definition contract
// lives beside the registry in src/work-kinds/.
import type { AnyWorkKindDefinition } from "./work-kinds/definition.ts";

export const PROVIDER_NAMES = ["cursor", "claude", "codex"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

// The closed work-kind set. Owned here (rather than by the orchestrator, which
// re-exports it) because the `workKinds` config field is keyed by it and the
// orchestrator imports this module's resolved shape — the reverse import would
// be a cycle.
export const WORK_KIND_NAMES = ["conflicts", "checks", "reviews", "issues", "research"] as const;
export type WorkKindName = (typeof WORK_KIND_NAMES)[number];

/**
 * One work kind's agent override (#300): exactly these three knobs, each
 * optional, each falling back to the repo-level defaults when unset. The block
 * speaks for one provider — its own `provider`, else `defaultProvider` — and
 * its `model`/`effort` stay silent when a run's effective provider differs
 * (a `PHOEBE_AGENT` flip of a providerless block, or a `PHOEBE_<KIND>_AGENT`
 * flip of any block), so provider-specific model names never reach the wrong
 * CLI.
 */
export type WorkKindOverride = {
  provider?: ProviderName;
  model?: string;
  /**
   * String: pass that effort flag to the provider CLI.
   * `null`: clear any inherited effort — the kind runs with no effort flag even
   * when `defaultEfforts` names one for this provider.
   * Absent / `undefined`: fall through to the next rung of the resolution ladder.
   */
  effort?: string | null;
};

/**
 * One `workKinds.custom.<name>` declaration (#303/#350) — a tenant-authored
 * work kind the engine registers beside the built-ins. Three arms:
 *
 *   - an inline definition object (close over values in the config file;
 *     inline entries carry no `options`),
 *   - a path string — sugar for the zero-knob module case,
 *   - `{ module, options? }` — a module path plus tenant knobs, passed through
 *     unvalidated as `ctx.options` (the kind validates them).
 *
 * Module paths resolve against the config file's directory and must be
 * relative (`./`, `../`) or absolute: tenant configs load from a container
 * mount with no reachable `node_modules`, so a bare specifier can never
 * resolve. The module's `default` export is the definition, or a
 * `(config) => definition` factory — the same shape the built-ins use.
 */
export type CustomKindEntry =
  | AnyWorkKindDefinition
  | string
  | { module: string; options?: Record<string, unknown> };

/**
 * The `workKinds` field, widened for custom kinds (#350 Q10): `custom` stays
 * precisely typed; sibling keys loosen to an index signature so a tenant can
 * tune a custom kind with the same override block as a built-in without casts.
 * Runtime two-pass validation (`validateWorkKindsField`) remains the
 * authoritative typo net.
 */
export type WorkKindsField = {
  [kind: string]: WorkKindOverride | Record<string, CustomKindEntry> | undefined;
} & {
  custom?: Record<string, CustomKindEntry>;
};

/** Legal custom-kind names: env-safe lowercase, hyphens allowed, ≤32 chars. */
export const CUSTOM_WORK_KIND_NAME_RE = /^[a-z][a-z0-9-]*$/;
const CUSTOM_WORK_KIND_NAME_MAX = 32;

/**
 * The one reserved `workKinds` key that holds custom-kind declarations rather
 * than an override block. Named once so every read, guard, and validation pass
 * agrees on the spelling.
 */
export const CUSTOM_WORK_KINDS_KEY = "custom";

/** Keys no custom kind may claim: the built-ins plus the `custom` block itself. */
const RESERVED_WORK_KIND_KEYS: readonly string[] = [...WORK_KIND_NAMES, CUSTOM_WORK_KINDS_KEY];

/** The validated `custom` block of a `workKinds` field, or an empty record. */
export function customKindEntries(
  workKinds: WorkKindsField | undefined,
): Record<string, CustomKindEntry> {
  const custom = workKinds?.[CUSTOM_WORK_KINDS_KEY];
  if (custom === undefined) return {};
  return custom as Record<string, CustomKindEntry>;
}

/**
 * The override block declared for `kind`, typed past the widened field. Safe
 * because `custom` is a reserved key — no kind is ever named `custom`, so a
 * kind-keyed read can only land on an override block (or nothing).
 */
export function workKindOverride(
  workKinds: WorkKindsField,
  kind: string,
): WorkKindOverride | undefined {
  if (kind === CUSTOM_WORK_KINDS_KEY) return undefined;
  return workKinds[kind] as WorkKindOverride | undefined;
}

/**
 * Selects where the thin `phoebe boot` bootstrapper materializes the engine
 * from — a GitHub ref (branch/tag/SHA, defaulting to `main` on the shipped
 * engine repo) or a local mount. The engine itself never reads this: it is a
 * bootstrapper concern, resolved by `bootstrap/engine-source.ts`. It lives on
 * `PhoebeUserConfig` only so a consumer config that sets it still type-checks,
 * and `resolveConfig` deliberately drops it — it never reaches `PhoebeConfig`.
 */
export type EngineSourceField =
  | { source: "github"; ref?: string; repo?: string }
  | { source: "local" };

/**
 * Bootstrapper-only workspace discovery knobs (#83/#97/#128). Presence of this
 * block on the deployment-root config selects workspace mode; the block then
 * declares exactly one of two discovery arms. The engine never reads this: it
 * lives on `PhoebeUserConfig` so a consumer config that sets it still
 * type-checks, and `resolveConfig` deliberately drops it — it never reaches
 * `PhoebeConfig`.
 *
 * The union is the arms' mutual exclusion expressed in the type, so a config
 * declaring both fails to compile as well as failing `validateWorkspaceField`.
 */
export type WorkspaceField =
  | {
      /** Scan depth under the workspace root; omit ⇒ 1. */
      depth?: number;
      tenants?: never;
    }
  | {
      /**
       * The fleet, declared. Directory paths resolved against the workspace
       * root, in the order they should be supervised. Absolute and `..` entries
       * supervise repos outside the workspace checkout.
       */
      tenants: string[];
      depth?: never;
    };

// Re-exported for consumers who want to name the type; the shape is owned by
// the bootstrapper, which is the only reader (see the field doc below).
export type { GitIdentity };

/**
 * Host-CLI-only lifecycle commands (#189/#260). Literal shell strings, like
 * `installCommand`/`checkCommand`, not a runtime name — `podman compose …`,
 * `systemctl …`, or a different compose invocation all fit. Read only by
 * `phoebe start` / `phoebe stop` on the host; the engine never sees it (see the
 * field doc on {@link PhoebeUserConfig.deployment}).
 */
export type DeploymentField = {
  /** Bring the deployment up. Run by `phoebe start`. */
  startCommand: string;
  /** Drain and stop the deployment. Run by `phoebe stop`. */
  stopCommand: string;
  /**
   * Optional short-grace stop for `phoebe stop --now`.
   * When absent, `--now` falls back to `stopCommand`.
   */
  stopNowCommand?: string;
};

export type PromptFilesConfig = {
  issue: string;
  conflict: string;
  checks: string;
  reviews: string;
  research: string;
};

export type PathsConfig = {
  /** The private clone (origin hub). */
  repoDir: string;
  /** Per-unit git worktrees. */
  worktreesDir: string;
  /** Reserved per-tenant state (supervisor status.json, #73). */
  stateDir: string;
  /**
   * Root for `workspace: "scratch"` workspaces (#358) — one directory per
   * kind, cleared and recreated per run. On the tenant volume rather than
   * `/tmp` so it inherits per-tenant isolation and dies with the tenant's data.
   */
  scratchDir: string;
};

export type PhoebeConfig = {
  /** GitHub `owner/repo` slug, passed to every `gh -R` call. */
  repoSlug: string;
  /** HTTPS clone URL for the container's private clone. */
  repoUrl: string;
  /** Branch PRs target and worktrees base off (usually `main`). */
  defaultBranch: string;
  /** Prefix for agent branches; issue branches are `<prefix>issue-<n>`. */
  branchPrefix: string;
  /** Label marking issues Phoebe may pick up. */
  readyLabel: string;
  /** Label marking wayfinder research tickets the `research` work kind picks up. */
  researchLabel: string;
  /** Label the agent applies to an issue it has claimed and is working. */
  processingLabel: string;
  /**
   * Label a **parent** issue carries to say "my children land on one branch"
   * (#341). Children of an issue wearing it base off `<branchPrefix>feature-<n>`
   * instead of `defaultBranch`, and reach it through a single human-owned
   * integration PR. Phoebe never creates this label: like `readyLabel` it is a
   * human's deliberate gesture, so a repo that never adds it simply has no
   * feature branches.
   */
  featureLabel: string;
  /** Which open PRs the conflicts/checks/reviews work-kinds scan.
   *  "phoebe" = only branchPrefix branches. "all" = any same-repo PR. */
  prScope: "phoebe" | "all";
  /** Draft PR handling: "skip-non-phoebe" = drafts on non-Phoebe branches are
   *  off-limits; "skip-all" = never touch drafts; "include" = drafts are fair game. */
  draftPrs: "skip-non-phoebe" | "skip-all" | "include";
  /** PRs carrying this label are excluded from the PR scan in every mode. */
  prOptOutLabel: string;
  /** Shell command strings — toolchains differ per repo, so these are data. */
  installCommand: string;
  checkCommand: string;
  testCommand: string;
  /** The all-in-one gate the agent runs before pushing (e.g. `npm run ready`).
   *  Substituted into default prompts as `{{READY_COMMAND}}`. */
  readyCommand: string;
  /**
   * JavaScript-compatible regex source that matches an issue-blocker reference
   * in issue body text. Must expose the blocker issue number as capture group 1.
   * Compiled with the `gi` flags.
   */
  blockedByPattern: string;
  /**
   * JavaScript-compatible regex source that matches a hand-authored membership
   * declaration in issue body text — the fallback for `featureLabel` (#341)
   * when GitHub's native sub-issue link is absent, so an issue typed in a
   * browser can still join a feature. Must expose the parent issue number as
   * capture group 1. Compiled case-insensitively; the first match wins, and a
   * native parent link beats it wherever both are present.
   */
  partOfPattern: string;
  /**
   * Markdown heading the reviews agent must include when it posts its summary
   * comment. The orchestrator detects the summary by substring match on this
   * exact string, so it must be unique enough not to collide with other
   * comments. Substituted into the default reviews prompt as
   * `{{REVIEWS_SUCCESS_HEADING}}`.
   */
  reviewsSuccessHeading: string;
  /**
   * Prompt template paths, relative to the runtime root (process cwd —
   * consumer checkout on the host; `/etc/phoebe` in the container where
   * compose mounts config + `prompts/`). Absolute paths are accepted as-is.
   */
  promptFiles: PromptFilesConfig;
  /** Ordered work kinds, validated by the orchestrator at startup. */
  workOrder: readonly string[];
  defaultProvider: ProviderName;
  defaultModels: Record<ProviderName, string>;
  /**
   * Per-provider reasoning-effort level, e.g. `{ claude: "low" }`. Partial on
   * purpose: an unset provider passes no effort flag at all, so that CLI's own
   * default stands, and a provider whose CLI has no such knob ignores it.
   * Env-overridable for the active provider via `PHOEBE_EFFORT`.
   */
  defaultEfforts: Partial<Record<ProviderName, string>>;
  /**
   * Per-work-kind agent overrides (#300), e.g.
   * `{ reviews: { provider: "claude", model: "claude-haiku-4-5", effort: "low" } }`.
   * Each knob resolves independently, most specific wins: per-kind env
   * (`PHOEBE_REVIEWS_MODEL`) → this block → global env (`PHOEBE_MODEL`) → the
   * repo defaults above. A kind's block deliberately outranks the *global* env
   * vars: it is durable policy that survives a blanket `PHOEBE_AGENT` /
   * `PHOEBE_MODEL` override; only the kind-specific env var pushes it aside.
   * Blocks for kinds absent from `workOrder` are allowed and inert. `model` is an
   * unvalidated pass-through string. `effort` accepts a string (pass-through) or
   * `null` (explicit clear: suppress the effort flag even when `defaultEfforts`
   * names one for this provider) — the CLIs are the authority on string values.
   *
   * `workKinds.custom.<name>` declares tenant-authored kinds (#303); see
   * {@link CustomKindEntry}. Custom kinds are tuned by sibling blocks and
   * `PHOEBE_<KIND>_*` env vars exactly like built-ins (hyphens in a kind name
   * map to underscores in its env vars).
   */
  workKinds: WorkKindsField;
  /** Env var holding each provider's API key — the only key the agent child inherits. */
  providerEnv: Record<ProviderName, string>;
  /**
   * Whole-unit wall-clock budget in ms (#72). A fleet-protection backstop: a
   * hung unit that exceeds this has its agent subprocess killed so it cannot
   * hold the #59 concurrency slot forever. Env-overridable via
   * `PHOEBE_RUN_TIMEOUT_MS`. Default 45 min.
   */
  runTimeoutMs: number;
  /**
   * Consecutive unproductive runs before a unit is quarantined and escalated to
   * a human (#75, #367). Env-overridable via `PHOEBE_MAX_UNPRODUCTIVE_RUNS`
   * (or the deprecated alias `PHOEBE_MAX_UNIT_TIMEOUTS`). Default 3.
   */
  maxUnproductiveRuns: number;
  /**
   * Credit the issue author on issue-derived work (#198): when true, every
   * commit Phoebe pushes for an `issues` / `research` unit carries a
   * `Co-authored-by: <login> <id>+<login>@users.noreply.github.com` trailer
   * naming the human who filed the ticket, so the work their issue produced
   * lands on their contribution graph. Bots are never credited. Turn it off on
   * a repo where a drive-by reporter's name on agent-written code would read
   * as misattribution rather than credit. Default true.
   */
  creditIssueAuthor: boolean;
  /**
   * Whether the `conflicts` kind keeps a live feature branch current with
   * `defaultBranch` (#341), by merging it into the branch behind the feature's
   * integration PR. Off means a feature branch drifts until a human catches it
   * up. Global, not per-feature: `prOptOutLabel` on an integration PR already
   * takes one specific feature out of janitor scope. Default true.
   */
  featureBranchCatchUp: boolean;
  /**
   * Human off-switch for this tenant (#202). When `true`, the engine starts no
   * new work units; a unit already in flight finishes. Quarantine state is
   * cleared when disabled — no work means nothing to get stuck on, and a
   * re-enabled tenant should start clean. Distinct from quarantine, which is
   * Phoebe's own decision; this is the operator's.
   */
  disabled: boolean;
  /**
   * Per-tenant filesystem layout. Not user-supplied: derived from `repoSlug`
   * and the deployment data base by `resolveConfig` (see src/paths.ts, #58/#62).
   */
  paths: PathsConfig;
};

/**
 * User-facing shape of `phoebe.config.ts`. Only the five fields with no sane
 * cross-repo default are required; everything else is optional and filled from
 * `CONFIG_DEFAULTS` by `resolveConfig()`. Nested objects (`promptFiles`,
 * `defaultModels`, `defaultEfforts`, `providerEnv`) are merged key-by-key, so overriding one
 * provider's model or one prompt file does not force the caller to supply the
 * rest. `paths` is *not* here: it is derived from `repoSlug` (src/paths.ts).
 */
export type PhoebeUserConfig = {
  repoSlug: string;
  repoUrl: string;
  installCommand: string;
  checkCommand: string;
  testCommand: string;
  /** Bootstrapper-only engine source (see {@link EngineSourceField}). The
   *  engine ignores it; `resolveConfig` drops it. Omitted ⇒ github/main. */
  engine?: EngineSourceField;
  /**
   * Bootstrapper-only workspace discovery (see {@link WorkspaceField}).
   * Presence of this block selects workspace discovery mode (#83/#91); `depth`
   * is how many directory levels under the root to scan for child configs
   * (default 1 when omitted). The engine never reads it; `resolveConfig` drops
   * it the same way it drops `engine`.
   */
  workspace?: WorkspaceField;
  /**
   * Bootstrapper-only asset directory (#98). Relocates where this tenant's
   * co-located `.env` and prompt/asset files live to a subdirectory of the dir
   * holding this `phoebe.config.ts` — e.g. `configDir: ".phoebe"` reuses a
   * standalone deployment's `.phoebe/` folder instead of duplicating `.env` and
   * `prompts/` at the repo root. Default `"."` (co-located — today's behavior).
   *
   * Honored for fleet tenants (workspace children): the
   * supervisor reads the tenant `.env` from `<dir>/<configDir>/.env` and runs
   * the tenant's engine child with cwd `<dir>/<configDir>` (so relative
   * `promptFiles` resolve there), while still loading THIS config from `<dir>`.
   * The `phoebe.config.ts` itself must stay at `<dir>` — workspace discovery
   * skips dotfolders, so it cannot live inside `.phoebe/`. Must be a relative
   * path with no `..`. The engine never reads it; `resolveConfig` drops it.
   */
  configDir?: string;
  /**
   * Bootstrapper-only commit attribution (#199): how this repo's commits are
   * signed, declared by the repo rather than restated in every deployment's
   * `.env`. Both halves are required — #161 established that the email must be
   * exact for GitHub's commit→account linkage, so a name-only declaration would
   * look like it worked and attribute nothing — and the pair sets all four
   * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` vars.
   *
   * Omitted ⇒ commits carry whatever identity the deployment supplies (its env,
   * or the App arm's bot fallback), exactly as before this field existed. The
   * engine never reads it: it lives here so a consumer config that sets it still
   * type-checks, and `resolveConfig` drops it — the `engine`/`workspace`/
   * `configDir` precedent. The supervisor layers it into the engine child's env
   * above every deployment-wide default and below the tenant's own `.env`
   * (`bootstrap/engine-child-env.ts`).
   */
  gitIdentity?: GitIdentity;
  /**
   * Host-CLI-only lifecycle commands (#189/#260): literal shell strings that
   * bring the deployment up or down from the host. When absent (the default)
   * `phoebe start` / `phoebe stop` drive the scaffolded docker compose file.
   * When present, the compose driver is bypassed and the strings run via
   * `/bin/sh -c` with inherited stdio — exit 0 means success, non-zero means
   * failure. Compose-specific behaviours (state pre-checks, the
   * exited-immediately probe, killed-mid-run detection, env-file discovery,
   * `--build`) are not available on this path; the operator encodes drain grace
   * in `stopCommand` themselves. The engine never reads it: it lives here so a
   * consumer config that sets it still type-checks, and `resolveConfig` drops
   * it — the `engine`/`workspace`/`configDir` precedent.
   */
  deployment?: DeploymentField;
  defaultBranch?: string;
  branchPrefix?: string;
  readyLabel?: string;
  researchLabel?: string;
  processingLabel?: string;
  /** Opt-in label on a parent issue whose children share a feature branch (#341); default `phoebe:feature`. */
  featureLabel?: string;
  prScope?: PhoebeConfig["prScope"];
  draftPrs?: PhoebeConfig["draftPrs"];
  prOptOutLabel?: string;
  readyCommand?: string;
  blockedByPattern?: string;
  /** Regex for the `Part of #M` feature-membership fallback (#341); default `` String.raw`Part of\s+#(\d+)` ``. */
  partOfPattern?: string;
  reviewsSuccessHeading?: string;
  promptFiles?: Partial<PromptFilesConfig>;
  workOrder?: readonly string[];
  defaultProvider?: ProviderName;
  defaultModels?: Partial<Record<ProviderName, string>>;
  defaultEfforts?: Partial<Record<ProviderName, string>>;
  /** Per-work-kind overrides + custom kinds (#300/#303); see {@link PhoebeConfig.workKinds}. */
  workKinds?: WorkKindsField;
  providerEnv?: Partial<Record<ProviderName, string>>;
  /** Whole-unit wall-clock timeout in ms (#72); default 45 min. */
  runTimeoutMs?: number;
  /** Consecutive unproductive runs before a unit is quarantined (#75, #367); default 3. */
  maxUnproductiveRuns?: number;
  /** @deprecated Use maxUnproductiveRuns. */
  maxUnitTimeouts?: number;
  /** Co-author trailer for the issue author on issue-derived commits (#198); default true. */
  creditIssueAuthor?: boolean;
  /** Keep live feature branches current with the default branch (#341); default true. */
  featureBranchCatchUp?: boolean;
  /**
   * Human off-switch for this tenant (#202). When `true`, the engine starts no
   * new work. Hot — takes effect on the next engine cycle without a restart. A
   * run in flight finishes; existing quarantine state is cleared. Distinct from
   * quarantine (Phoebe's own decision). Default `false`.
   */
  disabled?: boolean;
};

/**
 * Engine defaults for every optional user field. These land in the resolved
 * config whenever the consumer's `phoebe.config.ts` omits them, so a minimal
 * consumer config only has to name the repo and its three toolchain commands.
 */
export const CONFIG_DEFAULTS = {
  defaultBranch: "main",
  branchPrefix: "phoebe/",
  readyLabel: "ready-for-agent",
  researchLabel: "wayfinder:research",
  processingLabel: "processing",
  featureLabel: "phoebe:feature",
  prScope: "phoebe" as const,
  draftPrs: "skip-non-phoebe" as const,
  prOptOutLabel: "ready-for-human",
  readyCommand: "npm run ready",
  blockedByPattern: String.raw`Blocked by\s+#(\d+)`,
  partOfPattern: String.raw`Part of\s+#(\d+)`,
  reviewsSuccessHeading: "## Review feedback addressed",
  promptFiles: {
    issue: "prompts/issues-prompt.md",
    conflict: "prompts/conflict-prompt.md",
    checks: "prompts/checks-prompt.md",
    reviews: "prompts/reviews-prompt.md",
    research: "prompts/research-prompt.md",
  } satisfies PromptFilesConfig,
  workOrder: ["conflicts", "checks", "reviews", "issues", "research"] as readonly string[],
  defaultProvider: "cursor" as ProviderName,
  defaultModels: {
    cursor: "composer-2.5",
    claude: "claude-sonnet-4-6",
    codex: "gpt-5.4-mini",
  } satisfies Record<ProviderName, string>,
  // Empty on purpose: no effort flag is passed unless a consumer asks for one,
  // so every provider CLI keeps its own default until told otherwise.
  defaultEfforts: {} satisfies Partial<Record<ProviderName, string>>,
  // Empty on purpose too: every kind runs on the repo-level defaults until a
  // consumer singles one out (#300).
  workKinds: {} satisfies WorkKindsField,
  providerEnv: {
    cursor: "CURSOR_API_KEY",
    claude: "ANTHROPIC_API_KEY",
    codex: "OPENAI_KEY",
  } satisfies Record<ProviderName, string>,
  // 45 min: comfortably fits install(≤10) + a long agent run + test(≤10) + push,
  // so hitting it means "actually stuck", not "slow" (#72).
  runTimeoutMs: 2_700_000,
  // Matches the house number for consecutive-failures-before-escalation (#75).
  maxUnproductiveRuns: 3,
  // Applying `readyLabel` is a maintainer's deliberate act, so on by default:
  // the credit follows work a maintainer already chose to run (#198).
  creditIssueAuthor: true,
  featureBranchCatchUp: true,
  disabled: false,
} as const;

const REQUIRED_USER_FIELDS = [
  "repoSlug",
  "repoUrl",
  "installCommand",
  "checkCommand",
  "testCommand",
] as const satisfies readonly (keyof PhoebeUserConfig)[];

/**
 * Count the numbered capture groups defined by a regex source. We compile it
 * with an added empty alternative (`|`) so the resulting regex always matches
 * the empty string; the match array's length minus one then equals the number
 * of capture groups, regardless of whether the original pattern would have
 * matched anything on its own. Escaped parens, non-capturing groups (`(?:…)`),
 * lookarounds, and named groups are handled correctly because we're asking
 * the engine's own group count, not parsing the source ourselves.
 */
function countCaptureGroups(source: string): number {
  const compiled = new RegExp(`${source}|`);
  const match = compiled.exec("");
  // The extra `|` guarantees a match against ""; TS still narrows to nullable.
  if (!match) {
    return 0;
  }
  return match.length - 1;
}

/**
 * Both issue-reference patterns are read the same way — compiled from the
 * consumer's string, with `match[1]` taken as an issue number — so both are
 * rejected the same way: an uncompilable source, or one with no capture group,
 * would silently break the path that reads it rather than failing at load.
 */
function validateIssueRefPattern(
  field: "blockedByPattern" | "partOfPattern",
  pattern: string,
  detail: { reads: string; example: string },
): void {
  try {
    new RegExp(pattern, "gi");
  } catch (err) {
    throw new Error(`phoebe.config.ts ${field} is not a valid regex: ${(err as Error).message}`);
  }
  if (countCaptureGroups(pattern) < 1) {
    throw new Error(
      `phoebe.config.ts ${field} must define capture group 1 for the ` +
        `${detail.reads}. Wrap the number portion in parentheses, ` +
        `e.g. String.raw\`${detail.example}\`.`,
    );
  }
}

/**
 * Throw when a required field is missing or blank, or when `blockedByPattern`
 * or `partOfPattern` is not a valid regex or fails to expose an issue number as
 * capture group 1. Both are read as `match[1]`, so a pattern without a capture
 * group would silently break the path that reads it — the blocker walk, or
 * feature membership — rather than failing here. Kept separate from
 * `resolveConfig` so consumers or tests can validate a config independent of
 * the defaults merge.
 *
 * Workspace-root configs carry a `workspace` block in place of the five tenant
 * fields and are exempt from that check — the block's presence is the canonical
 * mode selector, and declaring both is rejected by `validateWorkspaceField`.
 */
export function validateUserConfig(user: PhoebeUserConfig): void {
  if (user.workspace === undefined) {
    const missing = REQUIRED_USER_FIELDS.filter((key) => {
      const value = user[key];
      return typeof value !== "string" || value.trim().length === 0;
    });
    if (missing.length > 0) {
      throw new Error(
        `phoebe.config.ts is missing required field(s): ${missing.join(", ")}. ` +
          `Only these five fields are required — the engine fills the rest from its defaults.`,
      );
    }
  }
  if (user.blockedByPattern !== undefined) {
    validateIssueRefPattern("blockedByPattern", user.blockedByPattern, {
      reads: "blocker issue number (parseBlockedBy reads match[1])",
      example: String.raw`Blocked by\s+#(\d+)`,
    });
  }
  if (user.partOfPattern !== undefined) {
    validateIssueRefPattern("partOfPattern", user.partOfPattern, {
      reads: "parent issue number (parsePartOf reads match[1])",
      example: String.raw`Part of\s+#(\d+)`,
    });
  }
  if (user.workKinds !== undefined) {
    validateWorkKindsField(user.workKinds);
  }
  if (user.workspace !== undefined) {
    validateWorkspaceField(user.workspace);
  }
  if (user.configDir !== undefined) {
    validateConfigDir(user.configDir);
  }
  if (user.gitIdentity !== undefined) {
    validateGitIdentityField(user.gitIdentity);
  }
  if (user.deployment !== undefined) {
    validateDeploymentField(user.deployment);
  }
}

/**
 * Read the validated host-CLI-only `deployment` block off a loaded user config,
 * or `undefined` when there is none. `phoebe start` / `phoebe stop` run before
 * `resolveConfig` — and `resolveConfig` drops the block anyway — so they read it
 * through here and get the same validation a resolved config would have applied.
 * The `readEngineSource` precedent for the other host-side-only field.
 */
export function readDeploymentField(user: {
  deployment?: DeploymentField;
}): DeploymentField | undefined {
  if (user.deployment === undefined) return undefined;
  validateDeploymentField(user.deployment);
  return user.deployment;
}

/**
 * Reject a malformed custom-kind declaration's *shape* (#350): its name, which
 * of the three entry arms it is, wrapper fields, and path form. Definition
 * members (functions present, workspace known) are validated later, at
 * registry assembly, where path modules have been loaded too — this runs
 * synchronously inside `resolveConfig`, before any module import.
 */
function validateCustomKindEntry(name: string, entry: CustomKindEntry): void {
  const at = `phoebe.config.ts \`workKinds.custom.${name}\``;
  if (!CUSTOM_WORK_KIND_NAME_RE.test(name) || name.length > CUSTOM_WORK_KIND_NAME_MAX) {
    throw new Error(
      `phoebe.config.ts \`workKinds.custom\` names illegal kind "${name}". ` +
        `Custom kind names are lowercase \`[a-z][a-z0-9-]*\`, at most ` +
        `${CUSTOM_WORK_KIND_NAME_MAX} characters.`,
    );
  }
  if (RESERVED_WORK_KIND_KEYS.includes(name)) {
    throw new Error(
      `${at} collides with a reserved name. The built-in kinds ` +
        `(${WORK_KIND_NAMES.join(", ")}) and \`custom\` cannot be redeclared.`,
    );
  }

  const assertModulePath = (path: unknown): void => {
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new Error(`${at} must name a module path — got ${JSON.stringify(path)}.`);
    }
    if (!path.startsWith("./") && !path.startsWith("../") && !isAbsolute(path)) {
      throw new Error(
        `${at} names module "${path}", which is a bare specifier. Kind modules load ` +
          `from the tenant checkout, where no \`node_modules\` is reachable — use a ` +
          `path starting with \`./\`, \`../\`, or \`/\`, resolved against the config ` +
          `file's directory.`,
      );
    }
  };

  if (typeof entry === "string") {
    assertModulePath(entry);
    return;
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(
      `${at} must be an inline definition object, a module path string, or ` +
        `\`{ module, options? }\` — got ${JSON.stringify(entry)}.`,
    );
  }
  if ("module" in entry) {
    // The wrapper arm. Unknown wrapper fields are boot errors — no inert keys.
    for (const key of Object.keys(entry)) {
      if (key !== "module" && key !== "options") {
        throw new Error(
          `${at} names unknown wrapper field "${key}". A module entry holds only ` +
            `\`module\` and \`options\`.`,
        );
      }
    }
    assertModulePath((entry as { module: unknown }).module);
    const options = (entry as { options?: unknown }).options;
    // A plain record, as documented: class instances (a Date, a Map) would
    // survive this boot check only to surprise the kind reading `ctx.options`.
    const isPlainObject =
      typeof options === "object" &&
      options !== null &&
      !Array.isArray(options) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(options) as object | null);
    if (options !== undefined && !isPlainObject) {
      throw new Error(
        `${at}.options must be a plain object when present — got ${JSON.stringify(options)}.`,
      );
    }
    return;
  }
  // The inline-definition arm: member validation happens at registry assembly.
}

/**
 * Reject a malformed `workKinds` block (#300/#350) at boot, the same
 * throw-and-exit moment as every other config error: an unknown kind key would
 * sit inert forever (looking configured while doing nothing), and an unknown
 * provider value would bind the block to a provider that can never match.
 * `model` and `effort` are deliberately not validated — they are pass-through
 * strings and the provider CLIs are the authority on what they accept.
 *
 * Two-pass (#350 Q2): parse the `custom` block first, then validate sibling
 * keys against built-ins ∪ the declared custom names — so a custom kind is
 * tuned by a sibling override block exactly like a built-in.
 */
function validateWorkKindsField(workKinds: NonNullable<PhoebeUserConfig["workKinds"]>): void {
  if (typeof workKinds !== "object" || workKinds === null || Array.isArray(workKinds)) {
    throw new Error(
      `phoebe.config.ts \`workKinds\` must be an object keyed by work kind ` +
        `(${WORK_KIND_NAMES.join(", ")}) — got ${JSON.stringify(workKinds)}.`,
    );
  }

  // Pass 1: the `custom` block's shape.
  const custom = workKinds[CUSTOM_WORK_KINDS_KEY];
  const customNames: string[] = [];
  if (custom !== undefined) {
    if (typeof custom !== "object" || custom === null || Array.isArray(custom)) {
      throw new Error(
        `phoebe.config.ts \`workKinds.custom\` must be an object keyed by kind name — ` +
          `got ${JSON.stringify(custom)}.`,
      );
    }
    for (const [name, entry] of Object.entries(custom)) {
      validateCustomKindEntry(name, entry as CustomKindEntry);
      customNames.push(name);
    }
  }

  // Pass 2: sibling override blocks, against the widened name set.
  const legalKinds = [...WORK_KIND_NAMES, ...customNames];
  for (const [kind, block] of Object.entries(workKinds)) {
    if (kind === CUSTOM_WORK_KINDS_KEY) continue;
    if (!legalKinds.includes(kind)) {
      throw new Error(
        `phoebe.config.ts \`workKinds\` names unknown work kind "${kind}". ` +
          `Use one of: ${legalKinds.join(", ")}.`,
      );
    }
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      throw new Error(
        `phoebe.config.ts \`workKinds.${kind}\` must be an object with optional ` +
          `\`provider\`, \`model\`, \`effort\` — got ${JSON.stringify(block)}.`,
      );
    }
    // A block holds exactly the three knobs — an unknown key (a typo'd knob, a
    // hoped-for per-kind timeout) would sit inert forever, same failure mode as
    // an unknown kind key. `model` and `effort` values are not validated here:
    // `model` is a pass-through string, and `effort` accepts a string or null
    // (the explicit clear) — the provider CLIs are the authority on string values.
    for (const knob of Object.keys(block)) {
      if (!["provider", "model", "effort"].includes(knob)) {
        throw new Error(
          `phoebe.config.ts \`workKinds.${kind}\` names unknown knob "${knob}". ` +
            `Each block holds only \`provider\`, \`model\`, \`effort\`.`,
        );
      }
    }
    const provider = (block as WorkKindOverride).provider;
    if (provider !== undefined && !(PROVIDER_NAMES as readonly string[]).includes(provider)) {
      throw new Error(
        `phoebe.config.ts \`workKinds.${kind}.provider\` must be one of ` +
          `${PROVIDER_NAMES.join(", ")} (got ${JSON.stringify(provider)}).`,
      );
    }
  }
}

/**
 * Reject a malformed host-CLI-only `deployment` block. Both lifecycle commands
 * are required together — a start with no stop (or vice versa) would leave
 * `phoebe stop` silently falling back to a compose file the operator has
 * bypassed — and a blank string would run `/bin/sh -c ""` and report success.
 * Validated here so a mistyped consumer config fails at `resolveConfig` like
 * `configDir`/`gitIdentity` do, even though only the host CLI reads the value.
 */
function validateDeploymentField(deployment: DeploymentField): void {
  if (typeof deployment !== "object" || deployment === null || Array.isArray(deployment)) {
    throw new Error(
      `phoebe.config.ts \`deployment\` must be an object with \`startCommand\` and ` +
        `\`stopCommand\` (got ${JSON.stringify(deployment)}).`,
    );
  }
  const isBlank = (value: unknown): boolean =>
    typeof value !== "string" || value.trim().length === 0;
  const missing = (["startCommand", "stopCommand"] as const).filter((key) =>
    isBlank(deployment[key]),
  );
  if (missing.length > 0) {
    const named = missing.map((key) => `\`${key}\``).join(" and ");
    throw new Error(
      `phoebe.config.ts \`deployment\` requires non-empty ${named} — both are required ` +
        `together (got ${JSON.stringify(deployment)}).`,
    );
  }
  if (deployment.stopNowCommand !== undefined && isBlank(deployment.stopNowCommand)) {
    throw new Error(
      `phoebe.config.ts \`deployment.stopNowCommand\` must be a non-empty command when ` +
        `present — omit it to have \`phoebe stop --now\` fall back to \`stopCommand\` ` +
        `(got ${JSON.stringify(deployment.stopNowCommand)}).`,
    );
  }
}

/**
 * Reject a malformed bootstrapper-only `configDir`. It relocates a tenant's
 * asset directory (`.env`, prompts) to a subdirectory of the config's own dir,
 * so it must be a non-empty *relative* path that stays inside that dir — an
 * absolute path or a `..` segment would point the supervisor at another
 * tenant's (or the host's) secrets. Validated here so a mistyped consumer
 * config fails at `resolveConfig` like `workspace`/`blockedByPattern` do, even
 * though only the bootstrapper reads the value.
 */
function validateConfigDir(configDir: NonNullable<PhoebeUserConfig["configDir"]>): void {
  if (typeof configDir !== "string" || configDir.trim().length === 0) {
    throw new Error(
      `phoebe.config.ts \`configDir\` must be a non-empty relative path ` +
        `(got ${JSON.stringify(configDir)}).`,
    );
  }
  if (isAbsolute(configDir)) {
    throw new Error(
      `phoebe.config.ts \`configDir\` must be relative to the config's directory, ` +
        `not absolute (got ${JSON.stringify(configDir)}).`,
    );
  }
  if (configDir.split(/[/\\]/).some((segment) => segment === "..")) {
    throw new Error(
      `phoebe.config.ts \`configDir\` must stay within the tenant directory — ` +
        `no ".." segments (got ${JSON.stringify(configDir)}).`,
    );
  }
}

/**
 * Merge a user config with `CONFIG_DEFAULTS` and return the fully-populated
 * shape the engine runs against. Nested records are shallow-merged so partial
 * overrides (one prompt file, one provider's env var, etc.) work as expected.
 *
 * `paths` is *derived*, not merged: it comes from `repoSlug` and the deployment
 * data base (`opts.dataBase`, default `/data/repos`; the CLI threads
 * `PHOEBE_DATA_DIR` through — see src/paths.ts, #58/#62), so a tenant's on-disk
 * layout is a function of its slug and can never drift from it.
 */
export function resolveConfig(
  user: PhoebeUserConfig,
  opts: { dataBase?: string } = {},
): PhoebeConfig {
  validateUserConfig(user);
  return {
    repoSlug: user.repoSlug,
    repoUrl: user.repoUrl,
    installCommand: user.installCommand,
    checkCommand: user.checkCommand,
    testCommand: user.testCommand,
    defaultBranch: user.defaultBranch ?? CONFIG_DEFAULTS.defaultBranch,
    branchPrefix: user.branchPrefix ?? CONFIG_DEFAULTS.branchPrefix,
    readyLabel: user.readyLabel ?? CONFIG_DEFAULTS.readyLabel,
    researchLabel: user.researchLabel ?? CONFIG_DEFAULTS.researchLabel,
    processingLabel: user.processingLabel ?? CONFIG_DEFAULTS.processingLabel,
    featureLabel: user.featureLabel ?? CONFIG_DEFAULTS.featureLabel,
    prScope: user.prScope ?? CONFIG_DEFAULTS.prScope,
    draftPrs: user.draftPrs ?? CONFIG_DEFAULTS.draftPrs,
    prOptOutLabel: user.prOptOutLabel ?? CONFIG_DEFAULTS.prOptOutLabel,
    readyCommand: user.readyCommand ?? CONFIG_DEFAULTS.readyCommand,
    blockedByPattern: user.blockedByPattern ?? CONFIG_DEFAULTS.blockedByPattern,
    partOfPattern: user.partOfPattern ?? CONFIG_DEFAULTS.partOfPattern,
    reviewsSuccessHeading: user.reviewsSuccessHeading ?? CONFIG_DEFAULTS.reviewsSuccessHeading,
    promptFiles: { ...CONFIG_DEFAULTS.promptFiles, ...user.promptFiles },
    workOrder: user.workOrder ?? CONFIG_DEFAULTS.workOrder,
    defaultProvider: user.defaultProvider ?? CONFIG_DEFAULTS.defaultProvider,
    defaultModels: { ...CONFIG_DEFAULTS.defaultModels, ...user.defaultModels },
    defaultEfforts: { ...CONFIG_DEFAULTS.defaultEfforts, ...user.defaultEfforts },
    workKinds: { ...CONFIG_DEFAULTS.workKinds, ...user.workKinds },
    providerEnv: { ...CONFIG_DEFAULTS.providerEnv, ...user.providerEnv },
    runTimeoutMs: user.runTimeoutMs ?? CONFIG_DEFAULTS.runTimeoutMs,
    maxUnproductiveRuns:
      user.maxUnproductiveRuns ?? user.maxUnitTimeouts ?? CONFIG_DEFAULTS.maxUnproductiveRuns,
    creditIssueAuthor: user.creditIssueAuthor ?? CONFIG_DEFAULTS.creditIssueAuthor,
    featureBranchCatchUp: user.featureBranchCatchUp ?? CONFIG_DEFAULTS.featureBranchCatchUp,
    disabled: user.disabled ?? CONFIG_DEFAULTS.disabled,
    paths: derivePaths(user.repoSlug, opts.dataBase),
  };
}
