// The walk from the engine's tree to the table's rows.
//
// The assertions are the ones the tab would be wrong without: a path that reads
// like the config file, a pipeline someone called `source` still counted as a
// branch, an opaque value that is not quoted as JSON, and a filter that answers
// both "what is `model` set to" and "who set it to `opus`".

import { describe, expect, test } from "vite-plus/test";
import type { TenantEffectiveConfig } from "phoebe-agent/contracts";
import {
  filterRows,
  isLeaf,
  leafRows,
  provenanceLine,
  sourceCounts,
  tenantLeaves,
  valueText,
} from "./config-facts.ts";
import { configReport, effectiveConfig } from "./test-fixture.ts";

const ROWS = leafRows(effectiveConfig());
const paths = (rows: readonly { path: string }[]): string[] => rows.map((row) => row.path);

describe("the walk", () => {
  test("spells a leaf's path the way the config file does", () => {
    expect(paths(ROWS)).toContain("pipelines.work.kinds.research.model");
  });

  test("keeps the tree's order, so a leaf is where the file has it", () => {
    expect(paths(ROWS)).toEqual([
      "repoSlug",
      "engine",
      "deployment",
      "pipelines.work.concurrency",
      "pipelines.work.workOrder",
      "pipelines.work.kinds.research.provider",
      "pipelines.work.kinds.research.model",
      "pipelines.work.kinds.research.runBudgetMs",
    ]);
  });

  test("a pipeline named `source` is a branch, not a leaf", () => {
    // The contract's own test for a leaf: `source` is a *string*. A branch keyed
    // by a pipeline someone called `source` holds an object, so it walks on.
    const rows = leafRows(
      effectiveConfig({
        fields: {
          pipelines: {
            source: { concurrency: { value: 1, source: "default", reader: "engine" } },
          },
        },
      }),
    );
    expect(paths(rows)).toEqual(["pipelines.source.concurrency"]);
  });

  test("a tenant whose settings are unknown yields no row at all", () => {
    const held: TenantEffectiveConfig = effectiveConfig({
      error: 'unknown provider "claude-code-v1"',
      fields: null,
      env: null,
      warnings: [],
    });
    expect(leafRows(held)).toEqual([]);
    expect(tenantLeaves(configReport({ tenants: [held] }))[0]).toMatchObject({
      error: 'unknown provider "claude-code-v1"',
      rows: [],
    });
  });

  test("isLeaf reads the member, not the shape around it", () => {
    expect(isLeaf({ value: 1, source: "default", reader: "engine" })).toBe(true);
    expect(isLeaf({ nested: { value: 1, source: "default", reader: "engine" } })).toBe(false);
  });
});

describe("a value as text", () => {
  test('JSON keeps a string apart from the bare word and null apart from "null"', () => {
    expect(valueText({ value: "opus" })).toBe('"opus"');
    expect(valueText({ value: null })).toBe("null");
    expect(valueText({ value: "null" })).toBe('"null"');
    expect(valueText({ value: false })).toBe("false");
  });

  test("an opaque leaf prints its summary, unquoted — it is prose, not data", () => {
    expect(valueText({ value: "a compose file and two mounts", opaque: true })).toBe(
      "a compose file and two mounts",
    );
  });
});

describe("the source counts", () => {
  test("count the leaves each source won", () => {
    const counts = sourceCounts(ROWS);
    expect(counts.get("file")).toBe(3);
    expect(counts.get("overlay")).toBe(1);
    expect(counts.get("alias")).toBe(1);
    expect(counts.get("inherited")).toBe(1);
    expect(counts.get("derived")).toBe(1);
    expect(counts.get("default")).toBe(1);
  });

  test("count every tenant on the page, not the first one", () => {
    const both = configReport({
      tenants: [effectiveConfig(), effectiveConfig({ tenant: "JesusFilm/web" })],
    });
    const rows = tenantLeaves(both).flatMap((row) => row.rows);
    expect(sourceCounts(rows).get("overlay")).toBe(2);
  });
});

describe("the filter", () => {
  const filter = (query: string, source: Parameters<typeof filterRows>[1]["source"] = null) =>
    paths(filterRows(ROWS, { query, source }));

  test("an empty query keeps every row", () => {
    expect(filter("")).toEqual(paths(ROWS));
  });

  test("matches a path, case-insensitively", () => {
    expect(filter("KINDS.research")).toEqual([
      "pipelines.work.kinds.research.provider",
      "pipelines.work.kinds.research.model",
      "pipelines.work.kinds.research.runBudgetMs",
    ]);
  });

  test("matches a value, which is the other question an operator brings", () => {
    expect(filter("opus")).toEqual(["pipelines.work.kinds.research.model"]);
  });

  test("matches the thing that supplied it, so an env name finds its leaf", () => {
    expect(filter("PHOEBE_WORK_CONCURRENCY")).toEqual(["pipelines.work.concurrency"]);
  });

  test("a source narrows the query rather than replacing it", () => {
    expect(filter("", "file")).toEqual(["repoSlug", "engine", "deployment"]);
    expect(filter("engine", "file")).toEqual(["engine"]);
    expect(filter("engine", "overlay")).toEqual([]);
  });
});

describe("the provenance line", () => {
  test("names the thing that supplied the value and where it was read", () => {
    expect(provenanceLine(ROWS[3]!.leaf)).toBe("via PHOEBE_WORK_CONCURRENCY · read from tenantEnv");
  });

  test("a default has neither, and says so by being empty", () => {
    expect(provenanceLine({ value: null, source: "default", reader: "engine" })).toBe("");
  });
});
