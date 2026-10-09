// The config tab: every effective-config leaf, filterable (#545, #502).
//
// The question the tab exists to answer is "what is this set to, and why" — so
// the whole tree is on screen, defaults included, and the answer to "why" is
// attached to the value rather than kept on another page.
//
// Variant C's answers, from the prototype's resolution (#509):
//
// **A filterable table, not lines and not a tree.** It scales past a fixture.
// The filter matches a path or a value, and the source chips are counts of the
// whole deployment that narrow it to one source.
//
// **The source chip is always shown; `via` and `from` are not inline.** Which of
// six sources won is the fact an operator scans for, and it fits in a chip. The
// env name or file path behind it is what they read once they have found the
// row, so it lives in the row's disclosure — hover for the summary, expand for
// the rest. A `<details>` does it with no state and no script, which also means
// it still works in the static markup the tests read.
//
// **Shadowed values sit under the winner**, in the winner's own cell. "Why isn't
// my file value taking effect" is answered in place; a separate list would make
// an operator reconstruct the ladder.
//
// **Warnings sit above the table**, because a deprecated alias is advice about
// the tenant rather than about any one of its rows, and an operator who never
// scrolls should still see it.
//
// **Editing is one column, and it is per leaf** (#503, #547). A leaf `config
// set` accepts carries an Edit button; every other leaf carries the sentence
// saying why, with the manual edit and the `phoebe config set` line under it.
// The table is otherwise unchanged: what a row says about a value does not
// depend on whether it can be changed from here. The column's own conversation —
// the form, the receipt, the reconcile behind it — is config-edit-row.tsx.

import { useState } from "react";
import type {
  ConfigReport,
  ConfigWarning,
  DeploymentReport,
  SettingSource,
} from "phoebe-agent/contracts";
import { leafEditability } from "./config-edit.ts";
import { EditCell, type EditSeam } from "./config-edit-row.tsx";
import {
  filterRows,
  sourceCounts,
  provenanceLine,
  tenantLeaves,
  valueText,
  SOURCE_ORDER,
  type ConfigLeafRow,
  type TenantLeaves,
} from "./config-facts.ts";
import { age } from "./facts.ts";
import { configOf } from "./report.ts";

export function ConfigTab({
  report,
  now,
  onEdit,
}: {
  report: DeploymentReport;
  now: Date;
  /**
   * Send one patch, or absent when this console has no way to (#547). Absent
   * drops the column outright rather than filling it with disabled buttons —
   * there is nothing to say about editing on a page that cannot. That is what
   * the companion's renderer gets until its own seam lands (#553).
   */
  onEdit?: EditSeam["send"];
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SettingSource | null>(null);
  const config = configOf(report);
  if (config === null) {
    return (
      <p className="muted">
        This report carries no config section. The deployment is running an engine older than the
        one that embeds it (#535), so its settings are unknown from here — which is not the same as
        having none. <code>phoebe config</code> on the host still answers.
      </p>
    );
  }

  const tenants = tenantLeaves(config);
  const counts = sourceCounts(tenants.flatMap((tenant) => tenant.rows));
  const shown = tenants.map((tenant) => ({
    ...tenant,
    rows: filterRows(tenant.rows, { query, source }),
  }));
  // "No leaf matches" is about the filter, so it is said only when there were
  // leaves to filter. A tenant that errored has none for a reason of its own,
  // and that reason is already on screen.
  const noLeaves = tenants.every((tenant) => tenant.rows.length === 0);
  const hidden = !noLeaves && shown.every((tenant) => tenant.rows.length === 0);
  return (
    <>
      <p className="facts">
        <code>{config.root.path}</code>{" "}
        {config.root.fingerprint === null ? (
          <span className="bad">could not be read, so no edit will be accepted</span>
        ) : (
          <span className="mono">{config.root.fingerprint}</span>
        )}{" "}
        · computed {age(config.updatedAt, now)} ago · shape v{config.version}
        {config.omitted > 0
          ? ` · ${config.omitted} more tenant${config.omitted === 1 ? "" : "s"} left out of this report, which is written to a byte budget — ask that tenant directly`
          : ""}
      </p>
      <div className="filters">
        <input
          className="filter"
          type="search"
          placeholder="filter path or value"
          aria-label="Filter path or value"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {SOURCE_ORDER.filter((name) => counts.has(name)).map((name) => (
          <button
            key={name}
            type="button"
            className={`chip src ${name}${source === name ? " picked" : ""}`}
            aria-pressed={source === name}
            onClick={() => setSource(source === name ? null : name)}
          >
            {name} {counts.get(name)}
          </button>
        ))}
      </div>
      {tenants.length === 0 ? (
        <p className="muted">This report names no tenant, so there is no config to show.</p>
      ) : (
        shown.map((tenant) => (
          <TenantSection
            key={tenant.tenant}
            tenant={tenant}
            root={config.root}
            {...(onEdit !== undefined ? { seam: { send: onEdit, report, root: config.root } } : {})}
          />
        ))
      )}
      {hidden ? (
        <p className="muted">No leaf matches. Every setting is still there; the filter is not.</p>
      ) : null}
    </>
  );
}

function TenantSection({
  tenant,
  root,
  seam,
}: {
  tenant: TenantLeaves;
  root: ConfigReport["root"];
  seam?: EditSeam;
}) {
  return (
    <>
      <h2>{tenant.tenant}</h2>
      {tenant.error === null ? null : (
        <p className="bad">
          This tenant&apos;s settings are unknown: {tenant.error}. Nothing below is a stale
          resolution kept because it was the last good one — there is nothing below.
        </p>
      )}
      <Warnings warnings={tenant.warnings} />
      {tenant.rows.length === 0 ? null : (
        <table className="rows config">
          <thead>
            <tr>
              <th>path</th>
              <th>value</th>
              <th>source</th>
              {seam === undefined ? null : <th>edit</th>}
            </tr>
          </thead>
          <tbody>
            {tenant.rows.map((row) => (
              <LeafRow
                key={row.path}
                row={row}
                configPath={tenant.configPath}
                root={root}
                {...(seam !== undefined ? { seam } : {})}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** The deprecated aliases this tenant is using, above the rows they are about. */
function Warnings({ warnings }: { warnings: readonly ConfigWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="warnings">
      {warnings.map((warning) => (
        <p key={`${warning.path}:${warning.message}`} className="warning">
          <code>{warning.path}</code> — {warning.message}
        </p>
      ))}
    </div>
  );
}

function LeafRow({
  row,
  configPath,
  root,
  seam,
}: {
  row: ConfigLeafRow;
  configPath: string | undefined;
  root: ConfigReport["root"];
  seam?: EditSeam;
}) {
  const { leaf } = row;
  const provenance = provenanceLine(leaf);
  return (
    <tr>
      <th scope="row" className="mono">
        {row.path}
      </th>
      <td>
        <code>{row.text}</code>
        {leaf.opaque === true ? <span className="chip">opaque</span> : null}
        {(leaf.shadowed ?? []).map((shadowed, index) => (
          <div key={`${shadowed.source}:${index}`} className="shadowed muted">
            shadowed: <code>{valueText(shadowed)}</code> ({shadowed.source}
            {shadowed.via === undefined ? "" : ` via ${shadowed.via}`})
          </div>
        ))}
      </td>
      <td>
        <details className="why">
          <summary title={provenance === "" ? "nothing said otherwise" : provenance}>
            <span className={`chip src ${leaf.source}`}>{leaf.source}</span>
          </summary>
          <div className="facts">
            {provenance === ""
              ? "Nothing said otherwise — this is the shipped default."
              : provenance}
          </div>
          <div className="facts">read by {leaf.reader}</div>
        </details>
      </td>
      {seam === undefined ? null : (
        <td>
          <EditCell
            row={row}
            editability={leafEditability({ path: row.path, leaf, configPath, root })}
            seam={seam}
          />
        </td>
      )}
    </tr>
  );
}
