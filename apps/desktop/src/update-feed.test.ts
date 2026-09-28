// Which feed a companion reads, and when it reads none.

import { describe, expect, test } from "vite-plus/test";
import { feedFor, RELEASES_PAGE } from "./update-feed.ts";

describe("the feed URL", () => {
  test("latest is GitHub's own redirect to the newest release", () => {
    expect(feedFor({ kind: "latest" })).toEqual({
      provider: "generic",
      url: `${RELEASES_PAGE}/latest/download`,
    });
  });

  test("pinned is the release a version is tagged at", () => {
    // The tag the packaging stage attaches to (#525 §1), verbatim.
    expect(feedFor({ kind: "pinned", version: "0.12.0" })).toEqual({
      provider: "generic",
      url: `${RELEASES_PAGE}/download/phoebe-agent@0.12.0`,
    });
  });

  test("unread has no feed at all", () => {
    expect(feedFor({ kind: "unread", message: "nope" })).toBeNull();
  });
});
