// The **doctor report** — what one `phoebe doctor` run found (#507 §4-§7,
// map #497).
//
// It lives in contracts because three readers share it and only one of them
// runs the checks: the engine produces it (src/doctor.ts), the bootstrapper
// folds it into `state/deployment.json` (bootstrap/doctor-runner.ts), and a
// console renders it from the other side of a relay. A renderer that had to
// import the engine to know what a check looks like would be importing
// `node:fs` to draw a tick.
//
// The report is a flat list of verdicts, not a score. Every check says which of
// four states it is in and why in one line; `ok` is the report's only
// arithmetic, and it asks one question — did anything fail. A console counts
// fails and warns itself, which is counting, not deriving.
//
// The **relay answers none of these checks** (#507 §8). Every one of them reads
// the deployment's files, env, clone or credentials, or calls GitHub with them,
// so a relay holds the last report and nothing more. Its own facts — connected
// since, last heard, last close code — are a separate connection panel and
// never a `DoctorCheck`.

// The leaf vocabulary — a verdict, a check, a tenant row, a report — lives in
// doctor-report.ts and is re-exported here, so the section below and the checks
// that fill it name the same four states.
export type {
  CheckState,
  DoctorCheck,
  DoctorReport,
  MissingDeclaredEnvKey,
  TenantDoctorRow,
} from "./doctor-report.ts";
import type { DoctorReport } from "./doctor-report.ts";

/**
 * Why a run happened (#507 §6). Boot and reconcile are the deployment's own
 * moments, `schedule` is the six-hour clock, and `request` is a person asking —
 * the only one of the four that carries a `by`.
 */
export type DoctorTrigger = "boot" | "reconcile" | "request" | "schedule";

/**
 * How a run failed to produce a report. A doctor that runs past its own
 * deadline is killed by the bootstrapper (`timed-out`); anything else that ends
 * without parseable JSON crashed. There is no `failed` — a report full of
 * failing checks is a successful run.
 */
export type DoctorFailure = "timed-out" | "crashed";

/** The last run that produced no report, and when it gave up. */
export type DoctorAttempt = { at: string; outcome: DoctorFailure };

/**
 * The deployment report's doctor section (#507 §7) — the last report with its
 * age, whether one is running now, and whether the last attempt got anywhere.
 *
 * Three clocks, and none of them is an age: `at` is when the last report was
 * taken, `running.since` when the run in flight started, `lastAttempt.at` when
 * the last failed one gave up. A console subtracts; the deployment does not
 * carry a number that is stale the moment it is written.
 *
 * `report` is null until the first run returns one, which is the console's
 * "never". A kill or a crash never clears it: the last thing doctor managed to
 * say stands, with its age, beside the attempt that failed to replace it.
 */
export type DoctorSection = {
  report: DoctorReport | null;
  /** When {@link report} was taken. Null while there has never been one. */
  at: string | null;
  trigger: DoctorTrigger | null;
  /** Who asked, when a person did. */
  by?: string;
  /** A run is in flight. Written when it starts, so a console can say "running since". */
  running?: { since: string; trigger: DoctorTrigger };
  /**
   * The last attempt that produced no report. Absent when the last one did —
   * an attempt that succeeded is described by `report` and `at`, and leaving a
   * stale failure beside a fresh report would read as a fault that is over.
   */
  lastAttempt?: DoctorAttempt;
  updatedAt: string;
};
