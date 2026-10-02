// Doctor's internal deadline (#507 §7).
//
// A doctor run reaches the network once per tenant repo, once per label list,
// and once per page of the stray-member walk. Any of those can hang on a
// tenant whose GitHub is having a bad day, and before this there was no overall
// timeout at all: one slow tenant could hold the whole report open forever, and
// a report nobody ever gets says nothing about the tenants that answered fine.
//
// So the run gets five minutes. What has not finished by then reports
// `unknown` — "deadline passed" — and the report is assembled from whatever the
// rest of the checks found. A partial answer with the gaps named is worth more
// than no answer, and `unknown` is the state doctor already uses for "could not
// be asked" (src/contracts/doctor.ts).
//
// Two things this deliberately does not do. It does not cancel the work it
// stopped waiting for: a `fetch` in flight is the runtime's to finish, and the
// only honest thing to do with its result is drop it. And it does not interrupt
// a synchronous check — `git ls-remote` and the npm lookups run to the timeouts
// they already carry, which is what keeps the deployment half of the report
// bounded without this. Where nothing else bounds the work — the tenant sweep's
// probes, and the kind-module loads ahead of them — the deadline is what does,
// by racing what it can ({@link Deadline.race}) and refusing to start what it
// cannot ({@link Deadline.expired}).
//
// The bootstrapper's kill at deadline + 30s (bootstrap/doctor-runner.ts) is the
// backstop for the case this one cannot cover: a doctor that never reaches
// either gate.

/** How long one doctor run has to answer before its unfinished checks go unknown. */
export const DOCTOR_DEADLINE_MS = 5 * 60 * 1000;

/** What a check that ran out of time says, in the `detail` every check carries. */
export const DEADLINE_DETAIL = "deadline passed — this check did not finish";

/** The result of racing work against the clock: it finished, or the clock won. */
export type Raced<T> = { done: true; value: T } | { done: false };

export type Deadline = {
  /** Has the clock run out? Ask before starting a check that cannot be raced. */
  expired: () => boolean;
  /** Wait for `work`, or give up on it when the deadline passes first. */
  race: <T>(work: Promise<T>) => Promise<Raced<T>>;
  /** Drop the timer. A CLI process must not be held open by its own deadline. */
  cancel: () => void;
};

/**
 * Start the clock. The timer is unrefed as well as cancellable, so a run that
 * finishes early never keeps the process alive waiting for its own deadline —
 * and a caller that forgets to cancel is not a hang.
 */
export function createDeadline(ms: number, now: () => number = Date.now): Deadline {
  const startedAt = now();
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const passed = new Promise<void>((resolve) => {
    timer = setTimeout(
      () => {
        fired = true;
        resolve();
      },
      Math.max(0, ms),
    );
    timer.unref?.();
  });
  return {
    expired: () => fired || now() - startedAt >= ms,
    race: async <T>(work: Promise<T>): Promise<Raced<T>> => {
      // Settled into a value either way, so the loser of the race is already
      // handled: an abandoned promise that rejects later would otherwise land
      // as an unhandled rejection and take the run down.
      const settled = work.then(
        (value): { ok: true; value: T } | { ok: false; error: unknown } => ({ ok: true, value }),
        (error: unknown): { ok: true; value: T } | { ok: false; error: unknown } => ({
          ok: false,
          error,
        }),
      );
      const outcome = await Promise.race([settled, passed.then(() => null)]);
      if (outcome === null) return { done: false };
      if (!outcome.ok) throw outcome.error;
      return { done: true, value: outcome.value };
    },
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/** A clock that never runs out — the default for a caller that passes none. */
export function noDeadline(): Deadline {
  return {
    expired: () => false,
    race: async <T>(work: Promise<T>): Promise<Raced<T>> => ({ done: true, value: await work }),
    cancel: () => {},
  };
}
