// The spend limits beside their figures (#991): the table the overview's
// history card and the fleet stats page both draw, and the line for each
// pipeline a ceiling holds. What the rows say is spend.ts; this draws it.

import { spendCrossingText } from "../../../src/contracts/spend.ts";
import { duration } from "./facts.ts";
import {
  measureLabel,
  SPEND_LIFT_NOTE,
  spendCell,
  type SpendHoldRow,
  type SpendRow,
} from "./spend.ts";

/** When a hold should lift, in this machine's time, with how long that is from now. */
export function HeldUntil({ releaseAt, now }: { releaseAt: string; now: Date }) {
  const at = Date.parse(releaseAt);
  if (!Number.isFinite(at)) return <>held until an unknown time</>;
  const when = new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <>
      held until about <span title={releaseAt}>{when}</span>
      {at > now.getTime() ? ` (in ${duration(at - now.getTime())})` : null}
    </>
  );
}

function Limit({ row, value, reached }: { row: SpendRow; value: number | null; reached: boolean }) {
  if (value === null) return <span className="muted">—</span>;
  const text = spendCell(row.measure, value);
  return reached ? <span className="stats-bad">{text}</span> : <>{text}</>;
}

/**
 * Every limit as a row: who it covers, what it counts over which window, the
 * figure, and the warning limit and ceiling set on it. `deployment` adds a
 * first column for a page that lists several deployments.
 */
export function SpendLimitTable({
  rows,
  deployment,
}: {
  rows: readonly SpendRow[];
  /** The deployment each row belongs to, when the table lists several. */
  deployment?: (row: SpendRow) => string;
}) {
  return (
    <table className="rows spend-limits">
      <thead>
        <tr>
          {deployment === undefined ? null : <th>Deployment</th>}
          <th>Applies to</th>
          <th>Limit</th>
          <th>Spent</th>
          <th>Warning limit</th>
          <th>Ceiling</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={`spend-${row.standing}`}>
            {deployment === undefined ? null : <td>{deployment(row)}</td>}
            <td>{row.whose}</td>
            <td>
              {measureLabel(row.measure)}, {row.window}
            </td>
            <td>
              {spendCell(row.measure, row.spent)}
              {row.standing === "held" ? (
                <span className="chip fail">held</span>
              ) : row.standing === "warning" ? (
                <span className="chip warn">warning</span>
              ) : null}
            </td>
            <td>
              <Limit row={row} value={row.warn} reached={row.standing !== "under"} />
            </td>
            <td>
              <Limit row={row} value={row.ceiling} reached={row.standing === "held"} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One line per pipeline a ceiling holds: which ceiling, and when it should lift. */
export function SpendHolds({
  holds,
  now,
  deployment,
}: {
  holds: readonly SpendHoldRow[];
  now: Date;
  deployment?: (hold: SpendHoldRow) => string;
}) {
  if (holds.length === 0) return null;
  return (
    <ul className="spend-holds">
      {holds.map((row) => (
        <li key={row.key} className="refusal">
          {deployment === undefined ? null : `${deployment(row)}: `}
          {row.pipeline} is <HeldUntil releaseAt={row.hold.releaseAt} now={now} /> by its{" "}
          {row.hold.scope === "tenant" ? "tenant's" : "own"} ceiling ({spendCrossingText(row.hold)}
          ).
        </li>
      ))}
    </ul>
  );
}

/**
 * The limits section under a history figure: the holds, the table, and how a
 * ceiling lifts. Nothing at all when no limit is set and nothing is held.
 */
export function SpendLimits({
  rows,
  holds,
  now,
  heading = "Spend limits",
}: {
  rows: readonly SpendRow[];
  holds: readonly SpendHoldRow[];
  now: Date;
  heading?: string;
}) {
  if (rows.length === 0 && holds.length === 0) return null;
  return (
    <div className="spend-section">
      <h3>{heading}</h3>
      <SpendHolds holds={holds} now={now} />
      {rows.length === 0 ? null : <SpendLimitTable rows={rows} />}
      <p className="muted spend-note">{SPEND_LIFT_NOTE}</p>
    </div>
  );
}
