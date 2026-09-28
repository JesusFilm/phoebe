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
//
// A fourth rule holds for one argument only. **A secret value is a run argument
// and nothing else** (#527 §7): it travels to main as in-memory structured-clone
// data, is held for the run, and is gone when the run ends. Main never writes it
// to `companion.json`, never logs it, and no `run:line` echoes it — which is
// why `secret set` streams the writer's own sentences and never the value it
// wrote. On the renderer's side the same rule is the field clearing on submit.

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
 * Shorter than §2's list, and deliberately. `init` writes files in-process,
 * `doctor` probes over fetch and `config set` splices a file — a cancel on any of
 * them is a button that does nothing. `upgrade` and `migrate` do spawn, but
 * through `spawnSync`, which blocks the process that called them; a cancel could
 * not be delivered while one is in flight, so offering the control would be a lie
 * about what it does. Making those two spawn asynchronously is what would add
 * them here.
 *
 * `secret set` spawns too, on a running install: one `compose exec` that returns
 * in under a second. It is left off because a cancel landing inside it would
 * leave the operator not knowing whether the value reached the store, and "run it
 * again" is a better answer to a slow one than "it may or may not be set".
 *
 * `pair` is absent for a different reason. Most of it is a mint over the network
 * and two file writes, with nothing to signal; the one child it spawns is the
 * nudge that finishes the pairing, and killing that would leave a config and an
 * `.env` written with nothing acting on them (#558).
 *
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
  | { install: string; verb: "doctor" }
  // Both arms of `config set` carry the fingerprint the caller was shown (#503,
  // #527 §11). A local edit racing a hand edit in a terminal is refused `stale`
  // exactly as a relayed one is; there is one writer and one check behind both.
  | {
      install: string;
      verb: "config set";
      /** Dotted path into the config, the same path the effective-config tree carries. */
      path: string;
      value: string | number | boolean | null;
      /** The `sha256:<hex>` of the file as the caller read it. */
      fingerprint: string;
      /**
       * On a workspace, the child whose config takes the edit, by its folder
       * (InstallDirectoryFacts.tenants). Omitted, the root config does.
       */
      tenant?: string;
    }
  // `value` is the secret itself. See the fourth rule above: it lives for the
  // run and appears in no file, no log and no line.
  | {
      install: string;
      verb: "secret set";
      /** The tenant whose store takes it. Omitted on a solo install. */
      tenant?: string;
      key: string;
      value: string;
    }
  /**
   * Pair this install with the relay the companion is signed in to (#527 §14).
   * It takes no arguments: the relay is the one main holds a device token for,
   * and the token it mints never crosses the bridge in either direction.
   */
  | { install: string; verb: "pair" };

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
