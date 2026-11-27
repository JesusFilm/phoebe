// Spend limits where an operator looks (#991, decided in #978): each limit a
// deployment's config sets beside the figure it is weighed against, and every
// pipeline a ceiling holds with when the hold should lift.
//
// The bootstrapper weighs the limits and writes the answer on each cell
// (`cell.spend`, #990). This reads it and decides nothing: a limit is "reached"
// here exactly when the report's own figure is at or past it, which is the test
// the bootstrapper applied. A tenant limit rides on every cell of its tenant,
// so it is listed once per tenant, not once per cell.

import type {
  DeploymentReport,
  SpendHold,
  SpendLimitFigure,
  SpendMeasure,
  SpendScope,
  SpendWindow,
} from "phoebe-agent/contracts";
import { cellsOf, tenantsOf } from "./report.ts";

/** One limit key on one owner: its figure, and the warning limit and ceiling set on it. */
export type SpendRow = {
  /** Stable across renders. */
  key: string;
  scope: SpendScope;
  /** Who the figure belongs to: the tenant, or the pipeline, named as the page names them. */
  whose: string;
  measure: SpendMeasure;
  window: SpendWindow;
  spent: number;
  warn: number | null;
  ceiling: number | null;
  /** How far the figure has gone: under both, past the warning limit, or at the ceiling. */
  standing: "under" | "warning" | "held";
};

/** A pipeline a ceiling holds. */
export type SpendHoldRow = {
  key: string;
  /** The pipeline held, named as the page names it. */
  pipeline: string;
  hold: SpendHold;
};

export type SpendView = {
  rows: SpendRow[];
  holds: SpendHoldRow[];
};

/** Nothing configured anywhere: no rows and no holds. */
export const NO_SPEND: SpendView = { rows: [], holds: [] };

const KEY_ORDER: Record<`${SpendMeasure}${SpendWindow}`, number> = {
  usd24h: 0,
  usd7d: 1,
  tokens24h: 2,
  tokens7d: 3,
};

/**
 * What one report says about its spend limits. A report from before #991
 * carries holds but not the limits themselves, so its rows are empty and its
 * holds still show.
 */
export function spendViewOf(report: DeploymentReport): SpendView {
  const several = tenantsOf(report).length > 1;
  const rows = new Map<string, SpendRow>();
  const holds: SpendHoldRow[] = [];
  for (const cell of cellsOf(report)) {
    const spend = cell.spend;
    if (typeof spend !== "object" || spend === null) continue;
    const tenant = cell.tenant.slug ?? cell.tenant.path;
    const pipeline = several ? `${tenant} ${cell.pipeline}` : cell.pipeline;
    if (spend.hold !== null && typeof spend.hold === "object") {
      holds.push({ key: cell.id, pipeline, hold: spend.hold });
    }
    const limits: SpendLimitFigure[] = Array.isArray(spend.limits) ? spend.limits : [];
    for (const limit of limits) {
      const owner = limit.scope === "tenant" ? `tenant:${cell.tenant.id}` : `pipeline:${cell.id}`;
      const key = `${owner}|${limit.measure}${limit.window}`;
      const row = rows.get(key) ?? {
        key,
        scope: limit.scope,
        whose: limit.scope === "tenant" ? `tenant ${tenant}` : pipeline,
        measure: limit.measure,
        window: limit.window,
        spent: limit.spent,
        warn: null,
        ceiling: null,
        standing: "under" as const,
      };
      if (limit.level === "warn") row.warn = limit.limit;
      else row.ceiling = limit.limit;
      rows.set(key, row);
    }
  }
  const ordered = [...rows.values()].map((row) => ({ ...row, standing: standingOf(row) }));
  // Tenant limits first, then pipelines, each owner's in the config's key order.
  ordered.sort(
    (a, b) =>
      (a.scope === b.scope ? 0 : a.scope === "tenant" ? -1 : 1) ||
      a.whose.localeCompare(b.whose) ||
      KEY_ORDER[`${a.measure}${a.window}`] - KEY_ORDER[`${b.measure}${b.window}`],
  );
  return { rows: ordered, holds };
}

function standingOf(row: SpendRow): SpendRow["standing"] {
  if (row.ceiling !== null && row.spent >= row.ceiling) return "held";
  if (row.warn !== null && row.spent >= row.warn) return "warning";
  return "under";
}

/** The rows over one window only, for a page that shows a window at a time. */
export function spendRowsOver(view: SpendView, window: SpendWindow): SpendRow[] {
  return view.rows.filter((row) => row.window === window);
}

/** `API spend` or `Tokens`: what a row's figure counts. */
export function measureLabel(measure: SpendMeasure): string {
  return measure === "usd" ? "API spend" : "Tokens in + out";
}

/** A figure in its measure's unit, compact enough for a table cell. */
export function spendCell(measure: SpendMeasure, value: number): string {
  if (measure === "usd") return `$${value.toFixed(2)}`;
  return Math.round(value).toLocaleString("en-US");
}

/** What the page says under every limit table: how a ceiling lifts, and that nothing here lifts it. */
export const SPEND_LIFT_NOTE =
  "A ceiling lifts on its own as spend ages out of its window. To lift it sooner, " +
  "raise or remove it in the config; there is no resume button.";
