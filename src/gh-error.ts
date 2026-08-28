/**
 * Error classification for `gh` CLI failures.
 *
 * GitHub returns HTTP 403 for two structurally different conditions that require
 * different operator responses:
 *
 *   • Rate-limit exhaustion — self-healing; the hourly budget resets at a known
 *     time.  The correct response is to wait for the reset, not to audit grants.
 *     The two buckets exhaust independently: `gh issue list`, `gh pr list`,
 *     `gh pr view`, and `gh api graphql` draw on "graphql"; `gh run list` and
 *     `gh api <rest>` draw on "core".  A fleet can exhaust graphql with core
 *     nearly untouched, so naming the bucket matters.
 *
 *   • Missing permission grant — requires an operator action (widening the
 *     token's permissions or the App installation's grant).
 *
 * `classifyGhError` inspects the stderr blob from a failed `gh` invocation and
 * returns which condition it detected, or null when the blob carries no usable
 * signal (e.g. stderr is null because the process used inherited stdio, or the
 * message matches neither known pattern).  `describeGhError` renders that
 * classification as a human-readable string for log output.
 */

export type GhRateLimitClassification = {
  kind: "rate-limit";
  /** Which API bucket was exhausted; null when indeterminate. */
  resource: "graphql" | "core" | null;
  /**
   * When the budget resets.  null when not determinable from the error text
   * alone — callers may enrich this via a follow-up `gh api rate_limit` probe.
   */
  resetAt: Date | null;
};

export type GhPermissionClassification = {
  kind: "permission";
};

export type GhErrorClassification = GhRateLimitClassification | GhPermissionClassification;

// Both REST and GraphQL rate-limit responses from the GitHub API contain this.
const RATE_LIMIT_RE = /rate[\s_-]?limit/i;

// What `gh` echoes when an installation token or PAT lacks the required grant.
const PERMISSION_RE = /Resource not accessible by/i;

// Ten-digit Unix epoch embedded in the error text (e.g. from a GraphQL extension).
const EPOCH_RE = /(?<!\d)(\d{10})(?!\d)/;

/**
 * Classify a `gh` CLI error.
 *
 * Returns null when the error carries no usable signal — the caller should
 * rethrow the original error unchanged.
 *
 * @param error  - The value thrown by `execFileSync("gh", ...)`.
 * @param ghArgs - The argument list passed to `gh` (excluding the executable).
 *                 Used to infer the API bucket when the error text is ambiguous.
 */
export function classifyGhError(
  error: unknown,
  ghArgs: readonly string[] = [],
): GhErrorClassification | null {
  const stderr = stderrText(error);
  if (stderr === null) return null;

  if (RATE_LIMIT_RE.test(stderr)) {
    return {
      kind: "rate-limit",
      resource: inferResource(ghArgs, stderr),
      resetAt: parseEpoch(stderr),
    };
  }

  if (PERMISSION_RE.test(stderr)) {
    return { kind: "permission" };
  }

  return null;
}

/**
 * Format a `GhErrorClassification` as a log-ready string.
 */
export function describeGhError(c: GhErrorClassification): string {
  if (c.kind === "permission") {
    return "GitHub 403: permission not granted — check the token's repository access and scope";
  }
  const parts: string[] = ["GitHub rate limit exhausted"];
  if (c.resource) parts[0] += ` (${c.resource})`;
  if (c.resetAt) parts.push(`resets at ${c.resetAt.toISOString()}`);
  return parts.join(" — ");
}

// Server-side blips and network-level failures that a short retry genuinely
// heals. Deliberately narrow: rate-limit (self-healing only at the hourly
// reset) and permission (needs an operator) never match, and a child killed by
// the spawn timeout carries no stderr at all, so a hung `gh` is never retried
// into a triple-length hang.
const TRANSIENT_RES = [
  // gh's REST error line: "gh: <message> (HTTP 502)". 501 is excluded — "not
  // implemented" does not heal.
  /HTTP 50[0234]\b/i,
  /\b(?:bad gateway|service unavailable|gateway time-?out|internal server error)\b/i,
  // GraphQL's catch-all for a server-side failure or query timeout.
  /Something went wrong while executing your query/i,
  // Go's net errors as gh surfaces them.
  /connection (?:reset|refused)/i,
  /i\/o timeout/i,
  /TLS handshake timeout/i,
  /unexpected EOF/i,
  /no such host/i,
];

/**
 * Whether a failed `gh` invocation looks like a transient transport or server
 * error — the class worth an in-process retry with backoff, as opposed to the
 * classifications above, which need waiting out or an operator. False whenever
 * stderr is unreadable (inherited stdio): with no signal, don't retry.
 */
export function isTransientGhError(error: unknown): boolean {
  const stderr = stderrText(error);
  if (stderr === null) return false;
  return TRANSIENT_RES.some((re) => re.test(stderr));
}

/**
 * Whether a failed `gh issue edit --add-label` call was rejected because the
 * label does not exist in the repository. GitHub's GraphQL mutation surfaces
 * this as "Label not found: …" in the error text.
 *
 * Only detectable on captured calls (not inherited-stdio writes): a call with
 * `inherit: true` yields no stderr to inspect and always returns false here.
 */
export function isLabelNotFoundError(error: unknown): boolean {
  const stderr = stderrText(error);
  if (stderr === null) return false;
  return /Label not found/i.test(stderr);
}

function stderrText(error: unknown): string | null {
  if (error == null || typeof error !== "object") return null;
  const s = (error as Record<string, unknown>).stderr;
  if (typeof s === "string") return s.length > 0 ? s : null;
  if (Buffer.isBuffer(s)) return s.length > 0 ? s.toString("utf8") : null;
  return null;
}

/**
 * Infer the GitHub API rate-limit bucket from the `gh` argument list, falling
 * back to the stderr text when the args alone are ambiguous.
 *
 *   gh api graphql …  → graphql
 *   gh api <rest>     → core
 *   gh run …          → core  (REST Actions API)
 *   gh issue … / pr … → graphql  (gh uses GraphQL under the hood)
 */
function inferResource(args: readonly string[], stderr: string): "graphql" | "core" | null {
  const sub = args[0];
  if (sub === "api" && args[1] === "graphql") return "graphql";
  if (sub === "api") return "core";
  if (sub === "run") return "core";
  if (sub === "issue" || sub === "pr") return "graphql";
  // Last resort: the error text sometimes names the bucket explicitly.
  if (/graphql/i.test(stderr)) return "graphql";
  return null;
}

function parseEpoch(text: string): Date | null {
  const m = EPOCH_RE.exec(text);
  if (!m?.[1]) return null;
  const d = new Date(parseInt(m[1], 10) * 1000);
  return isNaN(d.getTime()) ? null : d;
}
