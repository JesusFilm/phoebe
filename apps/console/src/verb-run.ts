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
  /**
   * Rebuild the image and bring the install up on it: a draining stop first
   * when it is running, since `start` leaves a running install as it is, then a
   * start with a build. Two runs, each shown as it goes; a stop that fails
   * leaves the second unstarted.
   */
  rebuild: (stopFirst: boolean) => void;
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

  // A run that ended may have changed what the folder holds: a config edit, an
  // upgrade, an init. Main reads the install again and sends what it found down
  // the same stream every other read arrives on, so a form shows the value that
  // landed and sends the next edit against the file as it now is, not as it was.
  const ended = run?.exit === undefined ? null : run.runId;
  useEffect(() => {
    if (ended === null) return;
    void bridge.installs.refresh(dir).catch(() => undefined);
  }, [bridge, dir, ended]);

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

  function rebuild(stopFirst: boolean): void {
    setTrouble(null);
    void runInSequence(bridge, dir, rebuildRequests(dir, stopFirst), setRun).then(setTrouble);
  }

  return { run, running: run !== null && run.exit === undefined, trouble, start, rebuild };
}

/** The runs a rebuild is: a draining stop when the install is up, then a start with a build. */
export function rebuildRequests(dir: string, stopFirst: boolean): VerbRunRequest[] {
  return [
    ...(stopFirst ? [{ install: dir, verb: "stop" } as const] : []),
    { install: dir, verb: "start", build: true },
  ];
}

/**
 * Start each run when the one before it has exited clean. `onStarted` is handed
 * each as it begins, so a page shows the run in flight. Resolves with why main
 * refused one, or null; a run that exits non-zero ends the sequence quietly,
 * because its own output already says what went wrong.
 */
export async function runInSequence(
  bridge: DesktopBridge,
  dir: string,
  requests: readonly VerbRunRequest[],
  onStarted: (run: VerbRun) => void,
): Promise<string | null> {
  for (const request of requests) {
    let runId: string;
    try {
      runId = await bridge.runs.start(request);
    } catch (error) {
      return refusalText(error);
    }
    onStarted({
      runId,
      install: dir,
      verb: request.verb,
      startedAt: new Date().toISOString(),
      lines: [],
    });
    if ((await exitOf(bridge, dir, runId)) !== 0) return null;
  }
  return null;
}

/**
 * Resolves with the exit code when the run with this id ends: the wait between
 * the halves of a restart or a rebuild.
 */
export function exitOf(bridge: DesktopBridge, dir: string, runId: string): Promise<number> {
  return new Promise((resolve) => {
    const off = bridge.runs.exits((exit) => {
      if (exit.runId !== runId) return;
      off();
      resolve(exit.code);
    });
    // The exit may have come and gone before this subscription existed; main
    // still holds the install's last run, so ask it once.
    void bridge.runs.current(dir).then(
      (current) => {
        if (current !== null && current.runId === runId && current.exit !== undefined) {
          off();
          resolve(current.exit.code);
        }
      },
      () => undefined,
    );
  });
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
