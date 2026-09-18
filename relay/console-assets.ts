// The console's build, served out of the installed package (#506 §1, #522 §5).
//
// `apps/console` builds into `<package>/console`, which the root package lists in
// its published `files`. So the relay finds the bundle next to its own source
// whether it is running from a checkout or from `node_modules/phoebe-agent`, and
// there is no second artifact to install, no CDN, and nothing to keep in version
// step with the relay: one package holds both ends of the API.
//
// **No single-page fallback, because the console routes on the hash.** A path this
// module does not have a file for is a 404 from the relay, exactly as it was
// before the console existed — and a request under `/api` that fell through to an
// HTML page would be far worse than one that 404s. The pages are `#/fleet`,
// `#/d/<fingerprint>` and so on, which never reach the server, so the fallback
// buys nothing and costs the relay its ability to say "no such route".
//
// The bundle itself is public. It has to be: the sign-in page is part of it, and
// a person with no session is precisely who needs it. Everything it then asks for
// is behind the session cookie, and the bundle carries no secret — a hashed
// filename is not one.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

/**
 * Where the build lands. Resolved from this file, so a checkout and an installed
 * package answer the same way, and `phoebe relay serve` needs no path setting.
 */
export const CONSOLE_DIR: string = resolve(import.meta.dirname, "..", "console");

/** The document every hash route is served under. */
const ENTRY = "index.html";

export type ConsoleAssets = {
  /** The directory being served. */
  dir: string;
  /** Was the console built? False when nobody ran `vp run -r build`. */
  built: boolean;
  /**
   * Answer for one path, or report that this is not the console's to answer.
   * False leaves the caller free to 404 in its own words.
   */
  serve: (pathname: string, response: ServerResponse) => Promise<boolean>;
};

export function createConsoleAssets(dir: string = CONSOLE_DIR): ConsoleAssets {
  // Read once at construction. A relay that gained a console build while it was
  // running would be a relay whose package changed under it, which is a restart.
  const built = existsSync(join(dir, ENTRY));

  return {
    dir,
    built,
    async serve(pathname, response) {
      const file = fileFor(dir, pathname);
      if (file === null) return false;

      if (!built) {
        // Only for the document. An asset request with no build is somebody's
        // stale tab, and a sentence of prose is not what it asked for.
        if (file !== join(dir, ENTRY)) return false;
        notBuilt(response, dir);
        return true;
      }

      let body: Buffer;
      try {
        body = await readFile(file);
      } catch {
        return false;
      }
      response
        .writeHead(200, {
          "content-type": contentType(file),
          "content-length": body.byteLength,
          // Vite writes the build hash into every asset filename, so an asset is
          // immutable by construction and the document never is.
          "cache-control": file.startsWith(join(dir, "assets") + sep)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        })
        .end(body);
      return true;
    },
  };
}

/**
 * The file one request path names, or null when the console does not serve that
 * path at all.
 *
 * The containment check is the security boundary: the path comes off the wire and
 * names a file on the relay's disk, so a resolved path that is not under the
 * build directory is refused rather than read. `decodeURIComponent` runs first,
 * because `%2e%2e` is `..` by the time the filesystem sees it.
 */
function fileFor(dir: string, pathname: string): string | null {
  if (pathname === "/") return join(dir, ENTRY);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // A NUL truncates a path inside libc; refuse it before it reaches a syscall.
  if (decoded.includes("\0")) return null;
  const candidate = resolve(dir, `.${normalize(decoded)}`);
  if (candidate !== dir && !candidate.startsWith(dir + sep)) return null;
  return candidate;
}

/** The types the console's build actually emits, and nothing speculative. */
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function contentType(file: string): string {
  const dot = file.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * The honest answer when the package was assembled without building the console:
 * the relay works, the API answers, and the pages are missing. 503, because it is
 * this server that is incomplete rather than the request that was wrong.
 */
function notBuilt(response: ServerResponse, dir: string): void {
  const payload =
    `The Phoebe relay is running, but the console's build is not in this package.\n` +
    `Expected it at ${dir}. Build it with \`vp run -r build\` from the repo root.\n` +
    `The relay's API is unaffected.\n`;
  response
    .writeHead(503, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    })
    .end(payload);
}
