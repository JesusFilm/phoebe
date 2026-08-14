// Config-edit substrate for deployment migrations.
//
// `ConfigHandle` is the narrow surface a migration gets over a config file.
// It exposes only the specific operations migrations need — the blast radius
// of a bad migration is bounded by what the handle offers, not by the author's
// imagination. In particular, the `workspace:` block and the tenant list are
// not exposed: no migration may add, remove, or reorder tenants (#127).
//
// `editConfig*` functions are pure text transformations: they take config
// source (the raw `.ts` content) and return either a new source or a refusal.
// They never touch the filesystem.

// ------------------------------------------------------ types

export type ConfigEditResult = { ok: true; content: string } | { ok: false; reason: string };

/**
 * A config refusal signals the migration runner that the automated edit is
 * unsafe or ambiguous. The runner reports the migration as `manual` and prints
 * `instruction` verbatim so the operator knows the exact edit to make by hand.
 *
 * A refusal is not a failure — it is the expected outcome for configs too
 * dynamic to rewrite safely, and the deployment is left unmodified on disk.
 */
export class ConfigRefusal {
  constructor(public readonly instruction: string) {}
}

export function isConfigRefusal(v: Record<string, string> | ConfigRefusal): v is ConfigRefusal {
  return v instanceof ConfigRefusal;
}

/**
 * ConfigHandle — the narrow API config migrations may call. `workspace:` block
 * and tenant-list operations are absent by design: the handle's shape is the
 * enforcement mechanism, not review discipline.
 *
 * Every method takes the current raw config source and returns a
 * `ConfigEditResult`. On success, `content` is the rewritten source; the caller
 * is responsible for staging it as a write. On failure, the edit is a refusal.
 */
export type ConfigHandle = {
  /**
   * Append `kind` to the `workOrder` string array if not already present.
   * Refuses when the array is not a plain literal (e.g., contains spreads or
   * computed values) so no partial or corrupt rewrite is ever staged.
   */
  appendWorkKind(content: string, kind: string): ConfigEditResult;
};

// ------------------------------------------------------ edit functions

/**
 * The exact operator instruction when `appendWorkKind` refuses — printed
 * verbatim in the migrate report so the operator knows what to add by hand.
 */
export function workKindInstruction(kind: string): string {
  return `add "${kind}" to the workOrder array in phoebe.config.ts`;
}

/**
 * Append `kind` to the `workOrder` string array in `content`.
 *
 * Strict-literal only: anything the function cannot parse unambiguously — a
 * `workOrder` that is not a plain `[...]` literal, or whose elements are not
 * plain string literals (spreads, computed values) — is a refusal. The
 * scaffolded template satisfies the happy path; everything else is the
 * advisory fallback.
 *
 * Comments and formatting outside the array are preserved byte-for-byte
 * because the function splices only the matched array span.
 */
export function editConfigAppendWorkKind(content: string, kind: string): ConfigEditResult {
  // Match workOrder: [...] — single or multi-line, no nested arrays.
  // [^\[\]] matches any char (including newlines) that is not [ or ].
  const WORK_ORDER = /\bworkOrder\s*:\s*(\[(?:[^[\]]*)\])/;
  const match = WORK_ORDER.exec(content);

  if (!match) {
    return {
      ok: false,
      reason: "`workOrder` is not a single plain array literal",
    };
  }

  const arrayStr = match[1]!; // "[...]"
  const inner = arrayStr.slice(1, arrayStr.lastIndexOf("]")); // between [ and ]

  // Each non-empty, non-whitespace token between commas must be a plain string
  // literal. Rejects spreads (...x), computed values, template literals, etc.
  const elements = inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const elem of elements) {
    // Allow only "word" or 'word' (no backslash escapes, no mixed quotes)
    if (!/^["'][^"'\\]*["']$/.test(elem)) {
      return {
        ok: false,
        reason: `\`workOrder\` contains a non-literal element: ${elem}`,
      };
    }
  }

  // Already contains the kind with either quote style?
  if (elements.includes(`"${kind}"`) || elements.includes(`'${kind}'`)) {
    return { ok: true, content };
  }

  // Build the new array string, preserving the existing style.
  const isMultiLine = inner.includes("\n");
  const trimmedInner = inner.trimEnd();
  const hasTrailingComma = trimmedInner.endsWith(",");

  let newArrayStr: string;
  if (isMultiLine) {
    // Determine the closing-bracket indent from the last `\n` before `]`.
    const closePos = arrayStr.lastIndexOf("]");
    const lastNlPos = arrayStr.lastIndexOf("\n", closePos - 1);
    const indent = arrayStr.slice(lastNlPos + 1, closePos).match(/^(\s*)/)?.[1] ?? "";

    // Determine element indent from the last non-empty line.
    const nonEmptyLines = inner.split("\n").filter((l) => l.trim().length > 0);
    const lastElemLine = nonEmptyLines.at(-1) ?? "";
    const elemIndent = lastElemLine.match(/^(\s*)/)?.[1] ?? `${indent}  `;

    if (hasTrailingComma) {
      // ...  "issues",\n] → ...  "issues",\n  "research",\n]
      newArrayStr = `[${inner}${elemIndent}"${kind}",\n${indent}]`;
    } else {
      // ...  "issues"\n]  → ...  "issues",\n  "research"\n]
      newArrayStr = `[${trimmedInner},\n${elemIndent}"${kind}"\n${indent}]`;
    }
  } else {
    // Single-line
    if (hasTrailingComma) {
      // ["a", "b",] → ["a", "b", "c",]
      newArrayStr = `[${trimmedInner} "${kind}",]`;
    } else {
      const sep = trimmedInner.length > 0 ? ", " : "";
      // ["a", "b"] → ["a", "b", "c"]  or  [] → ["c"]
      newArrayStr = `[${trimmedInner}${sep}"${kind}"]`;
    }
  }

  // Splice: replace only the array span, leaving everything else byte-identical.
  const arrayOffset = match[0].indexOf(arrayStr);
  const arrayStart = match.index! + arrayOffset;
  const arrayEnd = arrayStart + arrayStr.length;
  const newContent = content.slice(0, arrayStart) + newArrayStr + content.slice(arrayEnd);

  return { ok: true, content: newContent };
}

// ------------------------------------------------------ handle

export const configHandle: ConfigHandle = {
  appendWorkKind: editConfigAppendWorkKind,
};
