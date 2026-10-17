// The **Devices** panel: every session a deployment holds, as `GET
// /api/sessions` and `phoebe sessions` show it (map #690, #696). Drawn under
// the overview's cards on a remote route, and on a local install whose report
// carries a `remote` block.
//
// Revoking needs `operate`; the caller's own row signs out instead, since
// revoking yourself through the list is refused by the deployment (409). An
// expired row stays, greyed, because it is still worth being able to revoke.
// The red banner is the one limit the store owns (#696): a child sharing the
// volume can append a row, and every row is on this page so a forged one is
// where the owner looks.

import type { SessionRow } from "phoebe-agent/contracts";
import { age } from "./facts.ts";
import { coarseDuration } from "./reachability.ts";
import { NEEDS_OPERATE, TAMPERED_BANNER } from "./remote-routes.ts";

export function DevicesPanel({
  rows,
  self,
  canOperate,
  tampered,
  counts,
  now,
  note,
  trouble,
  blocked = false,
  onRevoke,
  onSignOut,
  onRead,
}: {
  /** The rows, or null before they have been read. */
  rows: SessionRow[] | null;
  /** This device's session id, for the "this device" mark; null on a local install. */
  self: string | null;
  canOperate: boolean;
  /** The report says the file moved under the bootstrapper. */
  tampered: boolean;
  /** The report's counts, said in the heading. */
  counts: { active: number; expired: number } | null;
  now: Date;
  /** The line under the table: where this was read from, and the host's own verbs. */
  note: string;
  /** Why the last action was refused, when it was. */
  trouble?: string | null;
  /** A blocked remote: the list is not readable. */
  blocked?: boolean;
  onRevoke?: (sessionId: string) => void;
  onSignOut?: () => void;
  /** Read the list now, where it is not read on its own (a local install). */
  onRead?: () => void;
}) {
  return (
    <section className="devices" aria-label="Devices">
      <h2>
        Devices
        {counts === null ? null : (
          <span className="muted devices-count">
            {" "}
            {counts.active} active{counts.expired > 0 ? `, ${counts.expired} expired` : ""}
          </span>
        )}
      </h2>
      {tampered ? (
        <p className="refusal" role="alert">
          {TAMPERED_BANNER}
        </p>
      ) : null}
      {blocked ? (
        <p className="muted">Not readable while blocked.</p>
      ) : rows === null ? (
        onRead === undefined ? (
          <p className="muted">Reading the devices…</p>
        ) : (
          <p className="verbs">
            <button type="button" onClick={onRead}>
              Read the devices list
            </button>
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="muted">No devices paired.</p>
      ) : (
        <table className="rows devices-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Device</th>
              <th>Paired as</th>
              <th>Scopes</th>
              <th>Last seen</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const expired = Date.parse(row.expiresAt) <= now.getTime();
              const mine = self !== null && row.id === self;
              return (
                <tr key={row.id} className={expired ? "expired" : undefined}>
                  <td>
                    {row.label}
                    {mine ? <span className="chip src">this device</span> : null}
                  </td>
                  <td>
                    {row.deviceType} · {row.os}
                  </td>
                  <td>{row.pairedAs === null ? <span className="muted">—</span> : row.pairedAs}</td>
                  <td>
                    {row.scopes.map((scope) => (
                      <span key={scope} className="chip">
                        {scope}
                      </span>
                    ))}
                  </td>
                  <td className="muted">{age(row.lastSeenAt, now)} ago</td>
                  <td className={expired ? "bad" : undefined}>
                    {expired
                      ? `expired ${age(row.expiresAt, now)} ago`
                      : `in ${coarseDuration(Date.parse(row.expiresAt) - now.getTime())}`}
                  </td>
                  <td>
                    {mine ? (
                      <button type="button" className="quiet" onClick={onSignOut}>
                        sign out
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="quiet"
                        disabled={!canOperate || onRevoke === undefined}
                        title={canOperate ? undefined : NEEDS_OPERATE}
                        onClick={() => onRevoke?.(row.id)}
                      >
                        revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rows !== null && onRead !== undefined ? (
        <p className="verbs">
          <button type="button" className="quiet" onClick={onRead}>
            Read again
          </button>
        </p>
      ) : null}
      {trouble === null || trouble === undefined ? null : <p className="refusal">{trouble}</p>}
      <p className="muted">{note}</p>
    </section>
  );
}
