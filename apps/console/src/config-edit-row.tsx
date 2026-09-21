// The edit affordance on one config leaf, and everything an operator sees after
// pressing it (#503, #547).
//
// It is its own file because the config tab is a table and this is a
// conversation: a form, a request in flight, a receipt, and — for a receipt that
// landed — the report catching up behind it. Keeping it here leaves the table a
// table.
//
// Three things shape what is on screen.
//
// **A leaf that cannot be edited says why, in place.** Not a disabled button and
// not a missing one: "why is there no Edit here" is the question the sentence
// answers, and it is the same sentence the deployment would refuse with. The
// fallback is under it — the exact manual edit and the `phoebe config set` line
// — so a closed row is still a way to make the change.
//
// **A refusal is not an error.** It arrives through the ordinary path, it is
// about the operator's own file, and it always carries the edit to make by hand.
// So does the relay's `undelivered`, which the console composes itself, because
// "we could not reach the deployment" without the change to make is half an
// answer.
//
// **A written edit is not the end.** The receipt ends at `written`; what the
// deployment did next is the report's news (#503 "Outcome"). So the panel keeps
// reading the report it is handed — reconciling, then idle with `lastEditId` —
// and the leaf turning `file` in the table above is the proof it took.

import { useState } from "react";
import type { ConfigReport, DeploymentReport } from "phoebe-agent/contracts";
import {
  editPanel,
  fallbackPanel,
  readTypedValue,
  type EditAnswer,
  type EditableValue,
  type LeafEditability,
} from "./config-edit.ts";
import type { ConfigLeafRow } from "./config-facts.ts";

/** What the tab hands one row so it can ask for an edit and follow it. */
export type EditSeam = {
  /**
   * Send one patch and answer with what came back. The tab holds the
   * fingerprint and the deployment, so a row asks with a path and a value.
   */
  send: (edit: { path: string; value: EditableValue }) => Promise<{
    id: string;
    answer: EditAnswer;
  }>;
  /** The report as it stands now — how a written edit is followed. */
  report: DeploymentReport;
  root: ConfigReport["root"];
};

/**
 * One answer, with the value that was sent beside it. The value is kept here
 * because a refusal does not carry one: the receipt says what was refused and
 * why, and the literal an operator typed is this side's to remember — it is what
 * the fallback command has to hold.
 */
type Landed = { id: string; value: EditableValue; answer: EditAnswer };

/** One leaf's edit column: the affordance, or the sentence instead of it. */
export function EditCell({
  row,
  editability,
  seam,
}: {
  row: ConfigLeafRow;
  editability: LeafEditability;
  seam: EditSeam;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(() => row.text);
  const [sending, setSending] = useState(false);
  const [landed, setLanded] = useState<Landed | null>(null);
  const [notLiteral, setNotLiteral] = useState(false);

  if (!editability.editable) {
    return <ClosedLeaf row={row} editability={editability} seam={seam} />;
  }

  const submit = (): void => {
    const value = readTypedValue(typed);
    if (!value.ok) {
      // An object or an array parses as JSON and is still not a literal. Caught
      // here rather than sent, because the far end has nowhere to put one and
      // the operator is two keystrokes from a value that works.
      setNotLiteral(true);
      return;
    }
    setNotLiteral(false);
    setSending(true);
    const sent = value.value;
    seam.send({ path: row.path, value: sent }).then(
      (result) => {
        setSending(false);
        setLanded({ ...result, value: sent });
        if (result.answer.kind === "written") setOpen(false);
      },
      (error: unknown) => {
        setSending(false);
        // The relay did not answer at all — a dropped session, a 500. Not a
        // receipt and not an `undelivered`, so it is said in its own words
        // rather than dressed as either.
        setLanded({
          id: "",
          value: sent,
          answer: {
            kind: "unknown",
            outcome: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
  };

  return (
    <>
      {open ? (
        <div className="editform">
          <label>
            <span className="muted">new value</span>
            <input
              className="filter"
              type="text"
              aria-label={`New value for ${row.path}`}
              value={typed}
              disabled={sending}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          <button type="button" disabled={sending} onClick={submit}>
            {sending ? "Sending…" : "Save"}
          </button>
          <button type="button" disabled={sending} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <p className="facts">
            JSON when it parses as JSON (<code>42</code>, <code>true</code>, <code>null</code>,{" "}
            <code>&quot;two words&quot;</code>), a plain string otherwise — the same reading{" "}
            <code>phoebe config set</code> gives a value.
          </p>
          {notLiteral ? (
            <p className="bad">
              A leaf holds one literal. An object or a list is a file edit, not a field patch.
            </p>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className="chip"
          onClick={() => {
            setTyped(row.text);
            setOpen(true);
          }}
        >
          Edit
        </button>
      )}
      {landed === null ? null : <Receipt row={row} landed={landed} seam={seam} />}
    </>
  );
}

/** A leaf the console may not write: why not, and the two ways to do it anyway. */
function ClosedLeaf({
  row,
  editability,
  seam,
}: {
  row: ConfigLeafRow;
  editability: Extract<LeafEditability, { editable: false }>;
  seam: EditSeam;
}) {
  const fallback = fallbackPanel({
    editability,
    path: row.path,
    value: row.leaf.value as EditableValue,
    root: seam.root,
  });
  return (
    <details className="why">
      <summary title={fallback.why}>
        <span className="chip">not editable</span>
      </summary>
      <div className="facts">{fallback.why}.</div>
      <div className="facts">{fallback.detail}</div>
      <pre className="cmd">
        <code>{fallback.command}</code>
      </pre>
    </details>
  );
}

/** What came back, and — for a write — what the deployment did about it. */
function Receipt({ row, landed, seam }: { row: ConfigLeafRow; landed: Landed; seam: EditSeam }) {
  const panel = editPanel({
    answer: landed.answer,
    value: landed.value,
    path: row.path,
    root: seam.root,
    report: seam.report,
    id: landed.id,
  });
  return (
    <div className="receipt">
      <p className={panel.tone}>{panel.lead}</p>
      {panel.detail === undefined ? null : <p className="facts">{panel.detail}</p>}
      {panel.command === undefined ? null : (
        <pre className="cmd">
          <code>{panel.command}</code>
        </pre>
      )}
    </div>
  );
}
