// **Add a remote**: one modal, one field (map #690, #699). The field takes a
// pairing link or a bare address; a link carries the code, an address alone
// shows a code field. Plus the label this device will have in the deployment's
// devices list. Pair again, from a blocked row or the page's session card, is
// the same modal with the address and the label filled in; the new code's
// scopes become the device's, which is how it gains or gives up `operate`.
//
// The companion reaches the deployment through this machine's Tailscale;
// nothing sits in between. Main reads the descriptor and spends the code
// (`remotes.pair`), so the token never passes through this window.

import { useEffect, useState, type FormEvent } from "react";
import type { DesktopBridge, LocalInstall, PairResult, RemoteRecord } from "phoebe-agent/contracts";
import { normalizeCodeShape } from "./code-shape.ts";
import { coarseDuration, hostnameOf } from "./reachability.ts";
import {
  ADD_EMPTY,
  addFailureLine,
  addSuccessLine,
  addUrl,
  CODE_SHAPE,
  parseAddInput,
} from "./remote-routes.ts";

export type AddRemoteDone = {
  record: RemoteRecord;
  lines: string[];
};

export function AddRemote({
  bridge,
  defaultLabel,
  prefill = "",
  prefillLabel,
  records,
  joinedInstallOf,
  tailscaleRunning,
  onPaired,
  onClose,
  onOpen,
}: {
  bridge: DesktopBridge;
  /** The label this device offers: the machine's name, or "this companion". */
  defaultLabel: string;
  /** The address, for pair again. */
  prefill?: string;
  /** The label the record already carries, for pair again. */
  prefillLabel?: string;
  /** The records held before this pair, for saying where the row landed. */
  records: readonly RemoteRecord[];
  /** The folder on this machine with a given deployment id, when there is one. */
  joinedInstallOf: (deploymentId: string) => LocalInstall | null;
  /** Null until this machine's Tailscale has been asked. */
  tailscaleRunning: boolean | null;
  /** A pair landed: the list has moved. */
  onPaired: (record: RemoteRecord) => void;
  onClose: () => void;
  /** Open the new record's page. */
  onOpen: (deploymentId: string) => void;
}) {
  const [input, setInput] = useState(prefill);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState(prefillLabel ?? defaultLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<AddRemoteDone | null>(null);
  useEffect(() => setLabel(prefillLabel ?? defaultLabel), [defaultLabel, prefillLabel]);

  const parsed = parseAddInput(input);
  const linkCode = parsed.code !== "";
  const repair = prefill !== "";

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (parsed.host === "") {
      setError(ADD_EMPTY);
      return;
    }
    const typed = normalizeCodeShape(linkCode ? parsed.code : code);
    if (typed === null) {
      setError(CODE_SHAPE);
      return;
    }
    setBusy(true);
    setError(null);
    const url = addUrl(parsed.host);
    const held = records.find(
      (record) => hostnameOf(record.url) === hostnameOf(url) && record.url === url,
    );
    const sectionHad = records.filter(
      (record) => hostnameOf(record.url) === hostnameOf(url),
    ).length;
    bridge.remotes.pair({ url, code: typed, label: label.trim() }).then(
      (result: PairResult) => {
        setBusy(false);
        if (result.outcome !== "paired") {
          setError(addFailureLine(result, tailscaleRunning));
          return;
        }
        const repaired =
          held !== undefined || records.some((r) => r.deploymentId === result.record.deploymentId);
        setDone({
          record: result.record,
          lines: addSuccessLine({
            record: result.record,
            sectionHad: repaired ? sectionHad - 1 : sectionHad,
            repaired,
            joined: joinedInstallOf(result.record.deploymentId),
          }),
        });
        onPaired(result.record);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  }

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={repair ? "Pair again" : "Add a remote deployment"}
    >
      <div className="modal-box">
        <h2>{repair ? "Pair again" : "Add a remote deployment"}</h2>
        {done !== null ? (
          <>
            <p>
              <span className="chip ok">paired</span> <strong>{done.record.name}</strong>{" "}
              <span className="muted">
                {done.record.url.replace(/^https:\/\//, "")} · {done.record.scopes.join(", ")} ·
                session expires in{" "}
                {coarseDuration(Math.max(0, Date.parse(done.record.expiresAt) - Date.now()))}
              </span>
            </p>
            {done.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="actions">
              <button type="button" onClick={() => onOpen(done.record.deploymentId)}>
                Open {done.record.name}
              </button>
              <button type="button" className="quiet" onClick={onClose}>
                Close
              </button>
            </p>
          </>
        ) : (
          <form onSubmit={submit}>
            <label className="field-label" htmlFor="add-remote-input">
              Pairing link, or the deployment&apos;s address
            </label>
            <input
              id="add-remote-input"
              className="field"
              placeholder="https://<node>.<tailnet>.ts.net/pair#code=XXXX-XXXX-XXXX"
              value={input}
              disabled={busy}
              onChange={(event) => setInput(event.target.value)}
            />
            {linkCode ? (
              <p className="muted small">
                link with code: <code>{parsed.host}</code> · <code>{parsed.code}</code>
              </p>
            ) : (
              <>
                <label className="field-label" htmlFor="add-remote-code">
                  Pairing code{" "}
                  <span className="muted">
                    (from <code>phoebe pair</code> on the host, or the deployment&apos;s install
                    tab)
                  </span>
                </label>
                <input
                  id="add-remote-code"
                  className="field mono"
                  placeholder="XXXX-XXXX-XXXX"
                  value={code}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(event) => setCode(event.target.value)}
                />
              </>
            )}
            <label className="field-label" htmlFor="add-remote-label">
              This device&apos;s label{" "}
              <span className="muted">(shown in the deployment&apos;s devices list)</span>
            </label>
            <input
              id="add-remote-label"
              className="field"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            {error === null ? null : (
              <p className="refusal" role="alert">
                {error}
              </p>
            )}
            <p className="actions">
              <button type="submit" disabled={busy}>
                {busy ? "Pairing…" : "Pair"}
              </button>
              <button type="button" className="quiet" onClick={onClose}>
                Cancel
              </button>
            </p>
            {repair ? (
              <p className="muted small">
                The new code&apos;s scopes become this device&apos;s: one from{" "}
                <code>phoebe pair --operate</code> grants operate, one from <code>phoebe pair</code>{" "}
                read only. The row keeps its name and what it last heard, and the old session ends
                on the deployment.
              </p>
            ) : (
              <p className="muted small">
                The companion reaches the deployment through this machine&apos;s Tailscale; nothing
                sits in between. A new host becomes a new section on the rail; a known host gains a
                row. The session lasts 30 days, then you pair again.
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
