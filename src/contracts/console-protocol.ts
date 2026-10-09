// The **console protocol** — the integer the relay's JSON + SSE API carries at
// `/api/version`, and the one thing a companion checks before it says anything
// else to a relay (#525 §4).
//
// It is the deployment rail's `protocol` (relay-protocol.ts) one layer out. That
// integer numbers the WebSocket a deployment dials; this one numbers the HTTP
// API a console reads. They move apart on purpose: a change to the JSON a page
// renders has nothing to do with the wire a deployment speaks, and one integer
// for both would make every console-only change read as a deployment
// incompatibility and force a rebuild of things that never changed.
//
// **The rule is the rail's rule, word for word.** The relay serves every console
// protocol up to its own, so a companion above its relay's is told to *upgrade
// the relay first* and makes no other call. A newer relay is fine — which is what
// lets an operator move the relay on a Tuesday without collecting every
// companion on the same afternoon.
//
// The comparison itself is not here. The relay never performs it — it publishes
// its integer and serves whoever is at or below it — so the only code that
// applies the rule is the console's, in `apps/console/src/relay-version.ts`.
// A function here would have to be mirrored by hand into index.mjs, and a
// mirrored function is a second implementation nobody diffs (index.ts).

/**
 * The console protocol this build speaks: the relay serves up to it, and the
 * console bundle asks for nothing above it.
 *
 * Bump it when the JSON or the event stream changes in a way an older console
 * would misread. Adding a field an old console ignores does not move it — the
 * same restraint `RELAY_PROTOCOL` is held to, and for the same reason: an
 * integer that moves every release is an integer that refuses every release.
 */
export const CONSOLE_PROTOCOL = 1;

/**
 * The body of `GET /api/version`, the relay's one unauthenticated read.
 *
 * Unauthenticated because the companion asks it *before* it has anywhere to put
 * a session: a companion that is too new for this relay must find that out
 * without signing in, and a version behind a cookie would be a version nobody
 * could reach in the case it exists for.
 */
export type RelayVersion = {
  /**
   * The relay's own `phoebe-agent` version, `x.y.z`. Shown to a person and
   * never compared — the integer beside it is what compatibility is decided on
   * (#506 rejected exact-version matching for the deployment wire, and this
   * inherits the reasoning).
   */
  version: string;
  /** The highest console protocol this relay serves. */
  console: number;
};
