// What the companion knows about a newer build of itself (#525 §3, §5).
//
// The companion is distributed on its own — a GitHub Release artifact or a
// self-build — so it is the one piece of Phoebe that has to move itself. How it
// moves is `electron-updater` against the releases the packaging stage attaches;
// what it is allowed to move *to* is the relay's business, which is the rule
// #525 §5 calls **follows the relay**.
//
// Everything here is a state rather than a verb, because nothing about an update
// happens on its own: the check runs once at launch, the download waits for a
// click, and the install waits for the app to quit. A tool that drives Docker on
// the operator's machine does not swap itself out while they are watching.

/**
 * Where an update stands, as the companion's main process knows it.
 *
 *  - `unsupported` — this build does not update itself. macOS until the signing
 *    task lands (Squirrel.Mac refuses an unsigned bundle), and any companion run
 *    from a checkout. `reason` is the sentence to show and `releases` the page to
 *    send the operator to, because "nothing happens" is not an answer a window
 *    can render (#527's note on #525).
 *  - `checking` — the launch check is in flight. Where every supported companion
 *    starts, since the check is fired as soon as the window is up.
 *  - `current` — the feed offers nothing newer. Includes the case where the feed
 *    is pinned to a relay older than this companion: `allowDowngrade` is false,
 *    so a build behind this one is not an offer to go back (#525 §5).
 *  - `available` — there is a newer build. Nothing is downloaded yet; that takes
 *    a call to `download`.
 *  - `downloading` — with the percentage, so a window can show progress rather
 *    than a spinner over a 120 MB transfer.
 *  - `ready` — downloaded and staged. It installs when the app quits, or sooner
 *    if the operator asks for a restart.
 *  - `unread` — nobody could ask, or the feed did not answer. Not a verdict: a
 *    companion signed in to a relay it cannot reach lands here rather than
 *    silently falling back to the newest build there is, which could be one the
 *    relay does not serve.
 */
export type CompanionUpdate =
  | { kind: "unsupported"; reason: string; releases: string }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "unread"; message: string };
