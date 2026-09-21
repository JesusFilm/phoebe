// The bootstrapper's doctor runs (#507 §4-§7, #534) — what turns `phoebe
// doctor` from a command somebody remembers to type into a fact the deployment
// report always carries.
//
// **Why the supervisor spawns a child rather than calling `runDoctor`.** Two
// reasons, and both are about the supervisor surviving. A child can be killed
// on a deadline; an await cannot. And a bug in a check — an unbounded graph
// walk, a throw from a tenant's own kind module — takes the child down and
// leaves supervision running, which is the whole point of a supervisor.
//
// **Why it is worth the spawn.** The child is handed the installation tokens
// the supervisor already holds (src/doctor-lease.ts), so `repo`, `labels` and
// `stray-members` are answered for App-arm tenants instead of skipped. A manual
// `phoebe doctor` has no such leases and no way to get them; it also prints and
// touches nothing, so the two never collide over the report (#507 §4 — a shared
// result file would have needed the file watch #501 rejected).
//
// **One run at a time.** A trigger that arrives while a run is in flight joins
// it and gets that run's result: doctor is a read of the same world, so two
// concurrent runs would spend two tenants' API budgets to answer one question.
// A trigger that arrives mid-reconcile is parked instead — the fleet is being
// drained onto a different engine, and a report of a deployment halfway between
// two engines describes neither — and runs once when the fleet is back up.
//
// **The clocks.** Doctor holds itself to five minutes internally
// (src/doctor-deadline.ts); this kills the child thirty seconds later, which
// only bites when the child is too wedged to honour its own deadline. On a kill
// the last completed report stays in the section with its age, and the attempt
// is recorded beside it — a deployment whose doctor stopped answering must not
// look like a deployment whose doctor said everything was fine.

import { spawn } from "node:child_process";
import type {
  DoctorFailure,
  DoctorReport,
  DoctorSection,
  DoctorTrigger,
} from "../src/contracts/doctor.ts";
import { DOCTOR_DEADLINE_MS } from "../src/doctor-deadline.ts";
import { DOCTOR_LEASE_ENV, encodeDoctorLeases, type DoctorLeases } from "../src/doctor-lease.ts";

/** The fixed schedule (#507 §6): four runs a day, jittered per deployment. */
export const DOCTOR_SCHEDULE_MS = 6 * 60 * 60 * 1000;

/**
 * How far a deployment's own schedule may sit off the six-hour boundary. Fixed
 * at startup and applied to every wait, so a host running twenty containers
 * does not send twenty doctors at GitHub in the same second.
 */
export const DOCTOR_SCHEDULE_JITTER_MS = 30 * 60 * 1000;

/** The backstop after doctor's own deadline: it had five minutes, then thirty seconds. */
export const DOCTOR_KILL_GRACE_MS = 30 * 1000;

/** How long a killed child gets to die politely before SIGKILL. */
const DOCTOR_SIGKILL_AFTER_MS = 5 * 1000;

/** Stdout we keep from the child. A report is kilobytes; anything past this is a fault. */
const DOCTOR_STDOUT_LIMIT = 4 * 1024 * 1024;

/** What one run produced: a report, or the reason there is none. */
export type DoctorRunResult =
  | { outcome: "ok"; report: DoctorReport }
  | { outcome: DoctorFailure; detail: string };

export type DoctorRunner = {
  /**
   * Ask for a run. A run already in flight is joined rather than doubled, and a
   * reconcile parks the ask until the fleet is back up — so the returned
   * promise is "the result of the run your trigger belongs to", which is what
   * a console receipt needs it to be.
   */
  request: (trigger: DoctorTrigger, by?: string) => Promise<DoctorRunResult>;
  /** The engine axis is moving: park triggers until the fleet comes back. */
  noteReconcile: () => void;
  /**
   * A child was spawned, so the fleet is up. The first one is this deployment's
   * boot trigger; a later one releases whatever the reconcile parked.
   */
  noteFleetUp: () => void;
  /** Arm the six-hour schedule. */
  start: () => void;
  /** Drop the schedule. The container is going down; nothing is cancelled mid-run. */
  stop: () => void;
};

type Timer = { clear: () => void };

export type DoctorRunnerDeps = {
  /** Start one run. Injected so the supervisor's tests never spawn anything. */
  run: (trigger: DoctorTrigger) => Promise<DoctorRunResult>;
  /** The section as it now stands, for the deployment report. */
  onSection: (section: Omit<DoctorSection, "updatedAt">) => void;
  now?: () => number;
  scheduleMs?: number;
  /** A fraction in [0, 1) — this deployment's place in the jitter window. */
  jitter?: () => number;
  /** Injected for tests; the real one is an unrefed `setTimeout`. */
  setTimer?: (ms: number, fire: () => void) => Timer;
  /** A run that produced nothing. One log line, so a silent doctor is not silent. */
  onFailure?: (result: { outcome: DoctorFailure; detail: string }) => void;
};

const defaultTimer = (ms: number, fire: () => void): Timer => {
  const handle = setTimeout(fire, ms);
  // Unrefed: the six-hour clock must never be the reason a drained container
  // stays alive.
  handle.unref?.();
  return { clear: () => clearTimeout(handle) };
};

/**
 * Build the runner. Nothing runs until {@link DoctorRunner.start} arms the
 * schedule and the fleet's first child reports up.
 */
export function createDoctorRunner(deps: DoctorRunnerDeps): DoctorRunner {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;
  const scheduleMs = deps.scheduleMs ?? DOCTOR_SCHEDULE_MS;
  const jitter = deps.jitter ?? Math.random;
  // Once, at startup: a constant offset shifts this deployment's boundary off
  // every other deployment's without making its own cadence unpredictable.
  const offsetMs = Math.floor(jitter() * DOCTOR_SCHEDULE_JITTER_MS);

  const iso = (ms: number): string => new Date(ms).toISOString();

  /** The section's history: everything a run can move, and nothing it cannot. */
  let report: DoctorReport | null = null;
  let at: string | null = null;
  let trigger: DoctorTrigger | null = null;
  let by: string | undefined;
  let running: { since: string; trigger: DoctorTrigger } | undefined;
  let lastAttempt: { at: string; outcome: DoctorFailure } | undefined;

  let inFlight: Promise<DoctorRunResult> | null = null;
  let reconciling = false;
  let booted = false;
  let schedule: Timer | null = null;
  let stopped = false;
  /** A trigger the reconcile parked, and everyone waiting on the run it becomes. */
  let parked: {
    trigger: DoctorTrigger;
    by?: string;
    promise: Promise<DoctorRunResult>;
    release: (result: Promise<DoctorRunResult>) => void;
  } | null = null;

  const publish = (): void => {
    deps.onSection({
      report,
      at,
      trigger,
      ...(by !== undefined ? { by } : {}),
      ...(running !== undefined ? { running } : {}),
      ...(lastAttempt !== undefined ? { lastAttempt } : {}),
    });
  };

  const arm = (): void => {
    if (stopped) return;
    schedule?.clear();
    schedule = setTimer(scheduleMs + offsetMs, () => {
      void beginRun("schedule").catch(() => {});
    });
  };

  const beginRun = (nextTrigger: DoctorTrigger, nextBy?: string): Promise<DoctorRunResult> => {
    if (inFlight !== null) return inFlight;
    running = { since: iso(now()), trigger: nextTrigger };
    publish();
    const run = deps
      .run(nextTrigger)
      .catch((error: unknown): DoctorRunResult => ({
        outcome: "crashed",
        detail: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        inFlight = null;
        running = undefined;
        if (result.outcome === "ok") {
          report = result.report;
          at = iso(now());
          trigger = nextTrigger;
          by = nextBy;
          // The last attempt succeeded, so there is no failed one to show. The
          // failure that came before it is described by nothing else and is
          // over; leaving it would read as a doctor still not answering.
          lastAttempt = undefined;
        } else {
          lastAttempt = { at: iso(now()), outcome: result.outcome };
          deps.onFailure?.(result);
        }
        publish();
        // Rearmed from the end of a run, not on a fixed grid: six hours after
        // this one finished is six hours of not having asked.
        arm();
        return result;
      });
    inFlight = run;
    return run;
  };

  const park = (nextTrigger: DoctorTrigger, nextBy?: string): Promise<DoctorRunResult> => {
    if (parked !== null) return parked.promise;
    let release!: (result: Promise<DoctorRunResult>) => void;
    const promise = new Promise<DoctorRunResult>((resolve) => {
      release = (result) => resolve(result);
    });
    parked = {
      trigger: nextTrigger,
      ...(nextBy !== undefined ? { by: nextBy } : {}),
      promise,
      release,
    };
    return promise;
  };

  const request = (nextTrigger: DoctorTrigger, nextBy?: string): Promise<DoctorRunResult> => {
    if (stopped) {
      return Promise.resolve({ outcome: "crashed", detail: "the deployment is shutting down" });
    }
    if (inFlight !== null) return inFlight;
    if (reconciling) return park(nextTrigger, nextBy);
    return beginRun(nextTrigger, nextBy);
  };

  return {
    request,

    noteReconcile() {
      reconciling = true;
      // The reconcile is itself a trigger (#507 §6), and like any other trigger
      // arriving mid-reconcile it waits for the relaunch.
      void park("reconcile").catch(() => {});
    },

    noteFleetUp() {
      const first = !booted;
      booted = true;
      reconciling = false;
      const waiting = parked;
      parked = null;
      // The relaunch landed: whatever the reconcile parked runs now, once,
      // however many triggers arrived while the fleet was down.
      if (waiting !== null) {
        waiting.release(beginRun(waiting.trigger, waiting.by));
        return;
      }
      if (first) void request("boot").catch(() => {});
    },

    start() {
      stopped = false;
      arm();
    },

    stop() {
      stopped = true;
      schedule?.clear();
      schedule = null;
    },
  };
}

/**
 * Spawn `phoebe doctor --json` from the bootstrapper's own installed package
 * and read the report off its stdout.
 *
 * stdout is captured because it carries the report; stderr is inherited, so a
 * doctor that complains does it into the container's log where an operator
 * already looks. The JSON is taken from the last line that looks like an
 * object: a kind module loaded by the declared-key scan is free to print, and
 * one stray line on stdout must not cost the report.
 */
export function spawnDoctor(opts: {
  /** The bootstrapper's own entry — `bootstrap/cli.ts` in the materialized package. */
  entry: string;
  /** The deployment's config dir: doctor resolves its config from cwd. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Tenant slug → installation token, for the App-arm checks (#507 §5). */
  leases: DoctorLeases;
  /** When to kill the child: doctor's own deadline plus the grace. */
  killAfterMs?: number;
}): Promise<DoctorRunResult> {
  const killAfterMs = opts.killAfterMs ?? DOCTOR_DEADLINE_MS + DOCTOR_KILL_GRACE_MS;
  const leases = encodeDoctorLeases(opts.leases);
  return new Promise<DoctorRunResult>((resolve) => {
    let settled = false;
    const settle = (result: DoctorRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      resolve(result);
    };

    const child = spawn(process.execPath, [opts.entry, "doctor", "--json"], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...opts.env,
        // Absent rather than empty when there is nothing to lease, so a manual
        // run's env and a leaseless supervisor run's env are the same env.
        ...(leases === "" ? {} : { [DOCTOR_LEASE_ENV]: leases }),
      },
    });

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < DOCTOR_STDOUT_LIMIT) stdout += chunk;
    });

    let killed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineTimer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), DOCTOR_SIGKILL_AFTER_MS);
      killTimer.unref?.();
    }, killAfterMs);
    deadlineTimer.unref?.();

    child.on("error", (error: Error) => {
      settle({ outcome: "crashed", detail: error.message });
    });

    child.on("close", (code, signal) => {
      const report = parseDoctorStdout(stdout);
      // A report is a report whatever the exit code: doctor exits 1 when a
      // check failed, which is a run that worked.
      if (report !== null) {
        settle({ outcome: "ok", report });
        return;
      }
      if (killed) {
        settle({
          outcome: "timed-out",
          detail: `killed after ${Math.round(killAfterMs / 1000)}s without a report`,
        });
        return;
      }
      settle({
        outcome: "crashed",
        detail:
          signal !== null
            ? `doctor died on ${signal} without a report`
            : `doctor exited ${code ?? "?"} without a report on stdout`,
      });
    });
  });
}

/**
 * The report out of a child's stdout, or null when there is none to have. The
 * last JSON-object line wins — `--json` prints the report last, and anything a
 * check printed on the way past is behind it.
 */
export function parseDoctorStdout(stdout: string): DoctorReport | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isDoctorReport(parsed)) return parsed;
  }
  return null;
}

function isDoctorReport(value: unknown): value is DoctorReport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DoctorReport>;
  return (
    Array.isArray(candidate.checks) &&
    Array.isArray(candidate.tenants) &&
    typeof candidate.ok === "boolean"
  );
}
