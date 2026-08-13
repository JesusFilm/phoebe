// Tests for the supervisor-side GitHub App module (#207).
// Tests focus on shape validation (readAppCredentials) and the network-layer
// logic of the minter (createAppMinter). JWT signing is injected so tests
// do not need a real RSA key.

import { describe, expect, test } from "vite-plus/test";
import {
  AppConfigError,
  AppMintError,
  GH_APP_ENV_PREFIX,
  createAppMinter,
  readAppCredentials,
  type AppCredentials,
  type Fetcher,
} from "./gh-app.ts";

// ---------------------------------------------------------------- helpers

function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

const FAKE_PEM = "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----";
const FAKE_PEM_B64 = b64(FAKE_PEM);
const FAKE_JWT = "fake.jwt.token";
const FAKE_JWT_FN = (): string => FAKE_JWT;

function makeCredentials(): AppCredentials {
  return { appId: "123456", privateKey: FAKE_PEM };
}

/**
 * Build a fake fetch function that maps method+path patterns to responses.
 * `routes` is an array of [methodOrGET, urlSubstring, response] triples.
 */
function mockFetch(routes: [string, string, { status: number; body?: unknown }][]): Fetcher {
  return async (url: string, init?: { method?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const match = routes.find(([m, path]) => m.toUpperCase() === method && url.includes(path));
    const found = match ?? ["", "", { status: 500, body: { message: "unmocked route" } }];
    const body = found[2].body ?? null;
    return {
      status: found[2].status,
      json: async () => body,
    };
  };
}

const IDENTITY_ROUTES: [string, string, { status: number; body?: unknown }][] = [
  ["GET", "/app", { status: 200, body: { slug: "phoebe-bot" } }],
  ["GET", "/users/phoebe-bot%5Bbot%5D", { status: 200, body: { id: 999 } }],
];

const INSTALLATION_ROUTE: [string, string, { status: number; body?: unknown }] = [
  "GET",
  "/repos/owner/repo/installation",
  { status: 200, body: { id: 42 } },
];

const MINT_ROUTE: [string, string, { status: number; body?: unknown }] = [
  "POST",
  "/app/installations/42/access_tokens",
  { status: 201, body: { token: "ghs_faketoken", expires_at: "2026-08-13T12:00:00Z" } },
];

// ---------------------------------------------------------------- readAppCredentials

describe("readAppCredentials", () => {
  test("returns null when both vars are absent", () => {
    expect(readAppCredentials({})).toBeNull();
  });

  test("returns null when unrelated vars are present", () => {
    expect(readAppCredentials({ GH_TOKEN: "ghp_abc", PATH: "/usr/bin" })).toBeNull();
  });

  test("throws AppConfigError when ID is set but KEY is missing", () => {
    const env = { [`${GH_APP_ENV_PREFIX}ID`]: "123" };
    expect(() => readAppCredentials(env)).toThrow(AppConfigError);
    // Error should name both variable names
    try {
      readAppCredentials(env);
    } catch (e) {
      expect((e as AppConfigError).message).toContain(`${GH_APP_ENV_PREFIX}ID`);
      expect((e as AppConfigError).message).toContain(`${GH_APP_ENV_PREFIX}PRIVATE_KEY`);
    }
  });

  test("throws AppConfigError when KEY is set but ID is missing", () => {
    const env = { [`${GH_APP_ENV_PREFIX}PRIVATE_KEY`]: FAKE_PEM_B64 };
    expect(() => readAppCredentials(env)).toThrow(AppConfigError);
    try {
      readAppCredentials(env);
    } catch (e) {
      expect((e as AppConfigError).message).toContain(`${GH_APP_ENV_PREFIX}PRIVATE_KEY`);
      expect((e as AppConfigError).message).toContain(`${GH_APP_ENV_PREFIX}ID`);
    }
  });

  test("throws AppConfigError when KEY is not valid base64 / decodes to no PEM header", () => {
    const env = {
      [`${GH_APP_ENV_PREFIX}ID`]: "123",
      [`${GH_APP_ENV_PREFIX}PRIVATE_KEY`]: "this-is-not-a-pem",
    };
    expect(() => readAppCredentials(env)).toThrow(AppConfigError);
    try {
      readAppCredentials(env);
    } catch (e) {
      // Error must name base64 so the operator knows what to fix
      expect((e as AppConfigError).message).toContain("base64");
    }
  });

  test("throws AppConfigError when KEY decodes but has no PEM header", () => {
    const env = {
      [`${GH_APP_ENV_PREFIX}ID`]: "123",
      // Valid base64 of a string without a PEM header
      [`${GH_APP_ENV_PREFIX}PRIVATE_KEY`]: b64("just some text, no pem"),
    };
    expect(() => readAppCredentials(env)).toThrow(AppConfigError);
    try {
      readAppCredentials(env);
    } catch (e) {
      expect((e as AppConfigError).message).toContain("base64");
    }
  });

  test("returns credentials when both vars are present and valid", () => {
    const env = {
      [`${GH_APP_ENV_PREFIX}ID`]: "123456",
      [`${GH_APP_ENV_PREFIX}PRIVATE_KEY`]: FAKE_PEM_B64,
    };
    const result = readAppCredentials(env);
    expect(result).not.toBeNull();
    expect(result!.appId).toBe("123456");
    expect(result!.privateKey).toBe(FAKE_PEM);
  });
});

// ---------------------------------------------------------------- GH_APP_ENV_PREFIX export

test("GH_APP_ENV_PREFIX ends with underscore (prefix, not full name)", () => {
  expect(GH_APP_ENV_PREFIX).toBe("PHOEBE_GH_APP_");
  expect(GH_APP_ENV_PREFIX.endsWith("_")).toBe(true);
});

// ---------------------------------------------------------------- createAppMinter — slug guard

describe("createAppMinter — slug guard", () => {
  test("throws AppMintError immediately when repoSlug is empty", async () => {
    const minter = createAppMinter(makeCredentials(), {
      fetch: mockFetch([]),
      mintJwt: FAKE_JWT_FN,
    });
    await expect(minter.mint("")).rejects.toThrow(AppMintError);
  });

  test("throws AppMintError immediately when repoSlug is whitespace-only", async () => {
    const minter = createAppMinter(makeCredentials(), {
      fetch: mockFetch([]),
      mintJwt: FAKE_JWT_FN,
    });
    await expect(minter.mint("   ")).rejects.toThrow(AppMintError);
  });
});

// ---------------------------------------------------------------- createAppMinter — JWT failure

describe("createAppMinter — JWT signing failure", () => {
  test("throws AppMintError with bad-key when mintJwt throws", async () => {
    const minter = createAppMinter(makeCredentials(), {
      fetch: mockFetch([]),
      mintJwt: () => {
        throw new Error("error:0906D06C:PEM routines:bad key");
      },
    });
    const err = await minter.mint("owner/repo").catch((e) => e);
    expect(err).toBeInstanceOf(AppMintError);
    expect((err as AppMintError).classification).toBe("bad-key");
    expect((err as AppMintError).status).toBeNull();
  });
});

// ---------------------------------------------------------------- createAppMinter — identity resolution

describe("createAppMinter — identity resolution", () => {
  test("classifies 401 from GET /app as bad-key", async () => {
    const minter = createAppMinter(makeCredentials(), {
      fetch: mockFetch([["GET", "/app", { status: 401, body: { message: "Bad credentials" } }]]),
      mintJwt: FAKE_JWT_FN,
    });
    const err = await minter.mint("owner/repo").catch((e) => e);
    expect(err).toBeInstanceOf(AppMintError);
    expect((err as AppMintError).classification).toBe("bad-key");
    expect((err as AppMintError).status).toBe(401);
  });

  test("returns unknown classification when user lookup returns unexpected status", async () => {
    const minter = createAppMinter(makeCredentials(), {
      fetch: mockFetch([
        ["GET", "/app", { status: 200, body: { slug: "phoebe-bot" } }],
        ["GET", "/users/phoebe-bot%5Bbot%5D", { status: 503, body: {} }],
      ]),
      mintJwt: FAKE_JWT_FN,
    });
    const err = await minter.mint("owner/repo").catch((e) => e);
    expect(err).toBeInstanceOf(AppMintError);
    expect((err as AppMintError).status).toBe(503);
    expect((err as AppMintError).classification).toBe("unknown");
  });

  test("caches bot identity across multiple mint calls", async () => {
    let appCalls = 0;
    const fetch: Fetcher = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/app") && !url.includes("/users")) {
        appCalls++;
        return { status: 200, json: async () => ({ slug: "phoebe-bot" }) };
      }
      if (method === "GET" && url.includes("/users/")) {
        return { status: 200, json: async () => ({ id: 999 }) };
      }
      if (method === "GET" && url.includes("/installation")) {
        return { status: 200, json: async () => ({ id: 42 }) };
      }
      return {
        status: 201,
        json: async () => ({ token: "ghs_tok", expires_at: "2026-08-13T12:00:00Z" }),
      };
    };
    const minter = createAppMinter(makeCredentials(), { fetch, mintJwt: FAKE_JWT_FN });
    await minter.mint("owner/repo");
    await minter.mint("owner/other");
    // GET /app must only fire once — identity is cached for the process
    expect(appCalls).toBe(1);
  });
});

// ---------------------------------------------------------------- createAppMinter — installation

describe("createAppMinter — installation derivation", () => {
  test("classifies 401 from installation lookup as bad-key", async () => {
    const minter = createAppMinter(makeCredentials(), {
      fetch: mockFetch([
        ...IDENTITY_ROUTES,
        ["GET", "/repos/owner/repo/installation", { status: 401, body: {} }],
      ]),
      mintJwt: FAKE_JWT_FN,
    });
    const err = await minter.mint("owner/repo").catch((e) => e);
    expect(err).toBeInstanceOf(AppMintError);
    expect((err as AppMintError).classification).toBe("bad-key");
  });

  test("classifies 404 from installation lookup as not-in-scope", async () => {
    const minter = createAppMinter(makeCredentials(), {
      fetch: mockFetch([
        ...IDENTITY_ROUTES,
        ["GET", "/repos/owner/repo/installation", { status: 404, body: {} }],
      ]),
      mintJwt: FAKE_JWT_FN,
    });
    const err = await minter.mint("owner/repo").catch((e) => e);
    expect(err).toBeInstanceOf(AppMintError);
    expect((err as AppMintError).classification).toBe("not-in-scope");
    expect((err as AppMintError).status).toBe(404);
    // Error message must mention ambiguity
    expect((err as AppMintError).message).toContain("renamed or deleted");
  });

  test("caches installation id and does not re-derive on the second successful mint", async () => {
    let installCalls = 0;
    const fetch: Fetcher = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/app") && !url.includes("/users")) {
        return { status: 200, json: async () => ({ slug: "phoebe-bot" }) };
      }
      if (method === "GET" && url.includes("/users/")) {
        return { status: 200, json: async () => ({ id: 999 }) };
      }
      if (method === "GET" && url.includes("/installation")) {
        installCalls++;
        return { status: 200, json: async () => ({ id: 42 }) };
      }
      return {
        status: 201,
        json: async () => ({ token: "ghs_tok", expires_at: "2026-08-13T12:00:00Z" }),
      };
    };
    const minter = createAppMinter(makeCredentials(), { fetch, mintJwt: FAKE_JWT_FN });
    await minter.mint("owner/repo");
    await minter.mint("owner/repo");
    expect(installCalls).toBe(1);
  });

  test("re-derives installation after a mint failure clears the cache", async () => {
    let installCalls = 0;
    let mintCalls = 0;
    const fetch: Fetcher = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/app") && !url.includes("/users")) {
        return { status: 200, json: async () => ({ slug: "phoebe-bot" }) };
      }
      if (method === "GET" && url.includes("/users/")) {
        return { status: 200, json: async () => ({ id: 999 }) };
      }
      if (method === "GET" && url.includes("/installation")) {
        installCalls++;
        return { status: 200, json: async () => ({ id: 42 }) };
      }
      // First mint fails, second succeeds
      mintCalls++;
      if (mintCalls === 1) {
        return { status: 422, json: async () => ({ message: "not installed" }) };
      }
      return {
        status: 201,
        json: async () => ({ token: "ghs_tok", expires_at: "2026-08-13T12:00:00Z" }),
      };
    };
    const minter = createAppMinter(makeCredentials(), { fetch, mintJwt: FAKE_JWT_FN });
    await minter.mint("owner/repo").catch(() => {});
    await minter.mint("owner/repo");
    expect(installCalls).toBe(2);
  });
});

// ---------------------------------------------------------------- createAppMinter — mint failures

describe("createAppMinter — mint failure classification", () => {
  function minterWith(mintStatus: number) {
    return createAppMinter(makeCredentials(), {
      fetch: mockFetch([
        ...IDENTITY_ROUTES,
        INSTALLATION_ROUTE,
        ["POST", "/app/installations/42/access_tokens", { status: mintStatus, body: {} }],
      ]),
      mintJwt: FAKE_JWT_FN,
    });
  }

  test("401 → bad-key", async () => {
    const err = await minterWith(401)
      .mint("owner/repo")
      .catch((e) => e);
    expect((err as AppMintError).classification).toBe("bad-key");
    expect((err as AppMintError).status).toBe(401);
  });

  test("403 → forbidden", async () => {
    const err = await minterWith(403)
      .mint("owner/repo")
      .catch((e) => e);
    expect((err as AppMintError).classification).toBe("forbidden");
    expect((err as AppMintError).status).toBe(403);
  });

  test("404 → not-in-scope", async () => {
    const err = await minterWith(404)
      .mint("owner/repo")
      .catch((e) => e);
    expect((err as AppMintError).classification).toBe("not-in-scope");
    expect((err as AppMintError).status).toBe(404);
  });

  test("422 → not-installed", async () => {
    const err = await minterWith(422)
      .mint("owner/repo")
      .catch((e) => e);
    expect((err as AppMintError).classification).toBe("not-installed");
    expect((err as AppMintError).status).toBe(422);
  });

  test("unexpected status → unknown with status preserved", async () => {
    const err = await minterWith(503)
      .mint("owner/repo")
      .catch((e) => e);
    expect((err as AppMintError).classification).toBe("unknown");
    expect((err as AppMintError).status).toBe(503);
  });
});

// ---------------------------------------------------------------- createAppMinter — successful mint

describe("createAppMinter — successful mint", () => {
  test("returns token, expiresAt, and bot identity on HTTP 201", async () => {
    const minter = createAppMinter(makeCredentials(), {
      fetch: mockFetch([...IDENTITY_ROUTES, INSTALLATION_ROUTE, MINT_ROUTE]),
      mintJwt: FAKE_JWT_FN,
    });
    const result = await minter.mint("owner/repo");
    expect(result.token).toBe("ghs_faketoken");
    expect(result.expiresAt).toBe("2026-08-13T12:00:00Z");
    expect(result.identity.slug).toBe("phoebe-bot");
    expect(result.identity.botLogin).toBe("phoebe-bot[bot]");
    expect(result.identity.botId).toBe(999);
  });

  test("bot commit email can be derived from MintResult.identity", async () => {
    const minter = createAppMinter(makeCredentials(), {
      fetch: mockFetch([...IDENTITY_ROUTES, INSTALLATION_ROUTE, MINT_ROUTE]),
      mintJwt: FAKE_JWT_FN,
    });
    const { identity } = await minter.mint("owner/repo");
    const commitEmail = `${identity.botId}+${identity.botLogin}@users.noreply.github.com`;
    expect(commitEmail).toBe("999+phoebe-bot[bot]@users.noreply.github.com");
  });

  test("different tenants get separate installation lookups but share identity", async () => {
    const fetch: Fetcher = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/app") && !url.includes("/users")) {
        return { status: 200, json: async () => ({ slug: "phoebe-bot" }) };
      }
      if (method === "GET" && url.includes("/users/")) {
        return { status: 200, json: async () => ({ id: 999 }) };
      }
      if (method === "GET" && url.includes("/repos/owner/repo-a/installation")) {
        return { status: 200, json: async () => ({ id: 10 }) };
      }
      if (method === "GET" && url.includes("/repos/owner/repo-b/installation")) {
        return { status: 200, json: async () => ({ id: 20 }) };
      }
      return {
        status: 201,
        json: async () => ({ token: "ghs_tok", expires_at: "2026-08-13T12:00:00Z" }),
      };
    };
    const minter = createAppMinter(makeCredentials(), { fetch, mintJwt: FAKE_JWT_FN });
    const a = await minter.mint("owner/repo-a");
    const b = await minter.mint("owner/repo-b");
    // Same identity
    expect(a.identity).toBe(b.identity);
    // Tokens from different installs are both returned
    expect(a.token).toBe("ghs_tok");
    expect(b.token).toBe("ghs_tok");
  });
});
