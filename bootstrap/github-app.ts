// GitHub App credential reading and per-tenant installation token minting (#209).
//
// The App ID and private key live in the supervisor's env under the GH_APP_*
// prefix. That prefix is NOT on the engine-child allowlist, so neither key can
// ever reach a child process — the isolation property is structural, not checked
// conditionally.
//
// Usage:
//   1. Read credentials once: `readAppCredentials(process.env)`
//   2. Fetch bot identity once (slow, network): `fetchAppBotIdentity(creds)`
//   3. Per tenant per poll (when GH_TOKEN absent in .env): `mintInstallationToken(creds, slug)`

import { createSign } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";

/** Prefix that names every GitHub App credential in the supervisor env. */
export const GH_APP_CREDENTIAL_PREFIX = "GH_APP_";

export const GH_APP_ID_KEY = "GH_APP_ID";
export const GH_APP_PRIVATE_KEY_KEY = "GH_APP_PRIVATE_KEY";

export type AppCredentials = {
  /** GitHub App's numeric ID (as a string — GitHub accepts it in the JWT `iss` claim). */
  appId: string;
  /** PEM-encoded RSA private key downloaded from the App's settings page. */
  privateKey: string;
};

/** Read GitHub App credentials from the environment, or `null` when not configured. */
export function readAppCredentials(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AppCredentials | null {
  const appId = env[GH_APP_ID_KEY];
  const privateKey = env[GH_APP_PRIVATE_KEY_KEY];
  if (!appId || !privateKey) return null;
  return { appId: appId.trim(), privateKey: privateKey.trim() };
}

/**
 * Build a signed GitHub App JWT valid for 10 minutes. The JWT identifies the
 * App to the GitHub REST API (used for `/app` and `/repos/.../installation`
 * calls). A 60-second back-dated `iat` absorbs typical clock-skew between the
 * host and GitHub's servers.
 */
export function createAppJwt(creds: AppCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: creds.appId }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(data);
  const sig = sign.sign(creds.privateKey, "base64url");
  return `${data}.${sig}`;
}

/** Injectable HTTPS requester — real implementation uses Node.js `https.request`. */
export type HttpsFetch = (opts: {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; body: string }>;

/** Deadline applied to every GitHub API request, covering both connect and transfer. */
const GITHUB_API_TIMEOUT_MS = 30_000;

export const defaultFetch: HttpsFetch = (opts) =>
  new Promise((resolve, reject) => {
    const reqOpts: RequestOptions = {
      hostname: opts.hostname,
      path: opts.path,
      method: opts.method,
      headers: opts.headers,
    };
    const req = httpsRequest(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        clearTimeout(deadline);
        resolve({ status: res.statusCode ?? 0, body: data });
      });
    });
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    const deadline = setTimeout(() => {
      req.destroy(new Error(`GitHub API request timed out after ${GITHUB_API_TIMEOUT_MS}ms`));
    }, GITHUB_API_TIMEOUT_MS);
    if (opts.body) req.write(opts.body);
    req.end();
  });

function githubHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "phoebe-agent",
  };
}

/** The bot identity attached to an App installation. */
export type AppBotIdentity = {
  /** GitHub login of the bot, e.g. `"phoebe-app[bot]"`. */
  login: string;
  /** Git `author.name` for commits, same as `login`. */
  gitName: string;
  /**
   * Git `author.email` for commits. GitHub's noreply form:
   * `"<app-id>+<app-slug>[bot]@users.noreply.github.com"`.
   */
  gitEmail: string;
};

/**
 * Fetch the App's own identity from `GET /app`. Used once at fleet startup to
 * populate `PHOEBE_GH_LOGIN` and the fallback git identity in every minted env.
 * Throws on any non-200 response or JSON parse failure.
 */
export async function fetchAppBotIdentity(
  creds: AppCredentials,
  opts: { fetch?: HttpsFetch } = {},
): Promise<AppBotIdentity> {
  const fetch = opts.fetch ?? defaultFetch;
  const jwt = createAppJwt(creds);
  const response = await fetch({
    hostname: "api.github.com",
    path: "/app",
    method: "GET",
    headers: githubHeaders(jwt),
  });
  if (response.status !== 200) {
    throw new Error(`GET /app returned ${response.status}: ${response.body.slice(0, 200)}`);
  }
  const app = JSON.parse(response.body) as { slug?: unknown; id?: unknown };
  if (typeof app.slug !== "string" || app.slug.length === 0) {
    throw new Error(`GET /app: missing or invalid 'slug' in response`);
  }
  if (typeof app.id !== "number") {
    throw new Error(`GET /app: missing or invalid 'id' in response`);
  }
  const login = `${app.slug}[bot]`;
  return {
    login,
    gitName: login,
    gitEmail: `${app.id}+${login}@users.noreply.github.com`,
  };
}

/** A minted GitHub App installation access token with its expiry. */
export type MintedToken = {
  /** The short-lived installation access token. */
  token: string;
  /** Token expiry as epoch milliseconds (parsed from `expires_at` in the API response). */
  expiresAt: number;
};

/**
 * Mint a per-repo GitHub App installation access token for `slug` (`owner/repo`).
 *
 * Two-step: find the installation that covers this repo (`GET
 * /repos/{slug}/installation`), then exchange the App JWT for a short-lived
 * token scoped to that repo alone (`POST
 * /app/installations/{id}/access_tokens`). A 404 on the first call means the
 * App is not installed on this repo; a non-201 on the second is any other
 * minting error. Both throw — callers hold the tenant.
 */
export async function mintInstallationToken(
  creds: AppCredentials,
  slug: string,
  opts: { fetch?: HttpsFetch } = {},
): Promise<MintedToken> {
  const fetch = opts.fetch ?? defaultFetch;
  const jwt = createAppJwt(creds);

  const installResp = await fetch({
    hostname: "api.github.com",
    path: `/repos/${slug}/installation`,
    method: "GET",
    headers: githubHeaders(jwt),
  });
  if (installResp.status !== 200) {
    throw new Error(
      `GET /repos/${slug}/installation returned ${installResp.status} (${summary(installResp.body)})`,
    );
  }
  const install = JSON.parse(installResp.body) as { id?: unknown };
  if (typeof install.id !== "number") {
    throw new Error(`GET /repos/${slug}/installation: missing or invalid 'id' in response`);
  }

  const [, repo] = slug.split("/");
  const tokenBody = JSON.stringify({ repositories: [repo] });
  const tokenResp = await fetch({
    hostname: "api.github.com",
    path: `/app/installations/${install.id}/access_tokens`,
    method: "POST",
    headers: {
      ...githubHeaders(jwt),
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(tokenBody)),
    },
    body: tokenBody,
  });
  if (tokenResp.status !== 201) {
    throw new Error(
      `POST /app/installations/${install.id}/access_tokens returned ${tokenResp.status} (${summary(tokenResp.body)})`,
    );
  }
  const tokenData = JSON.parse(tokenResp.body) as { token?: unknown; expires_at?: unknown };
  if (typeof tokenData.token !== "string" || tokenData.token.length === 0) {
    throw new Error(
      `POST /app/installations/${install.id}/access_tokens: missing or invalid 'token' in response`,
    );
  }
  const expiresAt = Date.parse(
    typeof tokenData.expires_at === "string" ? tokenData.expires_at : "",
  );
  if (isNaN(expiresAt)) {
    throw new Error(
      `POST /app/installations/${install.id}/access_tokens: missing or invalid 'expires_at' in response`,
    );
  }
  return { token: tokenData.token, expiresAt };
}

function summary(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return parsed.message ?? body.slice(0, 120);
  } catch {
    return body.slice(0, 120);
  }
}
