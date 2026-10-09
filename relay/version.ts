// Half of what the relay answers `GET /api/version` with (#525 §4): its own
// package version.
//
// The other half, the console protocol, is a constant in contracts and needs no
// module. This one is read off the `package.json` the relay is running out of.
// The relay versions with the bootstrapper and one changelog covers both
// (docs/relay.md), so there is no second version to keep in step and nothing to
// write into the image at build time.
//
// It lives apart from http.ts so that nothing reachable from the request handler
// touches a disk to answer a constant. serve.ts calls this once and hands the
// string over.
//
// The read happens once, at start-up, and a relay whose package.json cannot be
// read says `0.0.0` rather than refusing to boot. An unreadable version is a
// line on a screen that reads wrong; it is not a reason to take the fleet's
// only way in offline. `phoebe boot` makes the same call for the same reason
// (bootstrap/boot.ts, `LAUNCHER_VERSION`).

import { readFileSync } from "node:fs";
import { moduleDirOf, resolvePackageResource } from "../src/package-resource.ts";

/** The version a relay reports when its own package could not be read. */
export const UNKNOWN_VERSION = "0.0.0";

/**
 * The `phoebe-agent` version this relay is running, from the package root above
 * this module — the same walk-up every other shipped resource is found by, so a
 * checkout and an installed `node_modules/phoebe-agent` answer alike.
 *
 * `read` is a parameter so a test can hand in a package.json without one being
 * on disk.
 */
export function relayPackageVersion(
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): string {
  try {
    const parsed = JSON.parse(
      read(resolvePackageResource("package.json", moduleDirOf(import.meta.url))),
    ) as Record<string, unknown>;
    const version = parsed["version"];
    return typeof version === "string" && version.length > 0 ? version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}
