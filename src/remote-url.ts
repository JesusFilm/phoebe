// Where a deployment learns its own tailnet URL on the host arm (map #690,
// decided in #694).
//
// On the sidecar arm the bootstrapper asks LocalAPI over the shared socket and
// needs nobody's help. On the host arm the container has no Tailscale of its
// own, and the machine's DNS name is known only to the host side — so `phoebe
// start` and `phoebe pair` write the URL they reconciled Serve for into one
// small file under `state/` on the data volume, through an exec into the
// container as uid 10001, and the bootstrapper reads it. Named volumes have no
// host path, which is why the hand-off is an exec rather than a write.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isInsideContainer } from "./execution-gate.ts";
import { resolveDataBase } from "./paths.ts";

/** The file, inside the deployment-level `state/` directory. */
export const REMOTE_URL_FILE = "remote-url";

export function remoteUrlPath(dataBase: string): string {
  return join(dataBase, "state", REMOTE_URL_FILE);
}

/** The URL as last written, or null when nothing has written one. */
export function readRemoteUrl(dataBase: string): string | null {
  const path = remoteUrlPath(dataBase);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Replace the file atomically, as every file on the volume is. */
export function writeRemoteUrl(dataBase: string, url: string): void {
  const path = remoteUrlPath(dataBase);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${REMOTE_URL_FILE}.tmp`);
  writeFileSync(tmp, `${url}\n`);
  renameSync(tmp, path);
}

/** Is this a URL a pairing link could be built on? `https://host[:port]`, nothing else. */
export function isTailnetUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/**
 * `phoebe remote-url <url>` — the in-container half of the hand-off. Not a
 * verb an operator types: `phoebe start` execs it. Refuses outside the
 * container, where there is no data volume to write into, and refuses a URL
 * that is not a plain `https://host[:port]`, since that is what a pairing link
 * is built on.
 */
export async function runRemoteUrlCli(
  argv: readonly string[],
  deps: { inContainer?: boolean; env?: NodeJS.ProcessEnv; write?: typeof writeRemoteUrl } = {},
): Promise<void> {
  if (!(deps.inContainer ?? isInsideContainer())) {
    throw new Error(
      "`phoebe remote-url` records the tailnet URL on the data volume and runs inside the " +
        "container; `phoebe start` execs it there. Nothing to do on the host.",
    );
  }
  const url = argv[0];
  if (url === undefined || argv.length !== 1 || !isTailnetUrl(url)) {
    throw new Error(
      `Usage: phoebe remote-url https://<node>.<tailnet>.ts.net[:port] (got ${JSON.stringify(argv)}).`,
    );
  }
  (deps.write ?? writeRemoteUrl)(resolveDataBase(deps.env ?? process.env), url);
}
