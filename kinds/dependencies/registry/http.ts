// What the deps.dev and OSV clients share: an injected `fetch` and clock, a
// typed failure instead of a throw, and back-off on 429 and 5xx. Neither
// service publishes a rate limit or sends rate-limit headers
// (docs/research/renovate-extraction-spike.md, question 5), so the numbers
// below are this client's own choice, not a budget either service names.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Which client a failure came from, so the detector's log line can name it. */
export type RegistrySource = "deps.dev" | "osv";

export type RegistryFailure = {
  ok: false;
  source: RegistrySource;
  /** The last HTTP status seen; absent when the request never got an answer. */
  status?: number;
  error: string;
};

export type RegistryResult<T> = { ok: true; value: T } | RegistryFailure;

/** Tries per request, the first included. */
export const MAX_ATTEMPTS = 3;
/** The first back-off when the server names none; each retry doubles it. */
export const BASE_BACKOFF_MS = 1_000;
/** The longest a `retry-after` may hold one request. Past this the pass moves on. */
export const MAX_BACKOFF_MS = 60_000;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * `retry-after` in milliseconds, read as delta-seconds or an HTTP date, or
 * null when it is absent or unreadable.
 */
export function retryAfterMs(headers: Headers, nowMs: number): number | null {
  const value = headers.get("retry-after")?.trim();
  if (value === undefined || value === "") return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** `cache-control: max-age` in milliseconds, or null when there is none or `no-store` is set. */
export function maxAgeMs(headers: Headers): number | null {
  const value = headers.get("cache-control");
  if (value === null || /(?:^|,)\s*no-(?:store|cache)\b/i.test(value)) return null;
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(value);
  return match === null ? null : Number(match[1]) * 1_000;
}

/**
 * One JSON request with back-off. A 429 or 5xx is retried after the server's
 * `retry-after`, else an exponential wait; any other non-2xx, a network
 * error, or a body that is not JSON comes back as a failure at once.
 */
export async function requestJson(
  deps: { fetch: Fetch; clock: Clock; source: RegistrySource },
  url: string,
  init?: RequestInit,
): Promise<RegistryResult<{ body: unknown; headers: Headers }>> {
  const fail = (error: string, status?: number): RegistryFailure =>
    status === undefined
      ? { ok: false, source: deps.source, error }
      : { ok: false, source: deps.source, status, error };
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await deps.fetch(url, init);
    } catch (error) {
      return fail(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.ok) {
      try {
        return { ok: true, value: { body: await response.json(), headers: response.headers } };
      } catch {
        return fail(`${url}: response is not JSON`, response.status);
      }
    }
    if (!isRetryable(response.status) || attempt >= MAX_ATTEMPTS) {
      return fail(`${url}: HTTP ${response.status}`, response.status);
    }
    const wait =
      retryAfterMs(response.headers, deps.clock.now()) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
    if (wait > MAX_BACKOFF_MS) {
      return fail(`${url}: HTTP ${response.status}, retry-after ${wait} ms`, response.status);
    }
    await deps.clock.sleep(wait);
  }
}
