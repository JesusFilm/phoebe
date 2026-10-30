// tailscaled's LocalAPI over the socket the sidecar shares (map #690, read in
// #692 and verified live against `v1.104.1`).
//
// On the sidecar arm the daemon's socket sits in `/var/run/phoebe`, the
// directory both services mount, and uid 10001 may read from it: `IsReadonlyConn`
// gives a stranger uid 200 on status and `GET serve-config`, 403 on anything
// that writes. Two requirements and no token: `Host: local-tailscaled.sock`
// (Node's default Host is refused 403) and no `Origin` or `Referer`.

import { request as httpRequest } from "node:http";

/** The daemon's socket, as `TS_SOCKET` names it in the sidecar overlay. */
export const TAILSCALED_SOCKET = "/var/run/phoebe/tailscaled.sock";

/** The Host header LocalAPI requires on a Unix socket. */
export const LOCALAPI_HOST = "local-tailscaled.sock";

/** How long one LocalAPI call may take. The daemon answers from memory. */
const LOCALAPI_TIMEOUT_MS = 5_000;

export type LocalApiResponse = { status: number; body: string };

/** One GET over the socket. Injectable so nothing in tests opens a socket. */
export type LocalApiGet = (path: string) => Promise<LocalApiResponse>;

export function localApiGet(socketPath: string = TAILSCALED_SOCKET): LocalApiGet {
  return (path) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { socketPath, path, method: "GET", headers: { host: LOCALAPI_HOST } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", reject);
        },
      );
      req.setTimeout(LOCALAPI_TIMEOUT_MS, () => req.destroy(new Error("LocalAPI timed out")));
      req.on("error", reject);
      req.end();
    });
}

/** What the status call says, down to the three fields this needs. */
export type LocalApiStatus = {
  backendState: string;
  /** `host.<tailnet>.ts.net`, the trailing dot stripped. Null before login. */
  dnsName: string | null;
  /** `CertDomains[0]`, what containerboot substitutes for `${TS_CERT_DOMAIN}`. */
  certDomain: string | null;
};

export function parseLocalApiStatus(body: string): LocalApiStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as {
    BackendState?: unknown;
    Self?: { DNSName?: unknown };
    CertDomains?: unknown;
  };
  const dns = record.Self?.DNSName;
  const certs = Array.isArray(record.CertDomains) ? record.CertDomains : [];
  return {
    backendState: typeof record.BackendState === "string" ? record.BackendState : "unknown",
    dnsName: typeof dns === "string" && dns.length > 0 ? dns.replace(/\.$/, "") : null,
    certDomain: typeof certs[0] === "string" ? certs[0] : null,
  };
}

/** `GET /localapi/v0/status?peers=false`, or null when the daemon does not answer. */
export async function readLocalApiStatus(get: LocalApiGet): Promise<LocalApiStatus | null> {
  try {
    const res = await get("/localapi/v0/status?peers=false");
    if (res.status !== 200) return null;
    return parseLocalApiStatus(res.body);
  } catch {
    return null;
  }
}

/**
 * Does the daemon's Serve config proxy to `socket`? Null when the config could
 * not be read; false when it was read and does not. containerboot substitutes
 * the cert domain and posts the file, so this is what tells an operator whether
 * `serve.json` landed.
 */
export async function serveConfigProxiesTo(
  get: LocalApiGet,
  socket: string,
): Promise<boolean | null> {
  let body: string;
  try {
    const res = await get("/localapi/v0/serve-config");
    if (res.status !== 200) return null;
    body = res.body;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const web = (
    parsed as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> } | null
  )?.Web;
  if (typeof web !== "object" || web === null) return false;
  return Object.values(web).some((site) =>
    Object.values(site.Handlers ?? {}).some((handler) => handler.Proxy === `unix:${socket}`),
  );
}

/** The tailnet URL for a node that has joined, or null until it has. */
export function tailnetUrlOf(status: LocalApiStatus | null): string | null {
  if (status === null || status.backendState !== "Running" || status.dnsName === null) {
    return null;
  }
  return `https://${status.dnsName}`;
}
