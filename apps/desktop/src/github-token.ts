// Checking a GitHub token against its repo (contracts/github-token.ts).
//
// The probes are scripts/token-probe-lib.mjs's, imported rather than copied:
// one table of five, each a request whose status code says granted or missing
// and whose write half aims at a target that does not exist, so nothing here
// mutates the repo. What this module adds is the shape the window renders and
// the two rules the script has in its driver: a bound on each probe, and a 403
// that the body or headers say is not about permissions reads `unknown`.

import type { GithubGrant, GithubGrantId, GithubTokenVerdict } from "phoebe-agent/contracts";
import {
  classifyProbe,
  classifyTokenKind,
  PERMISSION_PROBES,
} from "../../../scripts/token-probe-lib.mjs";

const API = "https://api.github.com";

/** How long one probe may take before it is `unknown`. */
export const PROBE_TIMEOUT_MS = 15_000;

export type VerifyDeps = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Run the five probes against `slug` with `token` and say what each answered.
 * In parallel, because none depends on another and a person is waiting.
 */
export async function verifyGithubToken(
  slug: string,
  token: string,
  deps: VerifyDeps = {},
): Promise<GithubTokenVerdict> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const kind = classifyTokenKind(token);
  const grants = await Promise.all(
    PERMISSION_PROBES.map((probe) => runProbe(probe, slug, token, fetchFn, timeoutMs)),
  );
  return {
    slug,
    kind: { id: kind.id as GithubTokenVerdict["kind"]["id"], label: kind.label, note: kind.note },
    grants,
    ok: grants.every((grant) => grant.state === "granted"),
  };
}

type Probe = (typeof PERMISSION_PROBES)[number];

async function runProbe(
  probe: Probe,
  slug: string,
  token: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<GithubGrant> {
  const base = { id: probe.id as GithubGrantId, label: probe.ui, why: probe.why };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchFn(`${API}${probe.path(slug)}`, {
      method: probe.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...("body" in probe && probe.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...("body" in probe && probe.body !== undefined ? { body: JSON.stringify(probe.body) } : {}),
      signal: controller.signal,
    });
    let message: string | undefined;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") message = body.message;
    } catch {
      // A body that is not JSON says nothing the status did not.
    }
    const state = classifyProbe(probe, response.status, {
      ...(message === undefined ? {} : { message }),
      ssoHeader: response.headers.get("x-github-sso"),
      rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
    }) as GithubGrant["state"];
    const detail =
      state === "unknown" && message !== undefined
        ? `HTTP ${response.status}: ${message}`
        : `HTTP ${response.status}`;
    return { ...base, state, detail };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `no answer within ${Math.round(timeoutMs / 1000)}s`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ...base, state: "unknown", detail: reason };
  } finally {
    clearTimeout(timer);
  }
}
