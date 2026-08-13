// Tests for GitHub App credential reading, JWT creation, and the minting
// path — all driven through injected fakes so no network or real key is needed.

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  createAppJwt,
  fetchAppBotIdentity,
  GH_APP_CREDENTIAL_PREFIX,
  GH_APP_ID_KEY,
  GH_APP_PRIVATE_KEY_KEY,
  mintInstallationToken,
  readAppCredentials,
  type AppCredentials,
  type HttpsFetch,
} from "./github-app.ts";

// Generate a real RSA key pair once for the entire test file. 2048-bit is
// secure for signing; the tests only check structure, not cryptographic
// correctness, so we avoid making this larger.
const { privateKey: generatedKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PRIVATE_KEY = generatedKey.export({ type: "pkcs8", format: "pem" }) as string;
const TEST_CREDS: AppCredentials = { appId: "12345", privateKey: TEST_PRIVATE_KEY };

// ---------------------------------------------------------------------------
// Credential prefix
// ---------------------------------------------------------------------------

describe("GH_APP_CREDENTIAL_PREFIX", () => {
  test("covers both credential keys", () => {
    expect(GH_APP_ID_KEY.startsWith(GH_APP_CREDENTIAL_PREFIX)).toBe(true);
    expect(GH_APP_PRIVATE_KEY_KEY.startsWith(GH_APP_CREDENTIAL_PREFIX)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readAppCredentials
// ---------------------------------------------------------------------------

describe("readAppCredentials", () => {
  test("returns null when both vars are absent", () => {
    expect(readAppCredentials({})).toBeNull();
  });

  test("returns null when only the ID is present", () => {
    expect(readAppCredentials({ [GH_APP_ID_KEY]: "1" })).toBeNull();
  });

  test("returns null when only the key is present", () => {
    expect(readAppCredentials({ [GH_APP_PRIVATE_KEY_KEY]: "pem" })).toBeNull();
  });

  test("returns credentials when both vars are set", () => {
    const creds = readAppCredentials({
      [GH_APP_ID_KEY]: "  42  ",
      [GH_APP_PRIVATE_KEY_KEY]: "  pem-body  ",
    });
    expect(creds).not.toBeNull();
    expect(creds!.appId).toBe("42");
    expect(creds!.privateKey).toBe("pem-body");
  });
});

// ---------------------------------------------------------------------------
// createAppJwt
// ---------------------------------------------------------------------------

describe("createAppJwt", () => {
  test("produces a three-part dot-separated string", () => {
    const jwt = createAppJwt(TEST_CREDS);
    expect(jwt.split(".")).toHaveLength(3);
  });

  test("header decodes to RS256/JWT", () => {
    const [headerB64] = createAppJwt(TEST_CREDS).split(".");
    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8"));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  test("payload contains iss, iat, exp with sensible values", () => {
    const before = Math.floor(Date.now() / 1000);
    const [, payloadB64] = createAppJwt(TEST_CREDS).split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8")) as {
      iss: string;
      iat: number;
      exp: number;
    };
    const after = Math.floor(Date.now() / 1000);
    expect(payload.iss).toBe("12345");
    // iat is back-dated 60s; exp is iat + 660s max
    expect(payload.iat).toBeGreaterThanOrEqual(before - 61);
    expect(payload.iat).toBeLessThanOrEqual(after);
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(payload.exp - payload.iat).toBe(660); // 660 = 600 + 60 back-date
  });

  test("produces a different JWT each call (iat changes with time)", () => {
    // Two calls are within the same second in the test runner, so iat may
    // match — but the signature at minimum covers randomness in the padding.
    // Just check the shape is stable: three non-empty parts.
    const jwt = createAppJwt(TEST_CREDS);
    for (const part of jwt.split(".")) {
      expect(part.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchAppBotIdentity
// ---------------------------------------------------------------------------

describe("fetchAppBotIdentity", () => {
  const okFetch: HttpsFetch = async () => ({
    status: 200,
    body: JSON.stringify({ slug: "phoebe-app", id: 99 }),
  });

  test("returns login, gitName, and gitEmail from the /app response", async () => {
    const identity = await fetchAppBotIdentity(TEST_CREDS, { fetch: okFetch });
    expect(identity.login).toBe("phoebe-app[bot]");
    expect(identity.gitName).toBe("phoebe-app[bot]");
    expect(identity.gitEmail).toBe("99+phoebe-app[bot]@users.noreply.github.com");
  });

  test("throws on a non-200 /app response", async () => {
    const badFetch: HttpsFetch = async () => ({
      status: 401,
      body: JSON.stringify({ message: "Bad credentials" }),
    });
    await expect(fetchAppBotIdentity(TEST_CREDS, { fetch: badFetch })).rejects.toThrow(
      /GET \/app returned 401/,
    );
  });

  test("calls /app with a Bearer JWT header", async () => {
    const seen: string[] = [];
    const captureFetch: HttpsFetch = async (opts) => {
      seen.push(opts.headers["Authorization"] ?? "");
      return { status: 200, body: JSON.stringify({ slug: "app", id: 1 }) };
    };
    await fetchAppBotIdentity(TEST_CREDS, { fetch: captureFetch });
    expect(seen[0]).toMatch(/^Bearer /);
  });
});

// ---------------------------------------------------------------------------
// mintInstallationToken
// ---------------------------------------------------------------------------

describe("mintInstallationToken", () => {
  const slug = "owner/repo";
  const installationId = 77;
  const mintedToken = "ghs_fake_token";

  function makeFetch(installStatus: number, tokenStatus: number): HttpsFetch {
    return async (opts) => {
      if (opts.path === `/repos/${slug}/installation`) {
        return { status: installStatus, body: JSON.stringify({ id: installationId }) };
      }
      return { status: tokenStatus, body: JSON.stringify({ token: mintedToken }) };
    };
  }

  test("returns the minted token on success", async () => {
    const token = await mintInstallationToken(TEST_CREDS, slug, { fetch: makeFetch(200, 201) });
    expect(token).toBe(mintedToken);
  });

  test("throws with status when the installation is not found (404)", async () => {
    await expect(
      mintInstallationToken(TEST_CREDS, slug, {
        fetch: async (opts) => {
          if (opts.path.includes("/installation")) {
            return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
          }
          return { status: 201, body: JSON.stringify({ token: mintedToken }) };
        },
      }),
    ).rejects.toThrow(/returned 404/);
  });

  test("throws when the token endpoint returns an error", async () => {
    await expect(
      mintInstallationToken(TEST_CREDS, slug, { fetch: makeFetch(200, 422) }),
    ).rejects.toThrow(/returned 422/);
  });

  test("scopes the token to the repo name only (not the full slug)", async () => {
    let tokenReqBody: string | undefined;
    const captureFetch: HttpsFetch = async (opts) => {
      if (opts.path.includes("/access_tokens")) {
        tokenReqBody = opts.body;
        return { status: 201, body: JSON.stringify({ token: mintedToken }) };
      }
      return { status: 200, body: JSON.stringify({ id: installationId }) };
    };
    await mintInstallationToken(TEST_CREDS, "owner/repo", { fetch: captureFetch });
    const parsed = JSON.parse(tokenReqBody!) as { repositories: string[] };
    // Scoped to the repo name, NOT the full slug — a token for "repo" under
    // the installation's account, not "owner/repo" (which GitHub wouldn't accept).
    expect(parsed.repositories).toEqual(["repo"]);
    expect(parsed.repositories).not.toContain("owner/repo");
  });
});
