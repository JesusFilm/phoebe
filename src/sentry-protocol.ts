// The Sentry wire shapes two engine parts share (#470/#474): the `sentry`
// catalog kind reads a project through the web API, and the crash reporter
// posts Phoebe's own faults to a project through the envelope endpoint. Both
// start from the same two facts — where the collector is, and how a DSN names
// a project — so those live here once, dependency-free. GlitchTip speaks the
// same protocol on both sides; Bugsink only on ingest.

/** A DSN, taken apart: `https://<publicKey>@<host>[/<path>]/<projectId>`. */
export type ParsedDsn = {
  /** `https:` or `http:`. */
  protocol: string;
  /** Host with port, e.g. `o123.ingest.sentry.io`. */
  host: string;
  /** Any path prefix before the project id (self-hosted behind a sub-path). */
  pathPrefix: string;
  publicKey: string;
  projectId: string;
  /** The envelope endpoint: `<protocol>//<host><pathPrefix>/api/<projectId>/envelope/`. */
  envelopeUrl: string;
};

/**
 * Parse a DSN or throw a message naming what is wrong. The shape is the SDK
 * standard: scheme, a public key as the URL's username, a host, an optional
 * path, and the numeric project id as the last path segment. A secret key
 * (the legacy `key:secret@` form) is accepted and ignored.
 */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`Sentry DSN is not a URL: ${JSON.stringify(dsn)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Sentry DSN must be http(s), got ${url.protocol.replace(/:$/, "")}.`);
  }
  if (url.username.length === 0) {
    throw new Error("Sentry DSN carries no public key (expected https://<key>@<host>/<project>).");
  }
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const projectId = segments.pop();
  if (projectId === undefined || !/^\d+$/.test(projectId)) {
    throw new Error(
      "Sentry DSN must end in a numeric project id (expected https://<key>@<host>/<project>).",
    );
  }
  const pathPrefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  return {
    protocol: url.protocol,
    host: url.host,
    pathPrefix,
    publicKey: url.username,
    projectId,
    envelopeUrl: `${url.protocol}//${url.host}${pathPrefix}/api/${projectId}/envelope/`,
  };
}

/**
 * The web-API base for a collector URL as a tenant writes it: `https://sentry.io`
 * or a self-hosted origin, with or without a trailing slash. Anything that is
 * not an absolute http(s) URL is refused, naming the value.
 */
export function normalizeCollectorUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`collector url is not an absolute URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`collector url must be http(s): ${JSON.stringify(raw)}`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** The subset of `fetch` the two clients use, injectable for tests. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Perform one JSON request against the Sentry web API with a bearer token and a
 * hard timeout. A non-2xx answer throws, naming the status and the start of
 * the body (Sentry's error bodies are short JSON with a `detail` field); the
 * caller decides whether that kills a cycle or drops a unit.
 */
export async function sentryApiRequest<T>(opts: {
  fetchFn: FetchLike;
  url: string;
  token: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ body: T; headers: Headers }> {
  const signal =
    opts.signal === undefined
      ? AbortSignal.timeout(opts.timeoutMs)
      : AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
  const response = await opts.fetchFn(opts.url, {
    method: "GET",
    headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Sentry API ${response.status} for ${opts.url}: ${text.slice(0, 300) || "(empty body)"}`,
    );
  }
  return { body: (await response.json()) as T, headers: response.headers };
}

/**
 * The `next` cursor URL out of a Sentry `Link` header, or null when the page
 * is the last (`results="false"`) or the header is absent. Sentry sends a
 * cursor even for an empty next page, so `results` is the thing to read.
 */
export function nextPageUrl(linkHeader: string | null): string | null {
  if (linkHeader === null) return null;
  for (const part of linkHeader.split(",")) {
    const url = /<([^>]+)>/.exec(part)?.[1];
    if (url === undefined || !/rel="next"/.test(part)) continue;
    return /results="true"/.test(part) ? url : null;
  }
  return null;
}
