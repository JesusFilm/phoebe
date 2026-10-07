// The **console scheme** — how the window's renderer reaches the console bundle
// on disk.
//
// The companion does not serve the bundle over `file:` and does not run an HTTP
// server for it. `file:` gives every page an opaque origin, which costs the
// bundle `localStorage`, `fetch` and a stable origin for anything a later
// ticket wants to key on; a loopback server would be a second listener, and
// #506 §"the relay is the only listener" says there is exactly one. So the
// bundle gets a scheme of its own, registered privileged before the app is
// ready, and a handler that maps one URL to one file under the bundle's
// directory (#522 §4, T3 Code's shape).
//
// The mapping is here, apart from Electron, because it is the security boundary:
// a request that resolves outside the bundle directory has to come back null,
// and that is a thing a test can hold.

import path from "node:path";

/** The scheme the renderer is served on. */
export const CONSOLE_SCHEME = "phoebe";

/**
 * The host under it. A host rather than a bare path so the scheme has room for
 * the sign-in deep link `phoebe://auth?code=…` (#554) without either one having
 * to move.
 */
export const CONSOLE_HOST = "console";

/** The URL the window loads. The console routes on the hash, so this is its only entry. */
export const CONSOLE_URL = `${CONSOLE_SCHEME}://${CONSOLE_HOST}/index.html`;

/**
 * The file one request on the console scheme is asking for, or null when it is
 * asking for something the bundle does not hold.
 *
 * Null, not a throw: the handler answers 404 either way, and a malformed URL is
 * a page asking for something rather than the app being broken.
 */
export function consoleFileFor(url: string, bundleDir: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${CONSOLE_SCHEME}:` || parsed.host !== CONSOLE_HOST) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  const root = path.resolve(bundleDir);
  const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);

  // The URL parser folds a literal `..` away, but a percent-encoded one survives
  // it and only becomes `..` at the decode above. Containment is what actually
  // holds the boundary, so it is checked on the resolved path and nowhere else.
  return file === root || file.startsWith(root + path.sep) ? file : null;
}
