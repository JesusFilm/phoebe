// Spend limits as the console reads them off a report (#991): one row per
// limit key and owner, a tenant's limits once however many cells carry them,
// and each hold beside the pipeline it holds.

import { describe, expect, test } from "vite-plus/test";
import type { CellSpend, SpendHold } from "phoebe-agent/contracts";
import { spendRowsOver, spendViewOf } from "./spend.ts";
import { ago, cell, report, tenant } from "./test-fixture.ts";

const HOLD: SpendHold = {
  scope: "pipeline",
  measure: "usd",
  window: "24h",
  limit: 8,
  spent: 9,
  since: ago(600),
  releaseAt: "2026-09-18T21:00:00.000Z",
};

function spend(overrides: Partial<CellSpend> = {}): CellSpend {
  return { hold: null, warnings: [], limits: [], ...overrides };
}

const TENANT_WEEK = {
  scope: "tenant",
  level: "warn",
  measure: "usd",
  window: "7d",
  limit: 20,
  spent: 12,
} as const;

describe("spendViewOf", () => {
  test("a report with no limits has nothing to show", () => {
    expect(spendViewOf(report())).toEqual({ rows: [], holds: [] });
  });

  test("a warning limit and a ceiling on one key are one row, and the standing is the figure's", () => {
    const view = spendViewOf(
      report({
        fleet: {
          tenants: [tenant()],
          cells: [
            cell({
              spend: spend({
                hold: HOLD,
                limits: [
                  { ...TENANT_WEEK },
                  {
                    scope: "pipeline",
                    level: "warn",
                    measure: "usd",
                    window: "24h",
                    limit: 5,
                    spent: 9,
                  },
                  {
                    scope: "pipeline",
                    level: "ceiling",
                    measure: "usd",
                    window: "24h",
                    limit: 8,
                    spent: 9,
                  },
                  {
                    scope: "pipeline",
                    level: "warn",
                    measure: "tokens",
                    window: "7d",
                    limit: 1_000_000,
                    spent: 1_200_000,
                  },
                ],
              }),
            }),
          ],
          updatedAt: ago(12),
        },
      }),
    );

    expect(
      view.rows.map((row) => [
        row.whose,
        row.measure,
        row.window,
        row.warn,
        row.ceiling,
        row.standing,
      ]),
    ).toEqual([
      ["tenant JesusFilm/youtube-studio", "usd", "7d", 20, null, "under"],
      ["work", "usd", "24h", 5, 8, "held"],
      ["work", "tokens", "7d", 1_000_000, null, "warning"],
    ]);
    expect(view.holds).toEqual([{ key: "/etc/phoebe#work", pipeline: "work", hold: HOLD }]);
    expect(spendRowsOver(view, "24h").map((row) => row.key)).toEqual([
      "pipeline:/etc/phoebe#work|usd24h",
    ]);
  });

  test("a tenant limit every cell carries is listed once, and pipelines name their tenant among several", () => {
    const other = tenant({ id: "/w/b", slug: "acme/b", path: "/w/b" });
    const view = spendViewOf(
      report({
        fleet: {
          tenants: [tenant(), other],
          cells: [
            cell({ spend: spend({ limits: [{ ...TENANT_WEEK }] }) }),
            cell({
              id: "/etc/phoebe#review",
              pipeline: "review",
              spend: spend({ limits: [{ ...TENANT_WEEK }] }),
            }),
            cell({ id: "/w/b#work", tenant: other, spend: spend({ hold: HOLD }) }),
          ],
          updatedAt: ago(12),
        },
      }),
    );

    expect(view.rows).toHaveLength(1);
    expect(view.holds.map((row) => row.pipeline)).toEqual(["acme/b work"]);
  });

  test("a report from before #991 still shows its holds, with no limits beside them", () => {
    const view = spendViewOf(
      report({
        fleet: {
          tenants: [tenant()],
          cells: [cell({ spend: { hold: HOLD, warnings: [] } })],
          updatedAt: ago(12),
        },
      }),
    );
    expect(view.rows).toEqual([]);
    expect(view.holds).toHaveLength(1);
  });
});
