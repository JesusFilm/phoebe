// The automatic check: every install's agent versions against the newest, on a
// timer, when the operator has asked for it.
//
// A page checks when somebody opens it (harness.ts). This is the same check with
// nobody looking: shortly after launch and every few hours after, each install
// with a container is read and the newest versions are looked up once for all
// of them. What it finds is sent to the window, which is where an alert is
// drawn and where the button that updates lives. Nothing is updated from here.
// A version that moved by itself overnight is the thing a pin exists to prevent.
//
// Off unless the preference is on. The look-up tells npm and Cursor that this
// machine asked, and the companion does not do that on its own initiative.

import type { HarnessReport, LocalInstall } from "phoebe-agent/contracts";

/** Long enough after launch that the first reads of each install have landed. */
export const UPDATE_CHECK_DELAY_MS = 20_000;
/** Vendors ship daily at most; a few hours is soon enough to hear about it. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateWatchDeps = {
  /** The preference, read at the moment a check would start. */
  enabled: () => boolean;
  installs: () => Promise<LocalInstall[]>;
  check: (install: LocalInstall, lookUp: boolean) => Promise<HarnessReport>;
  emit: (install: string, report: HarnessReport) => void;
  delayMs?: number;
  intervalMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export type UpdateWatch = {
  /** Start or stop according to the preference. Called at launch and whenever it is saved. */
  refresh: () => void;
  /** One round, now. Resolves when every install has been read. */
  runOnce: () => Promise<void>;
  stop: () => void;
};

export function createUpdateWatch(deps: UpdateWatchDeps): UpdateWatch {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const delayMs = deps.delayMs ?? UPDATE_CHECK_DELAY_MS;
  const intervalMs = deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  let timer: unknown = null;
  let running = false;

  async function runOnce(): Promise<void> {
    // The preference again, here: it may have been turned off while the timer ran.
    if (running || !deps.enabled()) return;
    running = true;
    try {
      // The newest versions are the same for every install, so they are looked
      // up with the first and remembered for the rest (harness.ts).
      let lookUp = true;
      for (const install of await deps.installs()) {
        if (install.state === "not-initialised") continue;
        try {
          deps.emit(install.dir, await deps.check(install, lookUp));
          lookUp = false;
        } catch {
          // One install that cannot be read is not a reason to skip the others.
        }
      }
    } catch {
      // No list to read this round; the next one asks again.
    } finally {
      running = false;
    }
  }

  function schedule(ms: number): void {
    timer = setTimer(() => {
      void runOnce().finally(() => {
        if (timer !== null) schedule(intervalMs);
      });
    }, ms);
  }

  function stop(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  return {
    refresh: () => {
      if (!deps.enabled()) {
        stop();
        return;
      }
      if (timer === null) schedule(delayMs);
    },
    runOnce,
    stop,
  };
}
