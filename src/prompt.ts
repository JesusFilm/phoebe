// Prompt template rendering: {{KEY}} argument substitution plus !`command`
// shell expansion, executed in the work unit's worktree. The marker trick is
// ported from Sandcastle's PromptPreprocessor: shell blocks present in the raw
// template are marked *before* argument substitution, so `!`...`` patterns
// arriving via substituted values are treated as data, never executed.
//
// Prompt file paths (`config.promptFiles.*`) resolve against the runtime root
// (process cwd) — the consumer checkout on the host, `/etc/phoebe` in the
// container where compose mounts `phoebe.config.ts` and `prompts/`. They do
// not walk the installed package; `phoebe init` copies shipped prompts into
// the runtime root for that reason.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PhoebeConfig, PromptFilesConfig } from "./config-schema.ts";
import { validateWorkOrder, type WorkKindName } from "./orchestrator.ts";

export type PromptArgs = Record<string, string>;

/** Where a `promptFiles.*` entry lands: absolute as-is, relative off the root. */
function promptFilePath(promptPath: string, runtimeRoot: string): string {
  return isAbsolute(promptPath) ? promptPath : resolve(runtimeRoot, promptPath);
}

/**
 * The `promptFiles` key each work kind dispatches with — the pairing main.ts
 * makes at every `promptFile:` call site, named once so the startup check can
 * ask "which prompts does this tenant's `workOrder` actually need?".
 */
const PROMPT_KEY_FOR_WORK_KIND: Record<WorkKindName, keyof PromptFilesConfig> = {
  conflicts: "conflict",
  checks: "checks",
  reviews: "reviews",
  issues: "issue",
  research: "research",
};

/**
 * Boot-time check that every prompt this tenant can dispatch names a file that
 * exists.
 *
 * Prompt loading is otherwise fail-at-use: a tenant whose asset dir is missing
 * one kind boots clean, polls happily, and only dies weeks later when the first
 * unit of that kind is dispatched — a hand-copied asset dir that never received
 * `research-prompt.md` stayed broken for months that way (#164). Called once at
 * engine startup, this turns that into a startup failure naming the tenant and
 * every missing kind at once.
 *
 * Scoped to `workOrder`, because that is what makes it a *caught* failure rather
 * than a new one: a kind the tenant dropped is never dispatched, so its prompt
 * being absent breaks nothing and must not refuse a boot.
 *
 * Existence is the whole rule — an entry is free to point outside the runtime
 * root (`../prompts/…` is how a `configDir` tenant reaches its repo's own
 * prompts instead of duplicating them), and absolute entries are checked as-is.
 */
export function assertPromptFilesExist(
  config: PhoebeConfig,
  runtimeRoot: string,
  workKinds: readonly WorkKindName[] = validateWorkOrder(config.workOrder),
): void {
  const missing: string[] = [];
  for (const kind of workKinds) {
    const key = PROMPT_KEY_FOR_WORK_KIND[kind];
    const promptPath = config.promptFiles[key];
    const absolute = promptFilePath(promptPath, runtimeRoot);
    if (!existsSync(absolute)) missing.push(`  ${key}: ${promptPath} → ${absolute}`);
  }
  if (missing.length === 0) return;
  throw new Error(
    `Tenant ${config.repoSlug} is missing ${missing.length} prompt file(s), resolved from ` +
      `runtime root ${runtimeRoot}:\n${missing.join("\n")}\n` +
      `Add the file(s), or point the matching \`promptFiles\` key at a path that exists.`,
  );
}

/**
 * Resolve a `promptFiles.*` path against the runtime root. Absolute paths are
 * used as-is; relative paths join to `runtimeRoot`. Throws when the file is
 * missing — never falls back into the installed package tree.
 */
export function resolvePromptFile(promptPath: string, runtimeRoot: string): string {
  const absolute = promptFilePath(promptPath, runtimeRoot);
  if (!existsSync(absolute)) {
    throw new Error(
      `Could not find prompt file ${promptPath} (resolved to ${absolute} from runtime root ${runtimeRoot})`,
    );
  }
  return absolute;
}

/** Read a prompt template from a path relative to (or absolute under) the runtime root. */
export function loadPromptTemplate(promptPath: string, runtimeRoot: string): string {
  return readFileSync(resolvePromptFile(promptPath, runtimeRoot), "utf8");
}

/**
 * The standard placeholder set every default prompt template can reference —
 * derived once per run from the resolved config so callers can retarget the
 * toolchain by editing `phoebe.config.ts` alone. Per-callsite args
 * (`ISSUE_NUMBER`, `PR_NUMBER`, …) are merged on top by `runAgentInWorktree`.
 */
export function buildDefaultPromptArgs(config: PhoebeConfig): PromptArgs {
  return {
    INSTALL_COMMAND: config.installCommand,
    CHECK_COMMAND: config.checkCommand,
    TEST_COMMAND: config.testCommand,
    READY_COMMAND: config.readyCommand,
    DEFAULT_BRANCH: config.defaultBranch,
    BRANCH_PREFIX: config.branchPrefix,
    READY_LABEL: config.readyLabel,
    RESEARCH_LABEL: config.researchLabel,
    PROCESSING_LABEL: config.processingLabel,
    REVIEWS_SUCCESS_HEADING: config.reviewsSuccessHeading,
  };
}

/**
 * Marker inserted between `!` and the opening backtick for shell blocks that
 * appear in the raw template. Only marked blocks are executed.
 */
const SHELL_BLOCK_MARKER = "\x01";

const SHELL_BLOCK_PATTERN = /!`([^`]+)`/g;
const MARKED_SHELL_BLOCK_PATTERN = new RegExp(`!${SHELL_BLOCK_MARKER}\`([^\`]+)\``, "g");
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function substitutePromptArgs(template: string, args: PromptArgs): string {
  const marked = template.replace(SHELL_BLOCK_PATTERN, (_m, cmd: string) => {
    return `!${SHELL_BLOCK_MARKER}\`${cmd}\``;
  });
  return marked.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    const value = args[key];
    if (value === undefined) {
      throw new Error(`Prompt placeholder {{${key}}} has no value.`);
    }
    return value;
  });
}

/** Execute marked shell blocks and splice their trimmed stdout into the prompt. */
export function expandShellBlocks(prompt: string, execShell: (command: string) => string): string {
  return prompt
    .replace(MARKED_SHELL_BLOCK_PATTERN, (_m, command: string) => {
      return execShell(command).trimEnd();
    })
    .replaceAll(SHELL_BLOCK_MARKER, "");
}

export function renderPrompt(
  template: string,
  args: PromptArgs,
  execShell: (command: string) => string,
): string {
  return expandShellBlocks(substitutePromptArgs(template, args), execShell);
}
