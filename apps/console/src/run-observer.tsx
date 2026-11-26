// The History tab's "Run observer" button (#938, spec #924, decisions #920 and
// #916). Shown only when a tenant on the deployment declares the observer; one
// button per such tenant when there are several, since the ask has to name one.
//
// Pressing it opens a small confirm with the lookback filled in. Confirming
// asks through the page's runner, and whatever came back is said under the
// button: the start, the bootstrapper's reason for refusing, or "too old".
//
// The button is disabled while a run is in flight, with its start time in the
// tooltip. "In flight" is the report's: the observer pipeline's snapshot lists
// the unit. Between a start and the first report that shows the run, the
// moment of the ask stands in for it, for at most two minutes, so a second
// press in that gap is not possible either.

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  DEFAULT_LOOKBACK,
  isLookback,
  observeRequestOf,
  type ObserveRunner,
  type ObserverTarget,
} from "./observer.ts";

/** How long an accepted ask holds the button down before the report shows the run. */
export const ASKED_HOLD_MS = 2 * 60_000;

type Said = { tone: "ok" | "refused"; text: string };

export function RunObserver({
  targets,
  run,
  now,
  onSettled,
}: {
  targets: readonly ObserverTarget[];
  run: ObserveRunner;
  now: Date;
  /** Called when a run the report showed in flight is no longer in it: its record has landed. */
  onSettled: () => void;
}) {
  const [confirming, setConfirming] = useState<ObserverTarget | null>(null);
  const [lookback, setLookback] = useState(DEFAULT_LOOKBACK);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [asked, setAsked] = useState<Record<string, string>>({});

  // A run the report shows in flight takes over from the ask that started it,
  // and one that leaves the report has settled.
  const running = useRef<Record<string, string | null>>({});
  const runningKey = targets.map((target) => `${target.label}=${target.runningSince}`).join("|");
  useEffect(() => {
    let settled = false;
    for (const target of targets) {
      const before = running.current[target.label] ?? null;
      if (before !== null && target.runningSince === null) settled = true;
      running.current[target.label] = target.runningSince;
    }
    const seen = targets.filter((target) => target.runningSince !== null);
    if (seen.length > 0) {
      setAsked((previous) => {
        const next = { ...previous };
        for (const target of seen) delete next[target.label];
        return next;
      });
    }
    if (settled) onSettled();
    // `runningKey` is what moves; `targets` is a new array on every report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey]);

  if (targets.length === 0) return null;

  /** When the run on this target started, by the report or by the ask, or null. */
  const inFlightSince = (target: ObserverTarget): string | null => {
    if (target.runningSince !== null) return target.runningSince;
    const at = asked[target.label];
    if (at === undefined) return null;
    return now.getTime() - Date.parse(at) < ASKED_HOLD_MS ? at : null;
  };

  const open = (target: ObserverTarget): void => {
    setConfirming(target);
    setLookback(DEFAULT_LOOKBACK);
    setSaid(null);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (confirming === null || !isLookback(lookback) || busy) return;
    const target = confirming;
    const startedAt = now.toISOString();
    setBusy(true);
    run(observeRequestOf(target, targets, lookback)).then(
      (fetched) => {
        setBusy(false);
        setConfirming(null);
        if (fetched.kind === "too-old") {
          setSaid({
            tone: "refused",
            text:
              "This deployment is too old to run the observer. Its phoebe-agent predates " +
              "manual observer runs; upgrade it to start one from here.",
          });
          return;
        }
        const { answer } = fetched;
        if (answer.outcome === "started") {
          setAsked((previous) => ({ ...previous, [target.label]: startedAt }));
          setSaid({
            tone: "ok",
            text: `${capitalised(answer.detail)} It shows here when it settles.`,
          });
          return;
        }
        setSaid({ tone: "refused", text: `The observer run was refused: ${answer.detail}` });
      },
      (error: unknown) => {
        setBusy(false);
        setSaid({
          tone: "refused",
          text: `Could not ask for an observer run: ${messageOf(error)}`,
        });
      },
    );
  };

  return (
    <div className="run-observer">
      <div className="run-observer-buttons">
        {targets.map((target) => {
          const since = inFlightSince(target);
          return (
            <button
              key={target.label}
              type="button"
              disabled={since !== null || busy}
              title={
                since === null
                  ? `Start an observer run on ${target.label} now, outside its schedule.`
                  : `An observer run has been in flight since ${new Date(since).toLocaleString()}.`
              }
              onClick={() => open(target)}
            >
              {targets.length > 1 ? `Run observer: ${target.label}` : "Run observer"}
            </button>
          );
        })}
      </div>
      {confirming === null ? null : (
        <form
          className="run-observer-confirm"
          role="dialog"
          aria-label="Run the observer"
          onSubmit={submit}
        >
          <span>
            Run the observer
            {targets.length > 1 ? (
              <>
                {" "}
                on <strong>{confirming.label}</strong>
              </>
            ) : null}{" "}
            over the last
          </span>
          <input
            aria-label="Lookback"
            value={lookback}
            size={5}
            onChange={(event) => setLookback(event.target.value.trim())}
          />
          <button type="submit" disabled={busy || !isLookback(lookback)}>
            {busy ? "Starting…" : "Start"}
          </button>
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => setConfirming(null)}
          >
            Cancel
          </button>
          {isLookback(lookback) ? null : <span className="refusal">A period like 14d or 36h.</span>}
        </form>
      )}
      {said === null ? null : (
        <p className={said.tone === "ok" ? "outcome" : "refusal"} role="status">
          {said.text}
        </p>
      )}
    </div>
  );
}

function capitalised(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
