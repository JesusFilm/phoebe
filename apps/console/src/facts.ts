// Ages and spans, in the coarse words every tab prints them in.

/**
 * An ISO instant as an age — `12 s`, `23 min`, `6 h`, `2 d`. Coarse on purpose:
 * a second-precise age on something two days old is noise that moves every
 * render.
 */
export function age(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  return duration(Math.max(0, now.getTime() - then));
}

/**
 * A span in the same coarse words {@link age} prints, for the spans a report
 * hands over already measured — a wedged verdict's silence, a unit's budget.
 */
export function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
