// Which feed the updater reads — the whole of **follows the relay** (#525 §5).
//
// One rule, two cases. Signed in to a relay, the only build this companion is
// ever offered is the relay's own version: the feed is pinned at that release's
// download directory, so an offer that exists is an offer the relay can serve.
// Signed out, there is nothing to follow and the feed is the newest stable
// release there is.
//
// The pin is a URL rather than a version compared against anything here. The
// relay publishes its version and this reads it; whether the build behind that
// URL is newer than the running one is `electron-updater`'s comparison to make,
// and with `allowDowngrade` false a relay behind this companion means no offer
// rather than an offer to go back.
//
// Both feeds are `generic` against github.com rather than the `github` provider.
// The provider derives its download paths from a tag it parses as a version, and
// this repo's tags are `phoebe-agent@x.y.z` (#525 §1) — a shape it would read as
// a version string of its own. Two plain URLs say the same thing and say it the
// way the releases are actually laid out. There is no token either way: the repo
// is public (#521 §8).

import { RELAY_ROUTES } from "phoebe-agent/contracts";
import type { RelayArmState, RelayVersion } from "phoebe-agent/contracts";

/** The releases, for a feed to hang off and for macOS to be sent to by hand. */
export const RELEASES_PAGE = "https://github.com/JesusFilm/phoebe/releases";

/** What `electron-updater` is pointed at. A `GenericServerOptions`, structurally. */
export type UpdateFeed = { provider: "generic"; url: string };

/**
 * Which feed applies, before it is a URL.
 *
 * `unread` is the third case and the reason this is not a nullable string: a
 * companion signed in to a relay that did not answer must not quietly fall back
 * to `latest`. It checks nothing at all until the relay is reachable again,
 * because the newest build there is may be one this relay cannot serve.
 */
export type FeedChoice =
  | { kind: "latest" }
  | { kind: "pinned"; version: string }
  | { kind: "unread"; message: string };

/** The feed for a choice, or null when there is nothing to read. */
export function feedFor(choice: FeedChoice): UpdateFeed | null {
  switch (choice.kind) {
    case "latest":
      // GitHub's own redirect to the newest non-prerelease release's assets,
      // which is the stable feed #525 §3 asks for and no second channel.
      return { provider: "generic", url: `${RELEASES_PAGE}/latest/download` };
    case "pinned":
      return {
        provider: "generic",
        url: `${RELEASES_PAGE}/download/phoebe-agent@${choice.version}`,
      };
    case "unread":
      return null;
  }
}

/**
 * Ask the relay what version it is, when there is a relay and a session to
 * follow. `GET /api/version` is the unauthenticated read (#525 §4), so this asks
 * with no token — but it asks only when signed in, because signed out is exactly
 * the case §5 hands to `latest`.
 */
export async function chooseFeed(
  arm: RelayArmState,
  fetch: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
): Promise<FeedChoice> {
  if (arm.url === null || arm.person === null) return { kind: "latest" };
  const url = new URL(RELAY_ROUTES.version, arm.url).toString();
  try {
    const response = await fetch(url);
    if (!response.ok) return { kind: "unread", message: `${url} did not answer its version` };
    const body = (await response.json()) as Partial<RelayVersion>;
    if (typeof body.version !== "string") {
      return { kind: "unread", message: `${url} answered without a version` };
    }
    return { kind: "pinned", version: body.version };
  } catch (error) {
    return { kind: "unread", message: error instanceof Error ? error.message : String(error) };
  }
}
