// Boot-time login identity cross-check (#149). Counter semantics in
// quarantine.ts depend on `github.login()` correctly telling Phoebe's own
// comments apart from foreign activity — `nextCount`'s `timed-out` branch
// resets to 0 only when a *foreign* comment lands after the marker's own
// `at` (quarantine.ts:449-511, `newestForeignCommentAt`). If the resolved
// login ever disagrees with the login already recorded on Phoebe's own
// marker comments — a bot/user token swap, a GitHub App identity change —
// every one of Phoebe's own marker edits looks foreign from that point on,
// so the counter resets on every record and can never reach quarantine
// threshold. That in-process hazard is guarded by the test alongside
// `nextCount`; this module is the boot-time trip-wire for the same drift
// surviving a credential change across restarts. It can only make the drift
// visible, not fix it — the fix is rotating the credential back or updating
// whichever consumer config it's read from.

import type { UnitMarkerAuthor } from "./github.ts";

/**
 * `null` when the logins agree, or no marker exists yet to compare against
 * (a fresh repo, or `newestUnitMarkerComment`'s bounded scan found nothing).
 * Otherwise a loud, single-line warning naming both identities.
 */
export function loginMismatchWarning(
  resolvedLogin: string,
  marker: UnitMarkerAuthor | null,
): string | null {
  if (marker === null || marker.authorLogin === resolvedLogin) {
    return null;
  }
  return (
    `⚠️ LOGIN IDENTITY MISMATCH: the resolved login is "${resolvedLogin}", but the newest ` +
    `Phoebe unit-tracking comment (${marker.createdAt}) was authored by "${marker.authorLogin}". ` +
    `From this point on, every one of Phoebe's own marker edits looks like foreign activity, and ` +
    `the timed-out counter can never reach quarantine threshold. Check for a bot/user token swap ` +
    `or a GitHub App identity change.`
  );
}
