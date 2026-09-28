// Which feed the updater reads (#525 §3).
//
// The newest stable release there is, or one release pinned by its version. The
// pin is a URL rather than a version compared against anything here: whether the
// build behind it is newer than the running one is `electron-updater`'s
// comparison to make, and with `allowDowngrade` false an older pin means no
// offer rather than an offer to go back.
//
// Both feeds are `generic` against github.com rather than the `github` provider.
// The provider derives its download paths from a tag it parses as a version, and
// this repo's tags are `phoebe-agent@x.y.z` (#525 §1) — a shape it would read as
// a version string of its own. Two plain URLs say the same thing and say it the
// way the releases are actually laid out. There is no token either way: the repo
// is public (#521 §8).

/** The releases, for a feed to hang off and for macOS to be sent to by hand. */
export const RELEASES_PAGE = "https://github.com/JesusFilm/phoebe/releases";

/** What `electron-updater` is pointed at. A `GenericServerOptions`, structurally. */
export type UpdateFeed = { provider: "generic"; url: string };

/**
 * Which feed applies, before it is a URL.
 *
 * `unread` is the third case and the reason this is not a nullable string: a
 * feed nobody could work out checks nothing at all, rather than quietly falling
 * back to `latest`.
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
