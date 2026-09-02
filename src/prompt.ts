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

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PhoebeConfig } from "./config-schema.ts";

export type PromptArgs = Record<string, string>;

/** Where a `promptFiles.*` entry lands: absolute as-is, relative off the root. */
function promptFilePath(promptPath: string, runtimeRoot: string): string {
  return isAbsolute(promptPath) ? promptPath : resolve(runtimeRoot, promptPath);
}

/**
 * Whether a resolved path is a prompt the engine could actually load. A regular
 * file, not merely something that exists: a *directory* passes an existence
 * check and then throws `EISDIR` when the work unit reads it — the fail-at-use
 * mode the startup check exists to remove. Follows symlinks, so a symlinked
 * prompt is fine.
 */
function isLoadablePromptFile(absolute: string): boolean {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/**
 * Boot-time check that every prompt this tenant can dispatch names a file the
 * engine could load.
 *
 * Prompt loading is otherwise fail-at-use: a tenant whose asset dir is missing
 * one kind boots clean, polls happily, and only dies weeks later when the first
 * unit of that kind is dispatched — a hand-copied asset dir that never received
 * `research-prompt.md` stayed broken for months that way (#164). Called once at
 * engine startup, this turns that into a startup failure naming the tenant and
 * every missing kind at once.
 *
 * `kinds` is the scheduled work order paired with each kind's definition-owned
 * `promptFile` (#303) — built-in and custom kinds check identically. Scoped to
 * `workOrder`, because that is what makes it a *caught* failure rather than a
 * new one: a kind the tenant dropped is never dispatched, so its prompt being
 * absent breaks nothing and must not refuse a boot.
 *
 * Being a loadable file is the whole rule — an entry is free to point outside
 * the runtime root (`../prompts/…` is how a `configDir` tenant reaches its
 * repo's own prompts instead of duplicating them), and absolute entries are
 * checked as-is.
 */
export function assertPromptFilesExist(opts: {
  repoSlug: string;
  runtimeRoot: string;
  kinds: ReadonlyArray<{ name: string; promptFile: string }>;
}): void {
  const { repoSlug, runtimeRoot, kinds } = opts;
  const missing: string[] = [];
  for (const kind of kinds) {
    const absolute = promptFilePath(kind.promptFile, runtimeRoot);
    if (!isLoadablePromptFile(absolute)) {
      missing.push(`  ${kind.name}: ${kind.promptFile} → ${absolute}`);
    }
  }
  if (missing.length === 0) return;
  throw new Error(
    `Tenant ${repoSlug} is missing ${missing.length} prompt file(s), resolved from ` +
      `runtime root ${runtimeRoot}:\n${missing.join("\n")}\n` +
      `Add the file(s), or point the kind's prompt path (a built-in's \`promptFiles\` ` +
      `key, or a custom kind's \`promptFile\`) at a readable file.`,
  );
}

/**
 * Resolve a `promptFiles.*` path against the runtime root. Absolute paths are
 * used as-is; relative paths join to `runtimeRoot`. Throws when the file is
 * missing — never falls back into the installed package tree.
 */
export function resolvePromptFile(promptPath: string, runtimeRoot: string): string {
  const absolute = promptFilePath(promptPath, runtimeRoot);
  if (!isLoadablePromptFile(absolute)) {
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
    // The base of the PR under work, when there is one. The default branch is
    // the right answer for every PR but a feature member (#392), and a kind
    // that knows better overrides it per callsite — a default here is what lets
    // any template name the base without a per-kind guard.
    BASE_BRANCH: config.defaultBranch,
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
