// The effective config, flattened into the rows a table draws (#502, #545).
//
// The report carries the tree the engine computed: global leaves, then
// `pipelines.<name>`, then `kinds.<kind>`, so a path in it is a path in
// `phoebe.config.ts`. A table wants one row per leaf with that path already
// spelled out, and the walk that does it is arithmetic over a report — so it
// lives here, pure and tested apart from the component, for the reason every
// derivation in this console does: two readers of one report must not be able to
// disagree about what it says.
//
// Three things the walk has to get right.
//
// **A leaf is a node whose `source` is a string.** The contract fixes that test
// rather than a key list, because branch keys are pipeline and kind names an
// operator chose — someone's pipeline called `source` holds an object, not a
// string, and the test does not misfire on it.
//
// **Tree order is the order.** Rows come out in the order the engine wrote them,
// which is the order of the config, so a leaf sits where an operator would look
// for it in the file. Sorting by path would scatter a pipeline's settings across
// the alphabet.
//
// **Nothing here reads a value.** `value` arrives as whatever JSON held, and an
// `opaque` leaf's value is a human summary a reader may not parse. Both become
// text one way — the text the cell prints and the text the filter matches.
//
// The env half of the section (`env`, presence only) is the secrets tab's, #550.

import type {
  ConfigReport,
  ConfigWarning,
  EffectiveFields,
  EffectiveLeaf,
  EffectiveNode,
  SettingSource,
  TenantEffectiveConfig,
} from "phoebe-agent/contracts";

/** One leaf of one tenant's tree, with the path spelled out. */
export type ConfigLeafRow = {
  /** The tenant the leaf belongs to, as the report named it. */
  tenant: string;
  /** The dotted path — a path in this object is a path in `phoebe.config.ts`. */
  path: string;
  leaf: EffectiveLeaf;
  /** The value as text: what the cell prints and what the filter matches. */
  text: string;
};

/** One tenant's rows, or the reason there are none. */
export type TenantLeaves = {
  tenant: string;
  /** Why the settings are unknown, or null when they are known. */
  error: string | null;
  rows: ConfigLeafRow[];
  warnings: readonly ConfigWarning[];
};

/**
 * The source chips, in a fixed order rather than by count. Counts move whenever
 * a config does, and a row of chips that reorders itself under an operator is a
 * row they have to re-read every time. This is the contract's own order, which
 * runs from "nobody said anything" to "something said it here".
 */
export const SOURCE_ORDER: readonly SettingSource[] = [
  "default",
  "file",
  "alias",
  "overlay",
  "derived",
  "inherited",
];

/** Every tenant in the section, each with its leaves flattened. */
export function tenantLeaves(config: ConfigReport): TenantLeaves[] {
  return config.tenants.map((tenant) => ({
    tenant: tenant.tenant,
    error: tenant.error,
    rows: leafRows(tenant),
    warnings: Array.isArray(tenant.warnings) ? tenant.warnings : [],
  }));
}

/** One tenant's tree, walked into rows. A tenant that errored has none. */
export function leafRows(tenant: TenantEffectiveConfig): ConfigLeafRow[] {
  if (tenant.fields === null || typeof tenant.fields !== "object") return [];
  const rows: ConfigLeafRow[] = [];
  walk(tenant.fields, "", tenant.tenant, rows);
  return rows;
}

function walk(
  fields: EffectiveFields,
  prefix: string,
  tenant: string,
  into: ConfigLeafRow[],
): void {
  for (const [key, node] of Object.entries(fields)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isLeaf(node)) into.push({ tenant, path, leaf: node, text: valueText(node) });
    else if (node !== null && typeof node === "object") walk(node, path, tenant, into);
  }
}

/** A node is a leaf when its `source` is a string; anything else is a branch. */
export function isLeaf(node: EffectiveNode): node is EffectiveLeaf {
  return typeof (node as EffectiveLeaf).source === "string";
}

/**
 * A leaf's value as one line. An `opaque` leaf already holds a summary written
 * for a person — quoting it as JSON would put quotes around a sentence — and
 * everything else is JSON, so `"v0.13.0"` and `v0.13.0` stay distinguishable
 * from each other and `null` stays distinguishable from `"null"`.
 */
export function valueText(leaf: { value: unknown; opaque?: boolean }): string {
  if (leaf.opaque === true) return String(leaf.value);
  return JSON.stringify(leaf.value) ?? "undefined";
}

/** How many leaves each source won, counted across every tenant on the page. */
export function sourceCounts(rows: readonly ConfigLeafRow[]): Map<SettingSource, number> {
  const counts = new Map<SettingSource, number>();
  for (const row of rows) {
    counts.set(row.leaf.source, (counts.get(row.leaf.source) ?? 0) + 1);
  }
  return counts;
}

/**
 * The filter: a path or a value, and a source.
 *
 * Path *or* value, because the two questions an operator brings here are "what
 * is `model` set to" and "who on earth set it to `sonnet`", and making them
 * pick which field they are searching would answer neither. Matching is
 * case-insensitive on the path, on the value as it is printed, and on `via` —
 * typing an env name finds the leaf that variable won.
 *
 * The source filter is separate and ANDs with the query: the chips are counts of
 * the whole deployment, so clicking `overlay` with `model` typed asks "which of
 * the model settings does env decide", which is the question the chip exists for.
 */
export function filterRows(
  rows: readonly ConfigLeafRow[],
  filter: { query: string; source: SettingSource | null },
): ConfigLeafRow[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.source !== null && row.leaf.source !== filter.source) return false;
    if (query === "") return true;
    return (
      row.path.toLowerCase().includes(query) ||
      row.text.toLowerCase().includes(query) ||
      (row.leaf.via ?? "").toLowerCase().includes(query)
    );
  });
}

/**
 * What the expanded row says about where the value came from: `via` and `from`,
 * which the resolution kept off the inline row (#509). Empty when the leaf has
 * neither, which is every `default`.
 */
export function provenanceLine(leaf: EffectiveLeaf): string {
  const parts: string[] = [];
  if (leaf.via !== undefined) parts.push(`via ${leaf.via}`);
  if (leaf.from !== undefined) parts.push(`read from ${leaf.from}`);
  return parts.join(" · ");
}
