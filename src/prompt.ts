// Prompt template rendering: {{KEY}} argument substitution plus !`command`
// shell expansion, executed in the work unit's worktree. The marker trick is
// ported from Sandcastle's PromptPreprocessor: shell blocks present in the raw
// template are marked *before* argument substitution, so `!`...`` patterns
// arriving via substituted values are treated as data, never executed.

export type PromptArgs = Record<string, string>;

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
