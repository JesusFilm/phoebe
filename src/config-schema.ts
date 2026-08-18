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

export const PROVIDER_NAMES = ["cursor", "claude", "codex"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

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

/**
 * Bootstrapper-only commit attribution (#199): how this repo's commits are
 * signed, declared by the repo rather than restated in every deployment's
 * `.env`. Both halves are required — #161 established that the email must be
 * exact for GitHub's commit→account linkage, so a name-only declaration would
 * look like it worked and attribute nothing. It sets all four `GIT_AUTHOR_*` /
 * `GIT_COMMITTER_*` vars; author and committer are not separately expressible.
 *
 * The engine never reads it: it lives on `PhoebeUserConfig` so a consumer
 * config that sets it still type-checks, and `resolveConfig` drops it — the
 * `engine`/`workspace`/`configDir` precedent. The supervisor layers it into the
 * engine child's env above every deployment-wide default (the base allowlist,
 * the App-mode bot fallback) and below the tenant's own `.env`
 * (`bootstrap/engine-child-env.ts`).
 */
export type GitIdentityField = GitIdentity;

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
   * Consecutive per-unit timeouts before a unit is quarantined and escalated to
   * a human (#75). Env-overridable via `PHOEBE_MAX_UNIT_TIMEOUTS`. Default 3.
   */
  maxUnitTimeouts: number;
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
   * Bootstrapper-only commit attribution (see {@link GitIdentityField}, #199) —
   * `{ name, email }`, both required. Omitted ⇒ commits carry whatever identity
   * the deployment supplies (its env, or the App arm's bot fallback), exactly as
   * before this field existed. The engine never reads it; `resolveConfig` drops
   * it the same way it drops `engine`.
   */
  gitIdentity?: GitIdentityField;
  defaultBranch?: string;
  branchPrefix?: string;
  readyLabel?: string;
  researchLabel?: string;
  processingLabel?: string;
  prScope?: PhoebeConfig["prScope"];
  draftPrs?: PhoebeConfig["draftPrs"];
  prOptOutLabel?: string;
  readyCommand?: string;
  blockedByPattern?: string;
  reviewsSuccessHeading?: string;
  promptFiles?: Partial<PromptFilesConfig>;
  workOrder?: readonly string[];
  defaultProvider?: ProviderName;
  defaultModels?: Partial<Record<ProviderName, string>>;
  defaultEfforts?: Partial<Record<ProviderName, string>>;
  providerEnv?: Partial<Record<ProviderName, string>>;
  /** Whole-unit wall-clock timeout in ms (#72); default 45 min. */
  runTimeoutMs?: number;
  /** Consecutive timeouts before a unit is quarantined (#75); default 3. */
  maxUnitTimeouts?: number;
  /** Co-author trailer for the issue author on issue-derived commits (#198); default true. */
  creditIssueAuthor?: boolean;
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
  prScope: "phoebe" as const,
  draftPrs: "skip-non-phoebe" as const,
  prOptOutLabel: "ready-for-human",
  readyCommand: "npm run ready",
  blockedByPattern: String.raw`Blocked by\s+#(\d+)`,
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
  providerEnv: {
    cursor: "CURSOR_API_KEY",
    claude: "ANTHROPIC_API_KEY",
    codex: "OPENAI_KEY",
  } satisfies Record<ProviderName, string>,
  // 45 min: comfortably fits install(≤10) + a long agent run + test(≤10) + push,
  // so hitting it means "actually stuck", not "slow" (#72).
  runTimeoutMs: 2_700_000,
  // Matches the house number for consecutive-failures-before-escalation (#75).
  maxUnitTimeouts: 3,
  // Applying `readyLabel` is a maintainer's deliberate act, so on by default:
  // the credit follows work a maintainer already chose to run (#198).
  creditIssueAuthor: true,
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
 * Throw when a required field is missing or blank, or when `blockedByPattern`
 * is not a valid regex or fails to expose the blocker issue number as capture
 * group 1. `parseBlockedBy` reads `match[1]`, so a pattern without a capture
 * group would silently break the entire blocker-detection path — reject it up
 * front. Kept separate from `resolveConfig` so consumers or tests can validate
 * a config independent of the defaults merge.
 */
export function validateUserConfig(user: PhoebeUserConfig): void {
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
  if (user.blockedByPattern !== undefined) {
    try {
      new RegExp(user.blockedByPattern, "gi");
    } catch (err) {
      throw new Error(
        `phoebe.config.ts blockedByPattern is not a valid regex: ${(err as Error).message}`,
      );
    }
    if (countCaptureGroups(user.blockedByPattern) < 1) {
      throw new Error(
        `phoebe.config.ts blockedByPattern must define capture group 1 for the ` +
          `blocker issue number (parseBlockedBy reads match[1]). Wrap the number ` +
          `portion in parentheses, e.g. String.raw\`Blocked by\\s+#(\\d+)\`.`,
      );
    }
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
    prScope: user.prScope ?? CONFIG_DEFAULTS.prScope,
    draftPrs: user.draftPrs ?? CONFIG_DEFAULTS.draftPrs,
    prOptOutLabel: user.prOptOutLabel ?? CONFIG_DEFAULTS.prOptOutLabel,
    readyCommand: user.readyCommand ?? CONFIG_DEFAULTS.readyCommand,
    blockedByPattern: user.blockedByPattern ?? CONFIG_DEFAULTS.blockedByPattern,
    reviewsSuccessHeading: user.reviewsSuccessHeading ?? CONFIG_DEFAULTS.reviewsSuccessHeading,
    promptFiles: { ...CONFIG_DEFAULTS.promptFiles, ...user.promptFiles },
    workOrder: user.workOrder ?? CONFIG_DEFAULTS.workOrder,
    defaultProvider: user.defaultProvider ?? CONFIG_DEFAULTS.defaultProvider,
    defaultModels: { ...CONFIG_DEFAULTS.defaultModels, ...user.defaultModels },
    defaultEfforts: { ...CONFIG_DEFAULTS.defaultEfforts, ...user.defaultEfforts },
    providerEnv: { ...CONFIG_DEFAULTS.providerEnv, ...user.providerEnv },
    runTimeoutMs: user.runTimeoutMs ?? CONFIG_DEFAULTS.runTimeoutMs,
    maxUnitTimeouts: user.maxUnitTimeouts ?? CONFIG_DEFAULTS.maxUnitTimeouts,
    creditIssueAuthor: user.creditIssueAuthor ?? CONFIG_DEFAULTS.creditIssueAuthor,
    paths: derivePaths(user.repoSlug, opts.dataBase),
  };
}
