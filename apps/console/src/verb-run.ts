// One install's verb run, as a page holds it.
//
// The run is main's, so a page reads it rather than owning it. Reading on mount
// is what makes a reload rejoin a run in flight (#527 §13), and every page that
// starts runs on an install does the same three things: read the current one,
// apply the lines and the exit as they arrive, and say why when main refuses to
// start one.

import { useEffect, useState } from "react";
import type { DesktopBridge, EditReceipt, VerbRun, VerbRunRequest } from "phoebe-agent/contracts";
import { applyRunExit, applyRunLine } from "./local-install.ts";

export type InstallRun = {
  run: VerbRun | null;
  /** Whether the run is still going. */
  running: boolean;
  /** Why main refused the last start, when it did. */
  trouble: string | null;
  start: (request: VerbRunRequest) => void;
};

export function useInstallRun(bridge: DesktopBridge, dir: string): InstallRun {
  const [run, setRun] = useState<VerbRun | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    bridge.runs.current(dir).then(
      (current) => {
        if (live) setRun(current);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge, dir]);

  useEffect(() => {
    const unsubscribeLines = bridge.runs.lines((line) => {
      setRun((current) => applyRunLine(current, line));
    });
    const unsubscribeExits = bridge.runs.exits((exit) => {
      setRun((current) => applyRunExit(current, exit));
    });
    return () => {
      unsubscribeLines();
      unsubscribeExits();
    };
  }, [bridge]);

  function start(request: VerbRunRequest): void {
    setTrouble(null);
    bridge.runs.start(request).then(
      (runId) => {
        // A fresh record rather than a refetch: the first lines may already be
        // on their way, and applying them to a stale run would drop them.
        setRun({
          runId,
          install: dir,
          verb: request.verb,
          startedAt: new Date().toISOString(),
          lines: [],
        });
      },
      (error: unknown) => setTrouble(refusalText(error)),
    );
  }

  return { run, running: run !== null && run.exit === undefined, trouble, start };
}

/**
 * A refusal's own words. Every bridge call rejects with `{ code, message,
 * instruction? }` (#527 §16), and the instruction is the thing the operator can
 * run by hand — so it goes on screen beside the message, not in a console log.
 */
export function refusalText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const instruction = (error as { instruction?: string }).instruction;
  return instruction === undefined ? error.message : `${error.message} — ${instruction}`;
}

/**
 * The last run's receipt, when the last run was a `config set` that finished on
 * the config at `file`. An install's runs are one after another whichever
 * config they name, so a receipt is shown under the file it is about and not
 * under every form on the install.
 */
export function receiptOfRun(run: VerbRun | null, file: string): EditReceipt | null {
  const outcome = run?.exit?.outcome;
  if (outcome?.verb !== "config set") return null;
  return outcome.outcome.file === file ? outcome.outcome : null;
}
