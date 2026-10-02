// The one thing in the scheme handler that is a boundary rather than plumbing:
// which files a page loaded from `phoebe://console/` can reach.

import { describe, expect, test } from "vite-plus/test";
import { consoleFileFor, CONSOLE_URL } from "./console-scheme.ts";

const BUNDLE = "/opt/companion/console";

describe("a request on the console scheme", () => {
  test("lands on index.html at the root, which is the console's only entry", () => {
    expect(consoleFileFor(CONSOLE_URL, BUNDLE)).toBe("/opt/companion/console/index.html");
    expect(consoleFileFor("phoebe://console/", BUNDLE)).toBe("/opt/companion/console/index.html");
  });

  test("resolves an asset to its file under the bundle", () => {
    expect(consoleFileFor("phoebe://console/assets/main-a1b2.js", BUNDLE)).toBe(
      "/opt/companion/console/assets/main-a1b2.js",
    );
  });

  test("ignores the query and the hash, because the console routes on the hash", () => {
    expect(consoleFileFor("phoebe://console/index.html#/fleet", BUNDLE)).toBe(
      "/opt/companion/console/index.html",
    );
  });

  test("refuses a climb the URL parser did not already fold away", () => {
    // A whole segment of dots the parser removes itself; an encoded slash keeps
    // the climb in one segment, so it survives as far as the decode. That is the
    // case the containment check exists for.
    expect(consoleFileFor("phoebe://console/assets/%2e%2e%2f%2e%2e%2fid_rsa", BUNDLE)).toBeNull();
    expect(consoleFileFor("phoebe://console/%2e%2e%2f.env", BUNDLE)).toBeNull();
  });

  test("refuses a sibling directory whose name starts with the bundle's", () => {
    expect(
      consoleFileFor("phoebe://console/%2e%2e%2fconsole-backup%2findex.html", BUNDLE),
    ).toBeNull();
  });

  test("a climb the parser folds away lands inside the bundle, not above it", () => {
    expect(consoleFileFor("phoebe://console/../../.env", BUNDLE)).toBe(
      "/opt/companion/console/.env",
    );
  });

  test("answers nothing for another host on the scheme, so sign-in's deep link stays free", () => {
    expect(consoleFileFor("phoebe://auth?code=abc", BUNDLE)).toBeNull();
  });

  test("answers nothing for another scheme or a URL that does not parse", () => {
    expect(consoleFileFor("https://console/index.html", BUNDLE)).toBeNull();
    expect(consoleFileFor("not a url", BUNDLE)).toBeNull();
  });
});
