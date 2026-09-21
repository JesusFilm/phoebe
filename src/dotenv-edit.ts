// Setting one key in a `.env` file, in place.
//
// The root `.env` is the operator's file. Compose reads it, `phoebe doctor`
// reads it, and an operator opens it in an editor — so a writer here rewrites
// one line and leaves the rest of the file byte for byte: the comments, the
// blank lines, the order, the trailing `GH_TOKEN` somebody is about to rotate.
//
// The read half of this pair is `parseDotenv` in bootstrap/engine-child-env.ts,
// and this writer holds to the same minimal grammar: `KEY=VALUE`, an optional
// `export ` prefix, `#` comments, no interpolation and no multiline values.
// Anything outside that grammar is left alone rather than reformatted.
//
// Values are quoted only when they need it. A pairing token is base64url and
// never does; a value with a space or a `#` in it would be read short by
// Compose without quotes, so it gets them.

/** The pattern one assignment line matches, with or without `export `. */
const ASSIGNMENT = /^(\s*)(?:(export)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Set `key` to `value`, replacing the last assignment of it or appending one.
 *
 * The **last**, because that is the one that wins: `parseDotenv` and Compose
 * both take the final assignment of a repeated key, so rewriting an earlier one
 * would write a value nothing reads. Earlier duplicates are left where they are
 * — they were already dead, and deleting lines an operator wrote is not this
 * writer's job.
 *
 * A file with no trailing newline gains one; every file this returns ends in
 * exactly one.
 */
export function setDotenvValue(contents: string, key: string, value: string): string {
  const lines = contents.split("\n");
  const serialized = `${key}=${quoteIfNeeded(value)}`;

  let last = -1;
  for (const [index, line] of lines.entries()) {
    const match = ASSIGNMENT.exec(line);
    if (match !== null && match[3] === key) last = index;
  }

  if (last !== -1) {
    const match = ASSIGNMENT.exec(lines[last]!)!;
    // The indentation and an `export ` prefix are the operator's; only the
    // assignment itself is ours to rewrite.
    lines[last] = `${match[1]}${match[2] === undefined ? "" : "export "}${serialized}`;
    return withTrailingNewline(lines.join("\n"));
  }

  const body = contents.replace(/\n+$/, "");
  return withTrailingNewline(body.length === 0 ? serialized : `${body}\n${serialized}`);
}

/**
 * Quote a value that would otherwise be read short or read wrong. Double quotes
 * with the two characters that end one escaped, which is as much as the grammar
 * above can express — a value needing more than that is a value this file is
 * the wrong place for.
 */
function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_\-./:+=@,]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
