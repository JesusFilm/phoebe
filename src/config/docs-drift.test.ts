// Guards docs/configuration.md's field tables and PHOEBE_* overlay table
// against drifting out of sync with the roster (#42, #57). The roster cannot
// own this dialect by construction — field descriptions live only in prose,
// so generating the tables would mean an empty description column — so a
// human edits the docs by hand and this test catches when the edit didn't
// happen. Lives in src/config/ (not src/) because it reads the roster
// directly, which index.ts's module docstring reserves for implementation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { FIELDS, ROSTER, type RosterField } from "./roster.ts";

const DOCS_PATH = join(import.meta.dirname, "..", "..", "docs", "configuration.md");
const docText = readFileSync(DOCS_PATH, "utf8");

type Table = { header: string[]; rows: string[][] };

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function isTableRule(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(line);
}

function isTableRow(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|.*\|\s*$/.test(line);
}

/** A minimal GFM table scanner — good enough for this doc's tables, which
 *  never nest a literal unescaped `|` inside a cell. */
function parseTables(markdown: string): Table[] {
  const lines = markdown.split("\n");
  const tables: Table[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i]) && isTableRule(lines[i + 1])) {
      const header = splitRow(lines[i]!);
      const rows: string[][] = [];
      let j = i + 2;
      while (isTableRow(lines[j])) {
        rows.push(splitRow(lines[j]!));
        j++;
      }
      tables.push({ header, rows });
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

const TABLES = parseTables(docText);
const FIELD_TABLES = TABLES.filter((t) => t.header[0] === "Field");
const OVERLAY_TABLE = TABLES.find(
  (t) => t.header[0] === "Env var" && t.header[1] === "Config field",
);
if (!OVERLAY_TABLE) {
  throw new Error("docs/configuration.md: could not find the PHOEBE_* overlay table.");
}

const FIELD_CELL_RE = /^`([a-zA-Z][a-zA-Z0-9]*)`$/;
const ENV_CELL_RE = /^`([A-Z][A-Z0-9_]*)`$/;

function stripCodeSpan(cell: string): string {
  const trimmed = cell.trim();
  if (trimmed.startsWith("``") && trimmed.endsWith("``") && trimmed.length >= 4) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Render a roster default the same way a human writes it into a doc table
 *  cell — a JS-literal-shaped inner string, minus the wrapping code-span
 *  backticks `stripCodeSpan` already removed from the documented side.
 *  `blockedByPattern` is special-cased: its default is regex source with
 *  literal backslashes, so the doc shows the `String.raw` expression that
 *  produced it (readable) rather than the raw characters (a wall of `\`). */
function formatDefaultInner(field: RosterField, value: unknown): string {
  if (field === "blockedByPattern") {
    return "String.raw`" + (value as string) + "`";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, string>);
    return `{ ${entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`;
  }
  return String(value);
}

describe("docs/configuration.md matches the roster (#42, #57)", () => {
  test("every field-table row names a real roster field", () => {
    const unknown: string[] = [];
    for (const table of FIELD_TABLES) {
      for (const row of table.rows) {
        const match = FIELD_CELL_RE.exec(row[0] ?? "");
        if (match && !(match[1]! in ROSTER)) {
          unknown.push(`"${match[1]}" (row: ${row.join(" | ")})`);
        }
      }
    }
    expect(unknown, unknown.join("\n")).toEqual([]);
  });

  test("every roster field is documented by a field-table row or the PHOEBE_* overlay", () => {
    const documented = new Set<string>();
    for (const table of FIELD_TABLES) {
      for (const row of table.rows) {
        const match = FIELD_CELL_RE.exec(row[0] ?? "");
        if (match) documented.add(match[1]!);
      }
    }
    for (const row of OVERLAY_TABLE!.rows) {
      const match = FIELD_CELL_RE.exec(row[1] ?? "");
      if (match) documented.add(match[1]!);
    }

    const missing: string[] = [];
    for (const field of Object.keys(ROSTER) as RosterField[]) {
      const descriptor = FIELDS[field];
      if (descriptor.kind.type === "bootstrapper-only") {
        // engine/workspace/configDir: no description text to tabulate
        // (bootstrapper-only, hand-authored prose per #57's scope), but
        // still expected to be named somewhere.
        if (!docText.includes(`\`${field}\``)) {
          missing.push(`"${field}" (expected at least one \`${field}\` mention in prose)`);
        }
        continue;
      }
      if (!documented.has(field)) missing.push(field);
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  test("every documented default matches the roster's shipped default", () => {
    const mismatches: string[] = [];
    for (const table of FIELD_TABLES) {
      for (const row of table.rows) {
        const match = FIELD_CELL_RE.exec(row[0] ?? "");
        if (!match) continue;
        const field = match[1] as RosterField;
        const descriptor = FIELDS[field];
        if (descriptor.default === undefined) continue;
        const documented = stripCodeSpan(row[1] ?? "");
        const expected = formatDefaultInner(field, descriptor.default);
        if (documented !== expected) {
          mismatches.push(
            `"${field}": docs say ${JSON.stringify(documented)}, roster default renders as ${JSON.stringify(expected)}`,
          );
        }
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  test("the PHOEBE_* overlay table's rows equal exactly the descriptors carrying `env`", () => {
    const documentedEnv = new Map<string, string>();
    for (const row of OVERLAY_TABLE!.rows) {
      const envMatch = ENV_CELL_RE.exec(row[0] ?? "");
      const fieldMatch = FIELD_CELL_RE.exec(row[1] ?? "");
      if (envMatch && fieldMatch) documentedEnv.set(envMatch[1]!, fieldMatch[1]!);
    }

    const expectedEnv = new Map<string, string>();
    for (const field of Object.keys(ROSTER) as RosterField[]) {
      const env = FIELDS[field].env;
      if (env !== undefined) expectedEnv.set(env, field);
    }

    const problems: string[] = [];
    for (const [env, field] of expectedEnv) {
      if (documentedEnv.get(env) !== field) {
        problems.push(`missing/mismatched overlay row for "${env}" -> "${field}"`);
      }
    }
    for (const [env, field] of documentedEnv) {
      if (expectedEnv.get(env) !== field) {
        problems.push(
          `stale overlay row "${env}" -> "${field}" — no roster field carries this env key`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
