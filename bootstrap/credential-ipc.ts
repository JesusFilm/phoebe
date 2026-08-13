// The supervisor's credential handler — caches and mints installation tokens
// per tenant (#211). Symmetric to broker-ipc.ts (the slot broker adapter).
//
// Each engine child on the App arm sends a CREDENTIAL_REQUEST carrying its run
// budget (run timeout + 10 min). The supervisor answers from its in-memory cache
// when the cached token covers that budget, mints a fresh token when it does not,
// and answers CREDENTIAL_BLOCKED when a mint fails — the child then skips that
// cycle's work unit rather than proceeding on a credential it cannot renew.
//
// On the PAT arm `mint` is null: the handler always answers CREDENTIAL_ANSWER
// with a null token (a no-op; the child's existing GH_TOKEN is the PAT and does
// not expire on the same 60-minute clock).
//
// The cache is memory-only (one record per tenant) and is created outside the
// per-child handler so it outlives child crashes — a respawned child reuses the
// live token instead of minting again. Token values never appear in logs.

import {
  CREDENTIAL_ANSWER,
  CREDENTIAL_BLOCKED,
  CREDENTIAL_REQUEST,
} from "../src/credential-client.ts";

/** The subset of a child process this handler needs — injectable for tests. */
export type CredentialChild = {
  on(event: "message", listener: (message: unknown) => void): unknown;
  send?(message: unknown, callback?: (error: Error | null) => void): void;
};

/** One cached installation token for a single tenant. */
export type TokenRecord = {
  installationId: string;
  /** The token value — never logged. */
  token: string;
  /** Epoch milliseconds when the token expires. */
  expiresAtMs: number;
};

/** In-memory credential cache: tenantId → record. Lives at fleet level. */
export type CredentialCache = Map<string, TokenRecord>;

/**
 * The App-arm mint function injected by the fleet arm. Returns a fresh
 * installation token and its expiry. The supervisor never derives the budget
 * independently — the child's value arrives in the request.
 */
export type MintFn = (opts: {
  budgetMs: number;
}) => Promise<{ installationId: string; token: string; expiresAtMs: number }>;

/**
 * A fresh installation token lasts 60 minutes. Beyond that boundary no token
 * can cover the budget, so mint and warn rather than blocking.
 */
export const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/**
 * Extra headroom added to the budget when checking cache coverage: the gap
 * between "supervisor hands over a token" and "child first uses it" is at most
 * a few seconds, but a 2-minute pad keeps the check conservative.
 */
export const CACHE_MARGIN_MS = 2 * 60 * 1000;

function messageType(message: unknown): unknown {
  return typeof message === "object" && message !== null
    ? (message as { type?: unknown }).type
    : undefined;
}

/**
 * Wire one child's credential requests to the shared cache and (on the App arm)
 * the mint function. Call once at spawn; idempotent per child.
 *
 * On the PAT arm (`mint` is null) the handler always answers with a null token —
 * the child leaves its env value alone and proceeds normally.
 *
 * On the App arm the handler checks whether the cached token covers
 * `budgetMs + CACHE_MARGIN_MS`; if so it answers from cache. If not it calls
 * `mint`, stores the result, and then answers. A mint failure is logged (without
 * the token value) and answered with CREDENTIAL_BLOCKED so the child skips
 * that cycle's work unit. A budget that no 60-minute token can cover triggers a
 * one-per-tenant warning at mint time — the freshest available token is still
 * handed over.
 */
export function attachCredentialHandler(opts: {
  tenantId: string;
  child: CredentialChild;
  cache: CredentialCache;
  mint: MintFn | null;
  /** One-shot warning tracker shared at fleet level to survive child respawns. */
  warnedOverBudget: Set<string>;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable logger for tests. */
  warn?: (message: string) => void;
  /** Injectable error logger for tests. */
  error?: (message: string) => void;
}): void {
  const { tenantId, child, cache, mint } = opts;
  const warnedOverBudget = opts.warnedOverBudget;
  const now = opts.now ?? (() => Date.now());
  const warnLog = opts.warn ?? ((m) => console.warn(m));
  const errorLog = opts.error ?? ((m) => console.error(m));

  child.on("message", async (message) => {
    if (messageType(message) !== CREDENTIAL_REQUEST) return;
    const raw = message as { budgetMs?: unknown };
    if (typeof raw.budgetMs !== "number") return;
    const budgetMs = raw.budgetMs;

    if (!mint) {
      // PAT arm: nothing to give — the child's existing GH_TOKEN is the PAT.
      child.send?.({ type: CREDENTIAL_ANSWER, token: null });
      return;
    }

    // App arm: answer from cache when it covers the full budget + margin.
    const nowMs = now();
    const cached = cache.get(tenantId);
    if (cached !== undefined && cached.expiresAtMs - nowMs >= budgetMs + CACHE_MARGIN_MS) {
      child.send?.({ type: CREDENTIAL_ANSWER, token: cached.token });
      return;
    }

    // Mint a fresh token.
    let minted: { installationId: string; token: string; expiresAtMs: number };
    try {
      minted = await mint({ budgetMs });
    } catch {
      errorLog(`[phoebe:${tenantId}] Credential refresh failed`);
      child.send?.({ type: CREDENTIAL_BLOCKED });
      return;
    }

    cache.set(tenantId, {
      installationId: minted.installationId,
      token: minted.token,
      expiresAtMs: minted.expiresAtMs,
    });

    // Warn once per tenant when the budget exceeds the 60-minute token ceiling.
    // The warning fires at mint time (where the real number arrives), not at
    // boot — computing the budget there would duplicate the child's precedence
    // logic and drift.
    if (budgetMs > TOKEN_LIFETIME_MS && !warnedOverBudget.has(tenantId)) {
      warnedOverBudget.add(tenantId);
      const remainingMs = minted.expiresAtMs - now();
      warnLog(
        `[phoebe:${tenantId}] Run budget ${Math.round(budgetMs / 60_000)}min exceeds the ` +
          `60min installation token ceiling — handing over the freshest token available ` +
          `(expires in ~${Math.round(remainingMs / 60_000)}min). ` +
          `Lower PHOEBE_RUN_TIMEOUT_MS below 50min to stay within a single token's lifetime.`,
      );
    }

    child.send?.({ type: CREDENTIAL_ANSWER, token: minted.token });
  });
}
