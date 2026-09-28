// The **Run doctor** control (#546) — one button on a deployment's doctor tab,
// one on the fleet page, and the same receipts under both.
//
// **The press asks; the report answers.** A receipt says which run the ask
// belongs to — started, joined, or undelivered — and it comes back within the
// moment. What doctor found arrives afterwards as the next report over the
// event stream (#542), which is why nothing here waits for a run and nothing
// here holds a spinner for five minutes.
//
// **A deployment the relay is not holding is refused before the press.** The
// button is disabled with the reason beside it rather than after it: the relay
// would answer `undelivered` up front (#506 §8), and the console already knows
// that from the row it is drawing.
//
// The relay answers no check itself, so nothing on this control is a verdict
// about the deployment — it is a receipt for an ask (#507 §8).

import { useState } from "react";
import type { RelayDeploymentRow, RelayDoctorRunResult } from "phoebe-agent/contracts";
import { fleetLine, outcomeLine, whyNotAskable } from "./doctor-run.ts";
import type { RelayClient } from "./relay-client.ts";

/** One deployment, or the whole fleet — the two presses, as one value. */
export type DoctorRunTarget =
  | { kind: "deployment"; row: RelayDeploymentRow }
  | { kind: "fleet"; deployments: number };

type Asking =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "answered"; results: RelayDoctorRunResult[] }
  | { kind: "broken"; message: string };

export function RunDoctor({
  client,
  target,
  now,
}: {
  client: RelayClient;
  target: DoctorRunTarget;
  now: Date;
}) {
  const [state, setState] = useState<Asking>({ kind: "idle" });
  const refusal = target.kind === "deployment" ? whyNotAskable(target.row, now) : null;
  const fingerprint = target.kind === "deployment" ? target.row.fingerprint : undefined;

  return (
    <section className="run-doctor" aria-label="Run doctor">
      <button
        type="button"
        disabled={refusal !== null || state.kind === "asking"}
        // The reason is on screen as well: a title is for a pointer, and an
        // operator reading a disabled button wants the sentence without one.
        title={refusal ?? undefined}
        onClick={() => {
          setState({ kind: "asking" });
          client.runDoctor(fingerprint).then(
            (results) => setState({ kind: "answered", results }),
            (error: unknown) => setState({ kind: "broken", message: messageOf(error) }),
          );
        }}
      >
        {target.kind === "fleet" ? "Run doctor on every deployment" : "Run doctor"}
      </button>
      {refusal === null ? null : <p className="facts">{refusal}</p>}
      {state.kind === "asking" ? <p className="facts">Asking…</p> : null}
      {state.kind === "broken" ? (
        <p className="bad">The relay did not take the request: {state.message}</p>
      ) : null}
      {state.kind === "answered" ? <Receipts target={target} results={state.results} /> : null}
    </section>
  );
}

/**
 * What came back. The fleet press gets a count first and then every deployment
 * by name, because "2 started, 1 undelivered" is the sentence an operator reads
 * and the names are the ones they act on.
 */
function Receipts({
  target,
  results,
}: {
  target: DoctorRunTarget;
  results: RelayDoctorRunResult[];
}) {
  if (target.kind === "deployment") {
    const only = results[0];
    return (
      <p className="facts">{only === undefined ? "The relay asked nobody." : outcomeLine(only)}</p>
    );
  }
  return (
    <>
      <p className="facts">{fleetLine(results)}</p>
      {results.map((result) => (
        <p key={result.fingerprint} className="facts">
          <b>{result.name}</b> — {outcomeLine(result)}
        </p>
      ))}
    </>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
