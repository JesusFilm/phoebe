// Credential IPC handler tests (#211): request/answer/blocked/cache behavior,
// PAT arm no-op, warn-once over-budget, and cache reuse across child respawns.

import { describe, expect, test, vi } from "vite-plus/test";
import {
  CREDENTIAL_ANSWER,
  CREDENTIAL_BLOCKED,
  CREDENTIAL_REQUEST,
} from "../src/credential-client.ts";
import {
  attachCredentialHandler,
  CACHE_MARGIN_MS,
  TOKEN_LIFETIME_MS,
  type CredentialCache,
  type CredentialChild,
  type MintFn,
} from "./credential-ipc.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeChild(): CredentialChild & {
  emitMessage: (m: unknown) => void;
  sent: unknown[];
} {
  const messageListeners: Array<(m: unknown) => void> = [];
  const sent: unknown[] = [];
  return {
    on: (_event, listener) => {
      messageListeners.push(listener as (m: unknown) => void);
    },
    send: (message) => sent.push(message),
    emitMessage: (m) => messageListeners.forEach((l) => l(m)),
    sent,
  };
}

function makeMint(
  overrides: Partial<{ installationId: string; token: string; expiresAtMs: number }> = {},
): MintFn {
  return async () => ({
    installationId: "inst-123",
    token: "ghs_freshtoken",
    expiresAtMs: Date.now() + TOKEN_LIFETIME_MS,
    ...overrides,
  });
}

describe("attachCredentialHandler", () => {
  test("PAT arm: answers CREDENTIAL_ANSWER with null token", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    attachCredentialHandler({
      tenantId: "acme/widget",
      child,
      cache,
      mint: null,
      warnedOverBudget: new Set(),
    });

    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
    await tick();
    expect(child.sent).toEqual([{ type: CREDENTIAL_ANSWER, token: null }]);
  });

  test("PAT arm: does not interact with the cache", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    attachCredentialHandler({
      tenantId: "acme/widget",
      child,
      cache,
      mint: null,
      warnedOverBudget: new Set(),
    });

    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
    await tick();
    expect(cache.size).toBe(0);
  });

  test("App arm: cache miss → mints, stores, and answers with token", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    const mint = vi.fn(makeMint({ token: "ghs_minted" }));
    attachCredentialHandler({
      tenantId: "acme/repo",
      child,
      cache,
      mint,
      warnedOverBudget: new Set(),
    });

    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
    await tick();
    expect(mint).toHaveBeenCalledOnce();
    expect(child.sent).toEqual([{ type: CREDENTIAL_ANSWER, token: "ghs_minted" }]);
    expect(cache.get("acme/repo")?.token).toBe("ghs_minted");
  });

  test("App arm: cache hit → answers from cache without minting", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    const budgetMs = 120_000;
    const nowMs = Date.now();
    cache.set("acme/repo", {
      installationId: "inst-99",
      token: "ghs_cached",
      expiresAtMs: nowMs + budgetMs + CACHE_MARGIN_MS + 5_000,
    });
    const mint = vi.fn(makeMint());
    attachCredentialHandler({
      tenantId: "acme/repo",
      child,
      cache,
      mint,
      warnedOverBudget: new Set(),
    });

    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs });
    await tick();
    expect(mint).not.toHaveBeenCalled();
    expect(child.sent).toEqual([{ type: CREDENTIAL_ANSWER, token: "ghs_cached" }]);
  });

  test("App arm: expired cache → mints a fresh token", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    const budgetMs = 120_000;
    // Token expires before budget + margin can be covered.
    cache.set("acme/repo", {
      installationId: "inst-99",
      token: "ghs_stale",
      expiresAtMs: Date.now() + budgetMs, // not enough (no margin)
    });
    const mint = vi.fn(makeMint({ token: "ghs_fresh" }));
    attachCredentialHandler({
      tenantId: "acme/repo",
      child,
      cache,
      mint,
      warnedOverBudget: new Set(),
    });

    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs });
    await tick();
    expect(mint).toHaveBeenCalledOnce();
    expect(child.sent).toEqual([{ type: CREDENTIAL_ANSWER, token: "ghs_fresh" }]);
  });

  test("App arm: mint failure → sends CREDENTIAL_BLOCKED and logs fixed message (no token)", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    const errorMessages: string[] = [];
    // Error message contains a token-like value — must not appear in the log.
    const mint: MintFn = async () => {
      throw new Error("ghs_SECRETVALUE GitHub API 503");
    };
    attachCredentialHandler({
      tenantId: "acme/repo",
      child,
      cache,
      mint,
      warnedOverBudget: new Set(),
      error: (msg) => errorMessages.push(msg),
    });

    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
    await tick();
    expect(child.sent).toEqual([{ type: CREDENTIAL_BLOCKED }]);
    expect(errorMessages).toHaveLength(1);
    const logMsg = errorMessages[0]!;
    expect(logMsg).toContain("Credential refresh failed");
    // The error message (including any token-like value) must not appear in the log.
    expect(logMsg).not.toContain("ghs_");
    expect(logMsg).not.toContain("GitHub API 503");
  });

  test("App arm: cache outlives child respawns — second child reuses the live token", async () => {
    const cache: CredentialCache = new Map();
    const mint = vi.fn(makeMint({ token: "ghs_shared" }));

    // First child mints and caches.
    const child1 = fakeChild();
    attachCredentialHandler({
      tenantId: "acme/repo",
      child: child1,
      cache,
      mint,
      warnedOverBudget: new Set(),
    });
    child1.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
    await tick();
    expect(mint).toHaveBeenCalledOnce();

    // Second child (after a crash-respawn) reuses the cached token.
    mint.mockClear();
    const child2 = fakeChild();
    attachCredentialHandler({
      tenantId: "acme/repo",
      child: child2,
      cache,
      mint,
      warnedOverBudget: new Set(),
    });
    child2.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
    await tick();
    expect(mint).not.toHaveBeenCalled();
    expect(child2.sent).toEqual([{ type: CREDENTIAL_ANSWER, token: "ghs_shared" }]);
  });

  test("warns once per tenant when budget exceeds the 60-minute token ceiling", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    const warnings: string[] = [];
    const warnedOverBudget = new Set<string>();
    const mint = makeMint({ token: "ghs_big" });
    attachCredentialHandler({
      tenantId: "acme/repo",
      child,
      cache,
      mint,
      warnedOverBudget,
      warn: (msg) => warnings.push(msg),
    });

    // Budget over 60 min.
    const bigBudget = TOKEN_LIFETIME_MS + 1;
    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: bigBudget });
    await tick();
    expect(warnings).toHaveLength(1);
    const msg = warnings[0]!;
    expect(msg).toContain("60min installation token ceiling");
    expect(msg).not.toContain("ghs_"); // no token in warning
  });

  test("only warns once per tenant across multiple over-budget requests", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    const warnings: string[] = [];
    const warnedOverBudget = new Set<string>();

    attachCredentialHandler({
      tenantId: "acme/repo",
      child,
      cache,
      mint: async () => ({
        installationId: "inst-1",
        token: "ghs_big",
        expiresAtMs: Date.now() + 5_000, // very short so cache always misses
      }),
      warnedOverBudget,
      warn: (msg) => warnings.push(msg),
    });

    const bigBudget = TOKEN_LIFETIME_MS + 1;
    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: bigBudget });
    await tick();
    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: bigBudget });
    await tick();
    expect(warnings).toHaveLength(1);
  });

  test("does not warn when budget is within the 60-minute ceiling", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    const warnings: string[] = [];
    attachCredentialHandler({
      tenantId: "acme/repo",
      child,
      cache,
      mint: makeMint(),
      warnedOverBudget: new Set(),
      warn: (msg) => warnings.push(msg),
    });

    // Default budget: 45 min timeout + 10 min = 55 min < 60 min.
    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 55 * 60_000 });
    await tick();
    expect(warnings).toHaveLength(0);
  });

  // The PAT arm's live read (#205): the handler re-reads the tenant's `.env` at
  // each request and answers with the current token, so a rotated PAT reaches
  // the running child at the next lease call site instead of via a relaunch.
  describe("readPatToken", () => {
    test("answers with the live PAT and never touches mint or the cache", async () => {
      const child = fakeChild();
      const cache: CredentialCache = new Map();
      const mint = vi.fn(makeMint());
      attachCredentialHandler({
        tenantId: "acme/widget",
        child,
        cache,
        mint,
        readPatToken: () => "ghp_rotated",
        warnedOverBudget: new Set(),
      });

      child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
      await tick();
      expect(child.sent).toEqual([{ type: CREDENTIAL_ANSWER, token: "ghp_rotated" }]);
      expect(mint).not.toHaveBeenCalled();
      expect(cache.size).toBe(0);
    });

    test("re-reads per request — a rotation between requests answers the new token", async () => {
      const child = fakeChild();
      let token = "ghp_before";
      attachCredentialHandler({
        tenantId: "acme/widget",
        child,
        cache: new Map(),
        mint: null,
        readPatToken: () => token,
        warnedOverBudget: new Set(),
      });

      child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
      await tick();
      token = "ghp_after";
      child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
      await tick();
      expect(child.sent).toEqual([
        { type: CREDENTIAL_ANSWER, token: "ghp_before" },
        { type: CREDENTIAL_ANSWER, token: "ghp_after" },
      ]);
    });

    test("a null read falls through to the mint path (App arm)", async () => {
      const child = fakeChild();
      const mint = vi.fn(makeMint({ token: "ghs_minted" }));
      attachCredentialHandler({
        tenantId: "acme/repo",
        child,
        cache: new Map(),
        mint,
        readPatToken: () => null,
        warnedOverBudget: new Set(),
      });

      child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
      await tick();
      expect(mint).toHaveBeenCalledOnce();
      expect(child.sent).toEqual([{ type: CREDENTIAL_ANSWER, token: "ghs_minted" }]);
    });

    test("a null read with no mint blocks — the retained PAT must not stand", async () => {
      const child = fakeChild();
      attachCredentialHandler({
        tenantId: "acme/widget",
        child,
        cache: new Map(),
        mint: null,
        readPatToken: () => null,
        warnedOverBudget: new Set(),
      });

      child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
      await tick();
      expect(child.sent).toEqual([{ type: CREDENTIAL_BLOCKED }]);
    });

    test("an empty or whitespace-only read blocks like a null read", async () => {
      const child = fakeChild();
      attachCredentialHandler({
        tenantId: "acme/widget",
        child,
        cache: new Map(),
        mint: null,
        readPatToken: () => "  ",
        warnedOverBudget: new Set(),
      });

      child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
      await tick();
      expect(child.sent).toEqual([{ type: CREDENTIAL_BLOCKED }]);
    });

    test("PAT removed after rotation: subsequent requests block, not the old token", async () => {
      const child = fakeChild();
      let currentToken: string | null = "ghp_initial";
      attachCredentialHandler({
        tenantId: "acme/widget",
        child,
        cache: new Map(),
        mint: null,
        readPatToken: () => currentToken,
        warnedOverBudget: new Set(),
      });

      child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
      await tick();
      expect(child.sent).toEqual([{ type: CREDENTIAL_ANSWER, token: "ghp_initial" }]);

      currentToken = null;
      child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: 120_000 });
      await tick();
      expect(child.sent).toEqual([
        { type: CREDENTIAL_ANSWER, token: "ghp_initial" },
        { type: CREDENTIAL_BLOCKED },
      ]);
    });
  });

  test("ignores unrelated IPC messages", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    const mint = vi.fn(makeMint());
    attachCredentialHandler({
      tenantId: "acme/repo",
      child,
      cache,
      mint,
      warnedOverBudget: new Set(),
    });

    child.emitMessage({ type: "phoebe:slot:acquire" });
    child.emitMessage("just a string");
    child.emitMessage(null);
    await tick();
    expect(mint).not.toHaveBeenCalled();
    expect(child.sent).toHaveLength(0);
  });

  test("ignores a CREDENTIAL_REQUEST with a non-numeric budgetMs", async () => {
    const child = fakeChild();
    const cache: CredentialCache = new Map();
    const mint = vi.fn(makeMint());
    attachCredentialHandler({
      tenantId: "acme/repo",
      child,
      cache,
      mint,
      warnedOverBudget: new Set(),
    });

    child.emitMessage({ type: CREDENTIAL_REQUEST, budgetMs: "not-a-number" });
    child.emitMessage({ type: CREDENTIAL_REQUEST }); // missing field
    await tick();
    expect(mint).not.toHaveBeenCalled();
    expect(child.sent).toHaveLength(0);
  });
});
