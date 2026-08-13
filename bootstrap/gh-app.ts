// Supervisor-side GitHub App module (#207): derive installation, mint narrowed token, resolve bot identity.
//
// PHOEBE_GH_APP_ID and PHOEBE_GH_APP_PRIVATE_KEY (base64-encoded PEM) come from the
// supervisor's environment. Both absent → PAT mode (readAppCredentials returns null).
// Either present without the other, or a decoded value with no PEM header → fatal at boot.
//
// All state (installation id per tenant, bot identity per process) lives inside the
// AppMinter returned by createAppMinter. One minter per deployment.

import { createSign } from "node:crypto";

/** Shared env prefix for all App variables — export so consumers can key-off additions. */
export const GH_APP_ENV_PREFIX = "PHOEBE_GH_APP_";

const GH_API = "https://api.github.com";
const GH_UA = "phoebe-bootstrapper";

// The five permissions onboarding §2 requires — over-asking is a loud 422.
const NARROWED_PERMISSIONS: Record<string, string> = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  actions: "read",
};

// ---------------------------------------------------------------- errors

/**
 * Fatal boot-time configuration error. The App env variables are malformed and
 * retrying will not help — the operator must fix the value.
 */
export class AppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppConfigError";
  }
}

/**
 * Per-tenant mint failure. Always carries a classification the caller can log as a
 * diagnosis. The installation cache is cleared on every throw so the next call
 * re-derives the installation id.
 *
 * Classifications:
 * - `"bad-key"`       — 401; the App private key is invalid, or the App was deleted.
 * - `"forbidden"`     — 403; the installation has not approved the requested grant.
 * - `"not-in-scope"`  — 404; the repo is not accessible to this installation
 *                       (ambiguous: outside the grant, or the repo was renamed/deleted).
 * - `"not-installed"` — 422; the App is not installed on the repo, or the mint over-asked.
 * - `"unknown"`       — unexpected status; see the `status` field.
 */
export class AppMintError extends Error {
  /** HTTP status from GitHub, or null for pre-network failures (bad JWT, no slug). */
  readonly status: number | null;
  readonly classification: "bad-key" | "forbidden" | "not-in-scope" | "not-installed" | "unknown";

  constructor(
    message: string,
    status: number | null,
    classification: AppMintError["classification"],
  ) {
    super(message);
    this.name = "AppMintError";
    this.status = status;
    this.classification = classification;
  }
}

// ---------------------------------------------------------------- types

/** Decoded, validated App credentials from the supervisor env. */
export type AppCredentials = {
  appId: string;
  privateKey: string;
};

/** The bot's GitHub identity — resolved once and cached for the process. */
export type AppIdentity = {
  /** App slug (e.g. `"phoebe-bot"`). */
  slug: string;
  /** Login for comments and PR reviews (`<slug>[bot]`). */
  botLogin: string;
  /** Numeric GitHub user id. Commit email: `<botId>+<botLogin>@users.noreply.github.com`. */
  botId: number;
};

/** A successfully minted, narrowed installation token. */
export type MintResult = {
  /** `ghs_` installation token — never log this. */
  token: string;
  /** ISO-8601 expiry string from GitHub (tokens last ~1 hour). */
  expiresAt: string;
  /** Bot identity resolved in the same step. */
  identity: AppIdentity;
};

/** A minter scoped to one deployment's credentials. Create once at boot. */
export type AppMinter = {
  /** Mint a narrowed token for the given tenant repo. */
  mint(repoSlug: string): Promise<MintResult>;
};

// ---------------------------------------------------------------- env reading

/**
 * Read and validate the two App env variables.
 *
 * Returns `null` when both are absent (PAT mode — callers fall through to their
 * existing credential path).
 *
 * Throws {@link AppConfigError} when:
 * - exactly one of the two is set (partial declaration)
 * - the private-key value decodes from base64 to a string with no PEM header
 */
export function readAppCredentials(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AppCredentials | null {
  const appId = env[`${GH_APP_ENV_PREFIX}ID`];
  const rawKey = env[`${GH_APP_ENV_PREFIX}PRIVATE_KEY`];

  if (!appId && !rawKey) return null;

  if (appId && !rawKey) {
    throw new AppConfigError(
      `${GH_APP_ENV_PREFIX}ID is set but ${GH_APP_ENV_PREFIX}PRIVATE_KEY is missing` +
        ` — both are required for GitHub App mode, or neither.`,
    );
  }
  if (!appId && rawKey) {
    throw new AppConfigError(
      `${GH_APP_ENV_PREFIX}PRIVATE_KEY is set but ${GH_APP_ENV_PREFIX}ID is missing` +
        ` — both are required for GitHub App mode, or neither.`,
    );
  }

  // Buffer.from is lenient with invalid base64; the only reliable signal is
  // whether the decoded output contains a PEM header.
  const pem = Buffer.from(rawKey!, "base64").toString("utf8");
  if (!pem.includes("-----BEGIN")) {
    throw new AppConfigError(
      `${GH_APP_ENV_PREFIX}PRIVATE_KEY: decoded from base64 but no PEM header found` +
        ` (expected "-----BEGIN …") — verify the value was base64-encoded from a valid PEM private key.`,
    );
  }

  return { appId: appId!, privateKey: pem };
}

// ---------------------------------------------------------------- internal helpers

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
type FetchResponse = { status: number; json(): Promise<unknown> };
export type Fetcher = (url: string, init?: FetchInit) => Promise<FetchResponse>;

type GhResponse = { status: number; json: unknown };

async function ghCall(
  path: string,
  opts: { jwt?: string; method?: string; body?: unknown },
  fetch: Fetcher,
): Promise<GhResponse> {
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": GH_UA,
    "x-github-api-version": "2022-11-28",
  };
  if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`;
  if (opts.body) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function classifyError(status: number, context: string): AppMintError {
  if (status === 401) {
    return new AppMintError(
      `${context}: GitHub returned 401 — the App private key is invalid, or the App was deleted.`,
      401,
      "bad-key",
    );
  }
  if (status === 403) {
    return new AppMintError(
      `${context}: GitHub returned 403 — the installation has not approved the requested grant.`,
      403,
      "forbidden",
    );
  }
  if (status === 404) {
    return new AppMintError(
      `${context}: GitHub returned 404 — the repo is not accessible via this installation` +
        ` (may be outside the installation's grant, or the repo was renamed or deleted).`,
      404,
      "not-in-scope",
    );
  }
  if (status === 422) {
    return new AppMintError(
      `${context}: GitHub returned 422 — the App may not be installed on the repo,` +
        ` or the token request over-asked the installation's approved permissions.`,
      422,
      "not-installed",
    );
  }
  return new AppMintError(
    `${context}: unexpected GitHub response (HTTP ${status}).`,
    status,
    "unknown",
  );
}

// App JWTs are RS256 — iat is backdated 60 s to absorb caller clock skew.
function defaultMintJwt(appId: string, privateKey: string): string {
  const seg = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = seg({ alg: "RS256", typ: "JWT" });
  const payload = seg({ iat: now - 60, exp: now + 540, iss: appId });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

// ---------------------------------------------------------------- minter factory

type AppMinterDeps = {
  fetch?: Fetcher;
  /** Override JWT signing for tests that cannot produce a real RSA key. */
  mintJwt?: (appId: string, privateKey: string) => string;
};

/**
 * Create a minter for one deployment. One instance per supervisor — it holds the
 * installation-id cache (per tenant slug) and the process-wide bot identity cache.
 */
export function createAppMinter(credentials: AppCredentials, deps?: AppMinterDeps): AppMinter {
  const fetch = deps?.fetch ?? (globalThis.fetch as unknown as Fetcher);
  const jwtFn = deps?.mintJwt ?? defaultMintJwt;

  const installationCache = new Map<string, number>();
  let identityCache: AppIdentity | null = null;

  async function resolveIdentity(jwt: string): Promise<AppIdentity> {
    // GET /app reports what the App is called — slug drives the bot login.
    const appRes = await ghCall("/app", { jwt }, fetch);
    if (appRes.status !== 200) {
      throw classifyError(appRes.status, "resolving App identity (GET /app)");
    }
    const { slug } = appRes.json as { slug: string };
    const botLogin = `${slug}[bot]`;

    // Bot user id (not the App id) — needed for the commit email.
    const userRes = await ghCall(`/users/${encodeURIComponent(botLogin)}`, { jwt }, fetch);
    if (userRes.status !== 200) {
      throw new AppMintError(
        `resolving bot identity: GET /users/${botLogin} returned ${userRes.status}.`,
        userRes.status,
        "unknown",
      );
    }
    const { id: botId } = userRes.json as { id: number };
    return { slug, botLogin, botId };
  }

  async function deriveInstallation(repoSlug: string, jwt: string): Promise<number> {
    // Installation for this specific repo — derived, never declared.
    // Preflight note: use this endpoint's `permissions` for any grant check,
    // not GET /app, which reports permissions an installation has not yet approved.
    const res = await ghCall(`/repos/${repoSlug}/installation`, { jwt }, fetch);
    if (res.status !== 200) {
      throw classifyError(res.status, `deriving installation for "${repoSlug}"`);
    }
    const { id } = res.json as { id: number };
    return id;
  }

  return {
    async mint(repoSlug: string): Promise<MintResult> {
      if (!repoSlug || repoSlug.trim().length === 0) {
        throw new AppMintError(
          "repoSlug is required — refusing to mint an unnarrowed installation-wide token.",
          null,
          "unknown",
        );
      }

      let jwt: string;
      try {
        jwt = jwtFn(credentials.appId, credentials.privateKey);
      } catch (error) {
        throw new AppMintError(
          `could not create GitHub App JWT: ${error instanceof Error ? error.message : String(error)}`,
          null,
          "bad-key",
        );
      }

      // Identity is cached for the process — slug and bot id never change per App.
      if (identityCache === null) {
        identityCache = await resolveIdentity(jwt);
      }
      const identity = identityCache;

      // Installation id is cached per tenant; cleared below on any mint failure.
      let installationId = installationCache.get(repoSlug);
      if (installationId === undefined) {
        installationId = await deriveInstallation(repoSlug, jwt);
        installationCache.set(repoSlug, installationId);
      }

      // Mint: narrowed to this repo only, and to the five permissions.
      // `repositories` takes the bare name (not owner/repo).
      const repoName = repoSlug.split("/")[1]!;
      const mintRes = await ghCall(
        `/app/installations/${installationId}/access_tokens`,
        {
          jwt,
          method: "POST",
          body: { repositories: [repoName], permissions: NARROWED_PERMISSIONS },
        },
        fetch,
      );

      if (mintRes.status !== 201) {
        // Clear so the next attempt re-derives the installation id.
        installationCache.delete(repoSlug);
        throw classifyError(mintRes.status, `minting token for "${repoSlug}"`);
      }

      const { token, expires_at: expiresAt } = mintRes.json as {
        token: string;
        expires_at: string;
      };
      return { token, expiresAt, identity };
    },
  };
}
