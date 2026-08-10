// Pure helpers for scripts/verify-tenant-token.mjs (#154).
//
// Everything here is I/O-free so the verifier's judgement calls — "is this 404
// an absent resource or an invisible repo?", "which checkbox in onboarding §2
// is missing?" — are testable without a live GitHub token. The driver script
// holds the network, filesystem and tenant-discovery work; this file holds the
// decisions it reports.

/**
 * @typedef {"granted" | "missing" | "unknown"} GrantState
 * @typedef {{ id: string, ui: string, state: GrantState, status?: number | null }} Grant
 * @typedef {{ raw: string, iso: string | null, daysLeft: number | null, expired: boolean | null, warn: boolean, unparsed: boolean }} Expiry
 * @typedef {{ id: string, label: string, note: string | null }} TokenKind
 */

/**
 * Issue / PR number aimed at by the write probes. Far above any real number on
 * any repo, so the mutating call can only ever 404 — a write grant is proven
 * without writing anything.
 */
export const ABSENT_NUMBER = 999999999;

/**
 * The all-zero git object id. `POST /git/refs` validates the `sha` refers to a
 * real object, so a ref can never be created with it — but the validation
 * happens *after* the permission check, which is what makes it a probe.
 */
export const NONEXISTENT_SHA = "0".repeat(40);

/** Branch the contents probe pretends to create. Never actually created. */
export const PROBE_REF = "refs/heads/phoebe-token-probe-never-created";

/**
 * One probe per permission in `docs/phoebe-core-onboarding.md` §2, in the
 * order that document lists them.
 *
 * Fine-grained PATs are not introspectable — no endpoint returns a token's own
 * permission set — so each grant is proven by issuing one call and reading the
 * status code. The discriminator is **403 vs 404/422**: a call refused for lack
 * of permission returns 403 (`Resource not accessible by personal access
 * token`), while the same call against a resource that does not exist returns
 * 404 or 422. Aiming every mutating probe at a deliberately absent target
 * therefore proves a *write* grant without writing.
 *
 * Metadata is the exception: a fine-grained token with no access to a repo does
 * not see a 403, it sees a **404** — GitHub hides the repo's existence. That is
 * also what an unapproved org token looks like, which is why `diagnose` treats
 * it as its own verdict rather than one missing checkbox.
 *
 * Verified against a live token on 2026-08-10 (see the header of
 * `verify-tenant-token.mjs` for what was and was not observed first-hand).
 */
export const PERMISSION_PROBES = [
  {
    id: "metadata",
    ui: "Metadata: Read-only",
    why: "Mandatory for every other permission.",
    method: "GET",
    path: (slug) => `/repos/${slug}`,
    granted: [200],
    missing: [404],
  },
  {
    id: "contents",
    ui: "Contents: Read and write",
    why: "Clone the repo, push branches.",
    method: "POST",
    path: (slug) => `/repos/${slug}/git/refs`,
    body: { ref: PROBE_REF, sha: NONEXISTENT_SHA },
    granted: [422],
    missing: [403],
  },
  {
    id: "pull_requests",
    ui: "Pull requests: Read and write",
    why: "Open/update PRs, post PR comments & watermarks.",
    method: "PATCH",
    path: (slug) => `/repos/${slug}/pulls/${ABSENT_NUMBER}`,
    body: { state: "open" },
    granted: [404],
    missing: [403],
  },
  {
    id: "issues",
    ui: "Issues: Read and write",
    why: "Read readyLabel, swap in processingLabel, comment.",
    method: "PATCH",
    path: (slug) => `/repos/${slug}/issues/${ABSENT_NUMBER}`,
    body: { state: "open" },
    granted: [404],
    missing: [403],
  },
  {
    id: "actions",
    ui: "Actions: Read-only",
    why: "`gh run list` — the check-state source for the `checks` janitor.",
    method: "GET",
    path: (slug) => `/repos/${slug}/actions/runs?per_page=1`,
    granted: [200],
    missing: [403],
  },
];

/**
 * Whether a 403 is something *other* than "this token lacks the permission".
 * GitHub reuses 403 for rate limiting, SAML/SSO enforcement and suspended
 * accounts, and reporting any of those as a missing checkbox would send an
 * operator to re-mint a token that was fine. The evidence is the response body's
 * `message` plus two headers, so this stays pure and the driver passes them in.
 *
 * @param {{ message?: string, ssoHeader?: string | null, rateLimitRemaining?: string | null }} context
 */
export function isAmbiguousRefusal(context) {
  if (context.ssoHeader) return true;
  if (context.rateLimitRemaining === "0") return true;
  return /rate limit|saml|single sign-on|sso|suspended|blocked/i.test(context.message ?? "");
}

/**
 * What one probe's status code says about its grant. Anything outside the two
 * expected sets is `unknown`, never a colour: a wrong green sends an operator
 * to debug the wrong half of their deployment, and a wrong red sends them
 * re-minting a token that was fine. A 403 that {@link isAmbiguousRefusal}
 * recognises is downgraded to `unknown` for the same reason.
 *
 * @param {{ message?: string, ssoHeader?: string | null, rateLimitRemaining?: string | null }} [context]
 */
export function classifyProbe(probe, status, context = {}) {
  if (probe.granted.includes(status)) return "granted";
  if (probe.missing.includes(status)) {
    return status === 403 && isAmbiguousRefusal(context) ? "unknown" : "missing";
  }
  return "unknown";
}

/**
 * Which kind of credential a token is, from its prefix. Only the fine-grained
 * PAT is what Phoebe is built for (`docs/work-kinds.md` — reading check state
 * from the REST Actions API rather than the GraphQL rollup exists precisely
 * because fine-grained PATs cannot read the rollup), so every other kind
 * carries a note. A note, not an error: the others do work.
 */
export function classifyTokenKind(token) {
  const prefixes = [
    { prefix: "github_pat_", id: "fine-grained", label: "fine-grained personal access token" },
    { prefix: "ghp_", id: "classic", label: "classic personal access token" },
    { prefix: "ghs_", id: "installation", label: "GitHub App installation token" },
    { prefix: "gho_", id: "oauth", label: "OAuth access token" },
  ];
  const match = prefixes.find((candidate) => token.startsWith(candidate.prefix));
  if (match === undefined) {
    return {
      id: "unknown",
      label: "unrecognised token type",
      note: "the prefix matches none of GitHub's — probing it anyway, but check you pasted a whole token",
    };
  }
  return {
    id: match.id,
    label: match.label,
    note:
      match.id === "fine-grained"
        ? null
        : `Phoebe is built for fine-grained PATs (docs/work-kinds.md); this ${match.label} works but is not what onboarding §2 describes`,
  };
}

/**
 * Scopes off the classic-token `x-oauth-scopes` header. `null` means the header
 * was absent — a fine-grained token, which carries no scopes at all — and is
 * deliberately distinct from `[]`, a scope-bearing token that was granted none.
 */
export function parseScopes(header) {
  if (header === null || header === undefined) return null;
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * What a classic token's scopes say about onboarding §2's five permissions.
 * `repo` is the whole set; `public_repo` covers the same calls but only on
 * public repos, which this function cannot see — so it reports `unknown` rather
 * than a green that would be wrong for the private case.
 */
export function scopeCoverage(scopes) {
  const state = scopes.includes("repo")
    ? "granted"
    : scopes.includes("public_repo")
      ? "unknown"
      : "missing";
  return Object.fromEntries(PERMISSION_PROBES.map((probe) => [probe.id, state]));
}

/** Warn this many days out — long enough to rotate before Phoebe starts 401ing. */
export const EXPIRY_WARN_DAYS = 14;

/**
 * `YYYY-MM-DD HH:MM:SS <zone>`, the shape of the expiry header. GitHub sends
 * ` UTC`, but the zone is accepted in the forms a proxy or a future GitHub
 * might use — `Z`, `+HHMM`, `+HH:MM` — and an absent zone is read as UTC.
 */
const EXPIRY_HEADER =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Read the `github-authentication-token-expiration` header GitHub returns for
 * an expiring token (`2026-09-30 09:00:00 UTC`).
 *
 * Three outcomes, deliberately distinct:
 *
 * - **absent header** → `null`. A non-expiring token is not a finding.
 * - **readable header** → the expiry, with `unparsed: false`.
 * - **unreadable header** → an expiry with `unparsed: true` and no instant.
 *   This must *not* collapse to `null`: a `null` renders as no expiry line at
 *   all, which is indistinguishable from a non-expiring token, so a token about
 *   to lapse would be reported as fine. An unreadable header is a "check this
 *   by hand", not a clean bill of health.
 */
export function describeExpiry(header, nowMs) {
  if (header === null || header === undefined) return null;
  const raw = String(header);
  const unreadable = {
    raw,
    iso: null,
    daysLeft: null,
    expired: null,
    warn: true,
    unparsed: true,
  };

  const match = EXPIRY_HEADER.exec(raw.trim());
  if (match === null) return unreadable;
  const [, date, time, zone] = match;
  const upper = zone?.toUpperCase();
  const offset =
    upper === undefined || upper === "UTC" || upper === "Z"
      ? "Z"
      : zone.includes(":")
        ? zone
        : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const at = Date.parse(`${date}T${time}${offset}`);
  if (Number.isNaN(at)) return unreadable;

  const daysLeft = Math.floor((at - nowMs) / 86_400_000);
  const expired = at <= nowMs;
  return {
    raw,
    iso: new Date(at).toISOString(),
    daysLeft,
    expired,
    warn: expired || daysLeft <= EXPIRY_WARN_DAYS,
    unparsed: false,
  };
}

/**
 * Turn a set of probed grants into the thing an operator can act on: which of
 * onboarding §2's checkboxes to go and tick, or — when the repo was invisible
 * altogether — the org approval that never landed.
 *
 * `ok` is what `--check` keys off, and it is deliberately narrower than "every
 * grant is green": an `unknown` grant does not certify either, because a wrong
 * green is worse than a blank — but it is reported as its own state, so an
 * operator can tell "this checkbox is missing" from "this could not be proven".
 *
 * @param {{
 *   grants: Grant[],
 *   metadataStatus: number,
 *   expiry?: Expiry | null,
 *   tokenKind?: TokenKind | null,
 * }} input
 */
export function diagnose({ grants, metadataStatus, expiry = null, tokenKind = null }) {
  /** @param {GrantState} state */
  const named = (state) => grants.filter((grant) => grant.state === state).map((grant) => grant.ui);
  const missing = named("missing");
  const unknown = named("unknown");
  const advice = [];

  let verdict;
  if (metadataStatus === 401) {
    verdict = "invalid-credential";
    advice.push(
      "GitHub rejected the credential outright (401). The token is expired, revoked, or " +
        "truncated — mint a fresh one per onboarding §2 and rewrite it into the tenant's .env.",
    );
  } else if (grants.some((grant) => grant.id === "metadata" && grant.state === "missing")) {
    // A fine-grained token with no access does not get a 403 — GitHub hides the
    // repo entirely. So this one 404 covers both "approval never landed" and
    // "the repo was never selected", and the operator needs to be sent to both.
    verdict = "no-access";
    advice.push(
      "The repo is invisible to this token — every other probe is meaningless. Two causes, " +
        "in order of likelihood:",
      "  1. The fine-grained PAT is still awaiting **org owner approval** (onboarding §2). " +
        "Check Settings → Personal access tokens on the org: a pending token behaves exactly " +
        "like one with no access.",
      "  2. **Repository access** was left at its default instead of " +
        "_Only select repositories_ → this repo.",
    );
  } else if (missing.length > 0) {
    verdict = "missing-grants";
    advice.push(
      "Tick these under **Repository permissions** on the token (onboarding §2), then " +
        "re-approve it if the resource owner is an org:",
      ...missing.map((ui) => `  • ${ui}`),
    );
    if (missing.length === grants.length - 1) {
      advice.push(
        "Every permission beyond Metadata is refused, which usually means the repo is " +
          "selected but no **Repository permissions** were ticked at all when the token was minted.",
      );
    }
  } else if (unknown.length > 0) {
    verdict = "unknown";
  } else {
    verdict = "ok";
  }

  // Only worth saying when the probes ran at all: under `no-access` and
  // `invalid-credential` every other grant is unknown by construction, and
  // listing them would bury the one cause the operator has to act on.
  if (unknown.length > 0 && verdict !== "invalid-credential" && verdict !== "no-access") {
    advice.push(
      `Could not judge: ${unknown.join(", ")} — the probe returned a status this script does ` +
        "not have a reading for. Treat as unproven, not as broken.",
    );
  }

  if (expiry?.unparsed === true) {
    advice.push(
      `GitHub reported a token expiry this script could not parse: "${expiry.raw}". Check it ` +
        "by hand — an unreadable expiry is not the same as a token that never expires.",
    );
  } else if (expiry?.expired === true) {
    advice.push(
      `The token expired on ${expiry.iso}. Rotate it into the tenant's .env (onboarding §2).`,
    );
  } else if (expiry?.warn === true) {
    advice.push(
      `The token expires in ${expiry.daysLeft} day(s), on ${expiry.iso}. Rotate it before ` +
        "Phoebe starts 401ing mid-run.",
    );
  }

  if (tokenKind?.note)
    advice.push(tokenKind.note.charAt(0).toUpperCase() + tokenKind.note.slice(1));

  // Deliberately narrow: only a token whose every grant was *proven* certifies.
  // An `unknown` grant is a gap in this script's knowledge, and a wrong green is
  // worse than a blank — a preflight that passed on an unproven grant would be
  // exactly the false reassurance this script exists to remove.
  const ok = verdict === "ok" && expiry?.expired !== true;
  return { verdict, ok, missing, unknown, advice };
}

/**
 * Replace a token wherever it appears in a string. The report is built so the
 * token is never in it, but a thrown `fetch`/`fs` error is written by somebody
 * else — this is the belt to that braces, applied to every message printed.
 */
export function redact(text, token) {
  if (token === undefined || token === null || token.length === 0) return text;
  return text.split(token).join("[redacted]");
}

const STATE_MARK = { granted: "✓", missing: "✗", unknown: "?" };

/** One tenant's findings as an operator-readable block. */
export function renderReport(report) {
  const lines = [report.slug === null ? report.target : `${report.target}  (${report.slug})`];

  if (report.error !== null && report.error !== undefined) {
    lines.push(`  ✗ ${report.error}`);
    return lines.join("\n");
  }

  lines.push(`  token: ${report.tokenKind.label}, from ${report.tokenSource}`);
  if (report.scopes !== null) {
    lines.push(
      `  scopes: ${report.scopes.length > 0 ? report.scopes.join(", ") : "(none granted)"} ` +
        "— read from x-oauth-scopes, not probed",
    );
  }
  if (report.expiry != null) {
    const when = report.expiry.unparsed
      ? `UNREADABLE — GitHub said "${report.expiry.raw}"`
      : report.expiry.expired
        ? `EXPIRED ${report.expiry.iso}`
        : `${report.expiry.iso} (${report.expiry.daysLeft} day(s) left)`;
    lines.push(`  expires: ${when}`);
  }
  for (const grant of report.grants) {
    const status = grant.status === null ? "" : ` (HTTP ${grant.status})`;
    lines.push(`  ${STATE_MARK[grant.state] ?? "?"} ${grant.ui}${status}`);
  }
  for (const line of report.advice) lines.push(`  ${line}`);
  return lines.join("\n");
}

/**
 * One tenant's findings as machine-readable data. Built field by field rather
 * than by spreading the report, so a token (or anything else added to the
 * in-memory report later) cannot reach `--json` by accident.
 */
export function reportToJson(report) {
  return {
    target: report.target,
    slug: report.slug,
    tokenSource: report.tokenSource ?? null,
    tokenType: report.tokenKind?.id ?? null,
    scopes: report.scopes ?? null,
    expiresAt: report.expiry?.iso ?? null,
    expired: report.expiry?.expired ?? null,
    daysUntilExpiry: report.expiry?.daysLeft ?? null,
    // The raw header, so a consumer can tell "no expiry" (null) apart from an
    // expiry we could not read (a string, with expiresAt still null).
    expiryHeader: report.expiry?.raw ?? null,
    grants: (report.grants ?? []).map((grant) => ({
      permission: grant.id,
      label: grant.ui,
      state: grant.state,
      status: grant.status ?? null,
    })),
    verdict: report.verdict ?? null,
    ok: report.ok ?? false,
    missing: report.missing ?? [],
    unknown: report.unknown ?? [],
    advice: report.advice ?? [],
    error: report.error ?? null,
  };
}

/**
 * Exit code for a whole sweep. Mirrors `phoebe list --check` (#140): findings
 * are reported either way, and only `--check` turns them into a status a
 * preflight can gate on. A tenant that could not be resolved counts as a
 * finding — a silently skipped tenant is exactly the failure this script exists
 * to stop.
 */
export function sweepExitCode(reports, check) {
  if (!check) return 0;
  return reports.some((report) => report.error != null || !report.ok) ? 1 : 0;
}

/** A `--slug` must be `owner/repo`; anything else is a typo, not a target. */
const SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/**
 * @typedef {{
 *   dirs: string[],
 *   all: boolean,
 *   json: boolean,
 *   check: boolean,
 *   slug: string | undefined,
 *   token: string | undefined,
 * }} VerifyOptions
 */

/**
 * Parse the driver's argv. Positionals are tenant directories; `--all` sweeps
 * the workspace instead and is therefore exclusive with every way of naming one
 * target. An unrecognised flag throws rather than being ignored — a silently
 * dropped `--chekc` would report a clean fleet and exit 0.
 */
export function parseArgs(argv) {
  /** @type {VerifyOptions} */
  const opts = {
    dirs: [],
    all: false,
    json: false,
    check: false,
    slug: undefined,
    token: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    // `--flag=value` as well as `--flag value`, matching `phoebe`'s own CLI. The
    // name is split off first and *only the name* is ever echoed in an error:
    // the value of a mistyped `--tokenn=…` is still a live credential.
    const eq = raw.startsWith("-") ? raw.indexOf("=") : -1;
    const arg = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);

    if (arg === "--slug" || arg === "--token") {
      const value = inlineValue ?? argv[i + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith("-"))) {
        throw new Error(`${arg} needs a value.`);
      }
      if (arg === "--slug") opts.slug = value;
      else opts.token = value;
      if (inlineValue === undefined) i += 1;
      continue;
    }
    if (arg === "--all") opts.all = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--check") opts.check = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else opts.dirs.push(raw);
  }

  if (opts.slug !== undefined && !SLUG_PATTERN.test(opts.slug)) {
    throw new Error(`--slug must be owner/repo, got: ${opts.slug}`);
  }
  if (opts.all && (opts.dirs.length > 0 || opts.slug !== undefined || opts.token !== undefined)) {
    throw new Error(
      "--all sweeps every declared tenant; it takes no directory, --slug or --token.",
    );
  }

  return opts;
}
