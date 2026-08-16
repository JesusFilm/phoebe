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
//
// The substrate parses with the vendored @babel/parser bundle and locates
// nodes by byte offset. Every byte outside the targeted node is left
// untouched — this is a property of the mechanism, not of a printer's
// round-trip fidelity. No printer is vendored; splices are the only writes.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — vendored JS bundle; no TS declarations
import { parse } from "./migrations/vendor/babel-parser.mjs";

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

export type GetFieldResult =
  | { ok: false; reason: string }
  | { ok: true; found: false }
  | {
      ok: true;
      found: true;
      /** Raw source text of the value node — always available. */
      raw: string;
      /**
       * Parsed value for plain literal nodes (string, number, boolean, null).
       * `undefined` for non-literals (call expression, identifier, template
       * literal, etc.) — these are readable as `raw` for detection purposes
       * but cannot be overwritten by `editConfigSetField`.
       */
      literal: string | number | boolean | null | undefined;
    };

/**
 * ConfigHandle — the narrow API config migrations may call. `workspace:` block
 * and tenant-list operations are absent by design: the handle's shape is the
 * enforcement mechanism, not review discipline.
 *
 * Every write method takes the current raw config source and returns a
 * `ConfigEditResult`. On success, `content` is the rewritten source; the caller
 * is responsible for staging it as a write. On failure, the edit is a refusal.
 */
export type ConfigHandle = {
  /**
   * Read a top-level field from the config object. Non-literal values are
   * returned as `raw` source text for detection; they cannot be overwritten.
   */
  getField(content: string, key: string): GetFieldResult;
  /**
   * Set a top-level scalar field to a literal value. Creates the field if
   * absent. Refuses when the existing value is non-literal.
   */
  setField(content: string, key: string, value: string | number | boolean): ConfigEditResult;
  /**
   * Remove a top-level field. No-ops when the key is absent.
   */
  removeField(content: string, key: string): ConfigEditResult;
  /**
   * Append `kind` to the `workOrder` string array if not already present.
   * Refuses when the array is not a plain string literal array.
   */
  appendWorkKind(content: string, kind: string): ConfigEditResult;
};

// ------------------------------------------------------ constants

/**
 * The exact operator instruction when `appendWorkKind` refuses — printed
 * verbatim in the migrate report so the operator knows what to add by hand.
 */
export function workKindInstruction(kind: string): string {
  return `add "${kind}" to the workOrder array in phoebe.config.ts`;
}

/**
 * Reason returned by `editConfigAppendWorkKind` when the config has no
 * `workOrder` field. Absence means the engine default applies (which already
 * includes every base work kind), so `m002`'s detect treats this as
 * not-applicable rather than a parse failure.
 */
export const REASON_WORKORDER_NOT_FOUND = "`workOrder` field not found in config";

// ------------------------------------------------------ internal AST helpers

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BNode = any;

function unwrapTs(node: BNode): BNode {
  while (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion"
  ) {
    node = node.expression;
  }
  return node;
}

function propKeyName(key: BNode): string | null {
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  if (key.type === "NumericLiteral") return String(key.value);
  return null;
}

type ResolvedConfig = { ok: true; configObj: BNode };
type ResolveFailure = { ok: false; reason: string };

/**
 * Parse `source` and locate the exported config ObjectExpression.
 *
 * Supported forms (every template, example, and this repo's own config):
 *   const config: T = { ... }; export default config;          (templates/examples)
 *   const config = defineConfig({ ... }); export default config;
 *   export default defineConfig({ ... });
 *   export default { ... };
 *   export const config = { ... };                             (loadUserConfig named form)
 *   satisfies / as / as const annotations on the expression
 *   let instead of const; quoted keys
 *
 * Refuses for the closed set documented in docs/migrations.md.
 */
function resolveConfigObject(source: string): ResolvedConfig | ResolveFailure {
  let ast: BNode;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  } catch (e) {
    return { ok: false, reason: `parse error: ${e instanceof Error ? e.message : String(e)}` };
  }

  const errors = ast.errors as Array<{ message: string }>;
  if (errors.length > 0) {
    return { ok: false, reason: `parse error: ${errors[0]!.message}` };
  }

  const body = ast.program.body as BNode[];

  // Locate the config init expression via one of two supported export forms.
  let expr: BNode;
  let configVarName: string | null = null;

  const defaultExportNode = body.find((n: BNode) => n.type === "ExportDefaultDeclaration");
  if (defaultExportNode) {
    expr = defaultExportNode.declaration;
  } else {
    // Fall back to: export const config = {...}  (loadUserConfig named form)
    let namedInit: BNode | null = null;
    for (const stmt of body) {
      if (
        stmt.type === "ExportNamedDeclaration" &&
        stmt.declaration?.type === "VariableDeclaration"
      ) {
        for (const decl of stmt.declaration.declarations as BNode[]) {
          if (decl.id?.type === "Identifier" && (decl.id.name as string) === "config") {
            if (!decl.init) {
              return { ok: false, reason: "`config` has no initializer" };
            }
            namedInit = decl.init as BNode;
            configVarName = "config";
            break;
          }
        }
      }
      if (namedInit) break;
    }
    if (!namedInit) {
      return { ok: false, reason: "no default export found" };
    }
    expr = namedInit;
  }

  // If the export is an identifier, resolve it to the variable declaration
  if (expr.type === "Identifier") {
    const varName = expr.name as string;
    configVarName = varName;

    let init: BNode | null = null;
    outer: for (const stmt of body) {
      const varDecl =
        stmt.type === "VariableDeclaration"
          ? stmt
          : stmt.type === "ExportNamedDeclaration" &&
              stmt.declaration?.type === "VariableDeclaration"
            ? stmt.declaration
            : null;
      if (varDecl) {
        for (const decl of varDecl.declarations as BNode[]) {
          if (decl.id?.type === "Identifier" && (decl.id.name as string) === varName) {
            if (!decl.init) {
              return { ok: false, reason: `\`${varName}\` has no initializer` };
            }
            init = decl.init;
            break outer;
          }
        }
      }
    }
    if (init === null) {
      return { ok: false, reason: `cannot resolve exported name \`${varName}\`` };
    }
    expr = init;
  }

  // Refuse if the config variable is mutated after its declaration (config.x = ...)
  if (configVarName !== null) {
    const vn = configVarName;
    for (const stmt of body) {
      if (stmt.type === "ExpressionStatement" && stmt.expression.type === "AssignmentExpression") {
        const left = stmt.expression.left;
        if (
          left.type === "MemberExpression" &&
          left.object.type === "Identifier" &&
          (left.object.name as string) === vn
        ) {
          const propText =
            left.property.type === "Identifier"
              ? (left.property.name as string)
              : source.slice(left.property.start as number, left.property.end as number);
          return {
            ok: false,
            reason: `config is mutated after the object literal (\`${vn}.${propText} = ...\`)`,
          };
        }
      }
    }
  }

  // Unwrap TypeScript expression wrappers (as T, satisfies T, <T>expr)
  expr = unwrapTs(expr);

  // Unwrap defineConfig(...) call
  if (expr.type === "CallExpression") {
    const callee = expr.callee;
    if (callee.type !== "Identifier" || (callee.name as string) !== "defineConfig") {
      return {
        ok: false,
        reason: "default export is a call expression but not `defineConfig(...)`",
      };
    }
    const args = expr.arguments as BNode[];
    if (args.length !== 1) {
      return { ok: false, reason: "`defineConfig` called with wrong number of arguments" };
    }
    expr = unwrapTs(args[0]);
    if (expr.type !== "ObjectExpression") {
      return { ok: false, reason: "`defineConfig` argument is not an inline object literal" };
    }
  }

  if (expr.type !== "ObjectExpression") {
    return { ok: false, reason: "config is not a plain object literal" };
  }

  // Validate the object: no spreads, no computed keys, no duplicate keys
  const seenKeys = new Set<string>();
  for (const prop of expr.properties as BNode[]) {
    if (prop.type === "SpreadElement" || prop.type === "RestElement") {
      return { ok: false, reason: "config object contains a spread element (`...`)" };
    }
    if (prop.type !== "ObjectProperty" && prop.type !== "ObjectMethod") {
      return { ok: false, reason: `unexpected config property type: ${prop.type as string}` };
    }
    if (prop.computed as boolean) {
      return { ok: false, reason: "config object contains a computed key" };
    }
    const keyName = propKeyName(prop.key);
    if (keyName === null) {
      return { ok: false, reason: "config object contains a non-static key" };
    }
    if (seenKeys.has(keyName)) {
      return { ok: false, reason: `config object contains duplicate key "${keyName}"` };
    }
    seenKeys.add(keyName);
  }

  return { ok: true, configObj: expr };
}

function findProp(configObj: BNode, key: string): BNode | null {
  for (const prop of configObj.properties as BNode[]) {
    if (prop.type === "ObjectProperty" && propKeyName(prop.key) === key) return prop;
  }
  return null;
}

function extractLiteral(node: BNode): string | number | boolean | null | undefined {
  if (node.type === "StringLiteral") return node.value as string;
  if (node.type === "NumericLiteral") return node.value as number;
  if (node.type === "BooleanLiteral") return node.value as boolean;
  if (node.type === "NullLiteral") return null;
  return undefined;
}

// ------------------------------------------------------ edit functions

/**
 * Read a top-level field from the config object.
 */
export function editConfigGetField(source: string, key: string): GetFieldResult {
  const resolved = resolveConfigObject(source);
  if (!resolved.ok) return resolved;

  const prop = findProp(resolved.configObj, key);
  if (!prop) return { ok: true, found: false };

  const valueNode: BNode = prop.value;
  const raw = source.slice(valueNode.start as number, valueNode.end as number);
  const literal = extractLiteral(valueNode);
  return { ok: true, found: true, raw, literal };
}

/**
 * Set a top-level scalar field in the config object. Creates the field if
 * absent. Refuses when the existing value is non-literal (template literal,
 * call expression, identifier, etc.) so a hand-authored override is never
 * silently clobbered.
 */
export function editConfigSetField(
  source: string,
  key: string,
  value: string | number | boolean,
): ConfigEditResult {
  const resolved = resolveConfigObject(source);
  if (!resolved.ok) return resolved;

  const prop = findProp(resolved.configObj, key);
  const serialized = JSON.stringify(value);

  if (prop) {
    if (prop.shorthand as boolean) {
      return { ok: false, reason: `property "${key}" is a shorthand — cannot overwrite` };
    }
    const valueNode: BNode = prop.value;
    if (extractLiteral(valueNode) === undefined) {
      return {
        ok: false,
        reason: `property "${key}" has a non-literal value — make the edit by hand`,
      };
    }
    return {
      ok: true,
      content:
        source.slice(0, valueNode.start as number) +
        serialized +
        source.slice(valueNode.end as number),
    };
  }

  return { ok: true, content: insertProperty(source, resolved.configObj, key, serialized) };
}

/**
 * Remove a top-level field from the config object. No-ops when the key is
 * absent.
 */
export function editConfigRemoveField(source: string, key: string): ConfigEditResult {
  const resolved = resolveConfigObject(source);
  if (!resolved.ok) return resolved;

  const prop = findProp(resolved.configObj, key);
  if (!prop) return { ok: true, content: source };

  return { ok: true, content: removeProp(source, resolved.configObj, prop) };
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
 * Returns `{ ok: false, reason: REASON_WORKORDER_NOT_FOUND }` when `workOrder`
 * is absent — the engine default already includes all base work kinds.
 *
 * Comments and formatting outside the array are preserved byte-for-byte
 * because the function splices only the array node's span.
 */
export function editConfigAppendWorkKind(source: string, kind: string): ConfigEditResult {
  const resolved = resolveConfigObject(source);
  if (!resolved.ok) return resolved;

  const workOrderProp = findProp(resolved.configObj, "workOrder");
  if (!workOrderProp) {
    return { ok: false, reason: REASON_WORKORDER_NOT_FOUND };
  }

  const arrayNode: BNode = workOrderProp.value;
  if (arrayNode.type !== "ArrayExpression") {
    return { ok: false, reason: "`workOrder` is not a plain array literal" };
  }

  const elements = arrayNode.elements as BNode[];

  for (const elem of elements) {
    if (elem === null) {
      return { ok: false, reason: "`workOrder` contains an elision (empty slot)" };
    }
    if (elem.type === "SpreadElement") {
      return { ok: false, reason: "`workOrder` contains a spread element (`...`)" };
    }
    if (elem.type !== "StringLiteral") {
      return {
        ok: false,
        reason: `\`workOrder\` contains a non-literal element: ${source.slice(elem.start as number, elem.end as number)}`,
      };
    }
  }

  // Already contains the kind?
  if (elements.some((e: BNode) => (e.value as string) === kind)) {
    return { ok: true, content: source };
  }

  // Splice in the new element
  const arraySource = source.slice(arrayNode.start as number, arrayNode.end as number);
  const innerSource = arraySource.slice(1, arraySource.length - 1);
  const isMultiLine = innerSource.includes("\n");

  let newArraySource: string;

  if (isMultiLine) {
    const lastNlBeforeClose = arraySource.lastIndexOf("\n", arraySource.length - 2);
    const closingIndent =
      arraySource.slice(lastNlBeforeClose + 1, arraySource.length - 1).match(/^(\s*)/)?.[1] ?? "";

    let elemIndent = `${closingIndent}  `;
    const lastElem = elements[elements.length - 1];
    if (lastElem) {
      const lineStart = source.lastIndexOf("\n", (lastElem.start as number) - 1) + 1;
      elemIndent =
        source.slice(lineStart, lastElem.start as number).match(/^(\s*)/)?.[1] ?? elemIndent;
    }

    if (elements.length === 0) {
      newArraySource = `[\n${elemIndent}"${kind}",\n${closingIndent}]`;
    } else {
      const hasTrailingComma = innerSource.trimEnd().endsWith(",");
      if (hasTrailingComma) {
        newArraySource = `[${innerSource.trimEnd()}\n${elemIndent}"${kind}",\n${closingIndent}]`;
      } else {
        const trimmedInner = innerSource.trimEnd();
        newArraySource = `[${trimmedInner},\n${elemIndent}"${kind}"\n${closingIndent}]`;
      }
    }
  } else {
    const hasTrailingComma = innerSource.trimEnd().endsWith(",");
    const trimmedInner = innerSource.trimEnd();
    if (elements.length === 0) {
      newArraySource = `["${kind}"]`;
    } else if (hasTrailingComma) {
      newArraySource = `[${trimmedInner} "${kind}",]`;
    } else {
      newArraySource = `[${trimmedInner}, "${kind}"]`;
    }
  }

  return {
    ok: true,
    content:
      source.slice(0, arrayNode.start as number) +
      newArraySource +
      source.slice(arrayNode.end as number),
  };
}

// ------------------------------------------------------ splice helpers

function insertProperty(source: string, obj: BNode, key: string, valueSource: string): string {
  const closingBracePos = (obj.end as number) - 1;
  const objSource = source.slice(obj.start as number, obj.end as number);
  const innerSource = objSource.slice(1, objSource.length - 1);
  const isMultiLine = innerSource.includes("\n");
  const props = obj.properties as BNode[];

  if (isMultiLine) {
    const lastNlBeforeClose = objSource.lastIndexOf("\n", objSource.length - 2);
    const closingIndent =
      objSource.slice(lastNlBeforeClose + 1, objSource.length - 1).match(/^(\s*)/)?.[1] ?? "";

    let elemIndent = `${closingIndent}  `;
    if (props.length > 0) {
      const lastProp = props[props.length - 1]!;
      const lineStart = source.lastIndexOf("\n", (lastProp.start as number) - 1) + 1;
      elemIndent =
        source.slice(lineStart, lastProp.start as number).match(/^(\s*)/)?.[1] ?? elemIndent;
    }

    const afterLastProp =
      props.length > 0 ? source.slice(props[props.length - 1]!.end as number, closingBracePos) : "";
    const hasTrailingComma = afterLastProp.includes(",");
    const newLine = `${elemIndent}${key}: ${valueSource},\n`;

    if (hasTrailingComma || props.length === 0) {
      return source.slice(0, closingBracePos) + newLine + source.slice(closingBracePos);
    }
    const lastPropEnd = props[props.length - 1]!.end as number;
    return (
      source.slice(0, lastPropEnd) +
      "," +
      source.slice(lastPropEnd, closingBracePos) +
      newLine +
      source.slice(closingBracePos)
    );
  }

  // Single-line
  const sep = props.length > 0 ? ", " : " ";
  return (
    source.slice(0, closingBracePos) +
    `${sep}${key}: ${valueSource}` +
    source.slice(closingBracePos)
  );
}

function removeProp(source: string, obj: BNode, prop: BNode): string {
  const objSource = source.slice(obj.start as number, obj.end as number);
  const isMultiLine = objSource.includes("\n");

  if (isMultiLine) {
    // Find the start of the property's line (after the preceding \n)
    let lineStart = prop.start as number;
    while (lineStart > 0 && source[lineStart - 1] !== "\n") {
      lineStart--;
    }
    // Only take the whole-line path when the property is the only non-whitespace
    // content on its line; otherwise splice would delete unrelated source text.
    const linePrefix = source.slice(lineStart, prop.start as number);
    const ownLine = linePrefix.trim() === "" && lineStart > (obj.start as number);
    // Include the preceding \n for own-line properties.
    const removeStart = ownLine ? lineStart - 1 : (prop.start as number);

    // After prop.end: skip whitespace, comma, then newline
    let removeEnd = prop.end as number;
    while (removeEnd < source.length && source[removeEnd] === " ") removeEnd++;
    if (removeEnd < source.length && source[removeEnd] === ",") removeEnd++;
    while (removeEnd < source.length && source[removeEnd] === " ") removeEnd++;
    if (removeEnd < source.length && source[removeEnd] === "\n") removeEnd++;

    return source.slice(0, removeStart) + source.slice(removeEnd);
  }

  // Single-line
  const props = obj.properties as BNode[];
  const propIdx = props.findIndex((p: BNode) => p === prop);

  if (props.length === 1) {
    return source.slice(0, (obj.start as number) + 1) + source.slice((obj.end as number) - 1);
  }

  let removeStart: number;
  let removeEnd: number;

  if (propIdx === props.length - 1) {
    // Last: remove from end of previous prop to end of this prop (including comma)
    removeStart = props[propIdx - 1]!.end as number;
    removeEnd = prop.end as number;
    if (source[removeEnd] === ",") removeEnd++;
  } else {
    // Not last: remove this prop and following separator
    removeStart = prop.start as number;
    removeEnd = prop.end as number;
    if (source[removeEnd] === ",") removeEnd++;
    while (removeEnd < source.length && source[removeEnd] === " ") removeEnd++;
    if (propIdx > 0) {
      removeStart = props[propIdx - 1]!.end as number;
      removeEnd = prop.end as number;
      if (source[removeEnd] === ",") removeEnd++;
      while (removeEnd < source.length && source[removeEnd] === " ") removeEnd++;
    }
  }

  return source.slice(0, removeStart) + source.slice(removeEnd);
}

// ------------------------------------------------------ handle

export const configHandle: ConfigHandle = {
  getField: editConfigGetField,
  setField: editConfigSetField,
  removeField: editConfigRemoveField,
  appendWorkKind: editConfigAppendWorkKind,
};
