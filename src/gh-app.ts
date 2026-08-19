// GitHub App token minting for App-mode deployments.
//
// When a deployment supplies GH_APP_ID and GH_APP_PRIVATE_KEY
// but no explicit GH_TOKEN, the engine mints a short-lived installation token
// before each poll cycle and injects it as GH_TOKEN. The App credentials
// themselves never reach child processes (only the minted token does).
//
// See also: agent-env.ts (allowlist enforcement), main.ts (arm selection + log).

import { createSign } from "node:crypto";

/** Shared prefix for every GitHub App env var the engine reads. */
export const GH_APP_ENV_PREFIX = "GH_APP_";

export type AppCredentials = {
  appId: string;
  privateKey: string;
};

export type MintSuccess = {
  ok: true;
  token: string;
  botLogin: string;
  botName: string;
  botEmail: string;
};

export type MintFailure = {
  ok: false;
  status: number | null;
  reason: string;
};

export type MintResult = MintSuccess | MintFailure;

/** Return App credentials from env, or null when App mode is not configured. */
export function detectAppCredentials(
  env: Record<string, string | undefined>,
): AppCredentials | null {
  const appId = env[`${GH_APP_ENV_PREFIX}ID`];
  const privateKey = env[`${GH_APP_ENV_PREFIX}PRIVATE_KEY`];
  if (!appId || !privateKey) return null;
  return { appId, privateKey };
}

// ---------------------------------------------------------------------------
// JWT building — RS256-signed, GitHub App format
// ---------------------------------------------------------------------------

function base64url(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

function buildAppJwt(appId: string, privateKey: string): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSecs - 60,
      exp: nowSecs + 600,
      iss: appId,
    }),
  );
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return `${data}.${base64url(signer.sign(privateKey))}`;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

const GH_API = "https://api.github.com";
const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "phoebe-agent",
} as const;

async function ghGet<T>(path: string, token: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${GH_API}${path}`, {
    headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function ghPost<T>(
  path: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${GH_API}${path}`, {
    method: "POST",
    headers: {
      ...GH_HEADERS,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived GitHub App installation token for `repoSlug`.
 *
 * Steps:
 *   1. Build a RS256 JWT from the app credentials.
 *   2. GET /app → resolve the app slug (becomes the bot login).
 *   3. GET /repos/{owner}/{repo}/installation → resolve the installation id.
 *   4. POST /app/installations/{id}/access_tokens → mint the token.
 *   5. GET /users/{slug}[bot] → resolve the bot user id for the noreply email.
 *
 * Returns a `MintFailure` on any step failure, including JWT signing errors and
 * non-2xx HTTP responses; the `reason` field contains the raw status + message
 * so the caller can log them verbatim.
 */
export async function mintInstallationToken(
  repoSlug: string,
  creds: AppCredentials,
): Promise<MintResult> {
  const [owner, repo] = repoSlug.split("/") as [string, string];

  let jwt: string;
  try {
    jwt = buildAppJwt(creds.appId, creds.privateKey);
  } catch (err) {
    return {
      ok: false,
      status: null,
      reason: `JWT build failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Resolve app slug and installation id in sequence (both use the JWT).
  const appResult = await ghGet<{ slug?: string; message?: string }>("/app", jwt);
  if (appResult.status !== 200) {
    return {
      ok: false,
      status: appResult.status,
      reason: `GET /app: ${appResult.status} ${appResult.body.message ?? "unknown"}`,
    };
  }
  const appSlug = appResult.body.slug;
  if (!appSlug) {
    return { ok: false, status: null, reason: "GET /app: missing slug field" };
  }
  const botLogin = `${appSlug}[bot]`;

  const installResult = await ghGet<{ id?: number; message?: string }>(
    `/repos/${owner}/${repo}/installation`,
    jwt,
  );
  if (installResult.status !== 200) {
    return {
      ok: false,
      status: installResult.status,
      reason: `GET /repos/${owner}/${repo}/installation: ${installResult.status} ${installResult.body.message ?? "unknown"}`,
    };
  }
  const installationId = installResult.body.id;
  if (!installationId) {
    return {
      ok: false,
      status: null,
      reason: "GET /repos/.../installation: missing id field",
    };
  }

  // Mint the token, scoped to this repo only.
  const tokenResult = await ghPost<{ token?: string; message?: string }>(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { repositories: [repo] },
  );
  if (tokenResult.status !== 201) {
    return {
      ok: false,
      status: tokenResult.status,
      reason: `POST /app/installations/${installationId}/access_tokens: ${tokenResult.status} ${tokenResult.body.message ?? "unknown"}`,
    };
  }
  const token = tokenResult.body.token;
  if (!token) {
    return { ok: false, status: null, reason: "POST access_tokens: missing token field" };
  }

  // Resolve the bot user's numeric id for the canonical noreply email.
  const botUserResult = await ghGet<{ id?: number }>(
    `/users/${encodeURIComponent(botLogin)}`,
    token,
  );
  const botEmail =
    botUserResult.status === 200 && botUserResult.body.id
      ? `${botUserResult.body.id}+${botLogin}@users.noreply.github.com`
      : `${botLogin}@users.noreply.github.com`;

  return { ok: true, token, botLogin, botName: botLogin, botEmail };
}
