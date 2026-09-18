// A **verb run** — one invocation of a host verb by the companion, with its
// lines streamed and an exit carrying a structured outcome (#527 §2, glossary).
//
// Every host verb is one of these. There is no second shape for the quick ones:
// `doctor` returns in a second and `upgrade` can take a minute, and a tab that
// renders one of them differently from the other is a tab with two code paths
// where the operator sees one box of output.
//
// Three rules the contract carries and main enforces:
//
//  - **One run per install, parallel across installs.** A second run on a busy
//    install is refused `busy` rather than queued — a queue would let an
//    operator stack `stop` behind `start` and watch the wrong one win.
//  - **Runs never reject.** A verb that fails exits non-zero; the reason is a
//    stderr line the operator already read. A rejection would put the failure
//    somewhere other than the output they are watching.
//  - **The buffer survives a reload.** Runs live in main, so reopening the
//    window during an upgrade rejoins it mid-stream rather than showing nothing.

import type { HostVerb, VerbOutcome } from "./host-verb.ts";
import type { InitProfile } from "./init-report.ts";
import type { UpgradeTarget } from "./upgrade-outcome.ts";

/**
 * How many lines of a run main keeps. A `migrate` over a large workspace can
 * print thousands, and the window only ever shows the tail — past this the
 * oldest go, so one long run cannot grow main's memory without bound.
 * Mirrored by hand in index.mjs.
 */
export const MAX_RUN_LINES = 2000;

/**
 * The verbs a run can be cancelled (#527 §2). Cancel is SIGTERM to the child the
 * verb spawned, so the list is exactly the verbs whose children the companion
 * holds: `start` and `stop` drive Compose through an injected runner, and that
 * runner is where the child lands.
 *
 * Shorter than §2's list, and deliberately. `init` writes files in-process and
 * `doctor` probes over fetch — a cancel on either is a button that does nothing.
 * `upgrade` and `migrate` do spawn, but through `spawnSync`, which blocks the
 * process that called them; a cancel could not be delivered while one is in
 * flight, so offering the control would be a lie about what it does. Making
 * those two spawn asynchronously is what would add them here.
 * Mirrored by hand in index.mjs.
 */
export const CANCELLABLE_VERBS: readonly HostVerb[] = ["start", "stop"];

/**
 * What to run and where. One arm per verb, each carrying that verb's own
 * arguments, so a caller cannot ask `stop` to rebuild or hand `init` a ref.
 *
 * `install` is the install's directory — its identity (#527 §12).
 */
export type VerbRunRequest =
  | { install: string; verb: "init"; profile?: InitProfile }
  | { install: string; verb: "start"; build?: boolean }
  | { install: string; verb: "stop"; now?: boolean }
  | { install: string; verb: "upgrade"; check?: boolean; target?: UpgradeTarget; ref?: string }
  | { install: string; verb: "migrate"; check?: boolean }
  | { install: string; verb: "doctor" };

/** One line a running verb wrote. Carries no newline — the tab decides that. */
export type RunLine = {
  runId: string;
  stream: "stdout" | "stderr";
  line: string;
};

/**
 * A run that ended. `code` is 0 when the verb returned and non-zero when it
 * threw or was cancelled; `outcome` is the verb's own typed result, absent in
 * exactly the cases where there was none to return.
 */
export type RunExit = {
  runId: string;
  code: number;
  outcome?: VerbOutcome;
};

/**
 * The current or last run on one install, as main holds it (#527 §13). One per
 * install, replaced by the next run — there is no run history, because the
 * question the install tab answers is "what is happening now", and the last
 * answer to it is the most anyone has asked for.
 */
export type VerbRun = {
  runId: string;
  install: string;
  verb: HostVerb;
  startedAt: string;
  /** Oldest first, bounded by {@link MAX_RUN_LINES}. */
  lines: RunLine[];
  /** Absent while the run is still going. */
  exit?: RunExit;
};
