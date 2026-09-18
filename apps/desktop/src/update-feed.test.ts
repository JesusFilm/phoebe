// Follows the relay: which feed a companion reads, and when it reads none.

import { describe, expect, test } from "vite-plus/test";
import type { RelayArmState } from "phoebe-agent/contracts";
import { chooseFeed, feedFor, RELEASES_PAGE } from "./update-feed.ts";

/** Signed in to a relay, which is the only state that follows one. */
const SIGNED_IN: RelayArmState = {
  url: "https://relay.example.test",
  person: { sub: "108", email: "ada@example.test" },
  persisted: true,
};

/** A relay that answers `/api/version` with whatever it is handed. */
function relay(body: unknown, ok = true) {
  const asked: string[] = [];
  const fetch = (url: string) => {
    asked.push(url);
    return Promise.resolve({ ok, json: () => Promise.resolve(body) });
  };
  return { fetch, asked };
}

describe("choosing the feed", () => {
  test("signed out is the newest stable release, with no relay asked", async () => {
    const { fetch, asked } = relay({ version: "9.9.9", console: 1 });
    const choice = await chooseFeed({ url: null, person: null, persisted: false }, fetch);

    expect(choice).toEqual({ kind: "latest" });
    expect(asked).toEqual([]);
  });

  test("a relay URL with nobody signed in is still latest", async () => {
    // The URL is on `companion.json` from the moment a pairing wrote it; the
    // session is the thing §5 gates the pin on.
    const { fetch } = relay({ version: "0.12.0", console: 1 });
    const choice = await chooseFeed({ ...SIGNED_IN, person: null }, fetch);

    expect(choice).toEqual({ kind: "latest" });
  });

  test("signed in pins to the relay's own version", async () => {
    const { fetch, asked } = relay({ version: "0.12.0", console: 1 });
    const choice = await chooseFeed(SIGNED_IN, fetch);

    expect(choice).toEqual({ kind: "pinned", version: "0.12.0" });
    expect(asked).toEqual(["https://relay.example.test/api/version"]);
  });

  test("a relay that cannot be read is unread, never latest", async () => {
    // The point of the third case: falling back to the newest build there is
    // would offer a companion this relay may not serve.
    const unreachable = () => Promise.reject(new Error("fetch failed"));

    expect(await chooseFeed(SIGNED_IN, unreachable)).toEqual({
      kind: "unread",
      message: "fetch failed",
    });
  });

  test("a relay answering something else is unread too", async () => {
    const { fetch } = relay({ console: 1 });
    expect(await chooseFeed(SIGNED_IN, fetch)).toMatchObject({ kind: "unread" });

    const refused = relay("", false);
    expect(await chooseFeed(SIGNED_IN, refused.fetch)).toMatchObject({ kind: "unread" });
  });
});

describe("the feed URL", () => {
  test("latest is GitHub's own redirect to the newest release", () => {
    expect(feedFor({ kind: "latest" })).toEqual({
      provider: "generic",
      url: `${RELEASES_PAGE}/latest/download`,
    });
  });

  test("pinned is the release the relay's version is tagged at", () => {
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
