import { describe, expect, test } from "vite-plus/test";
import { GOOGLE_ISSUER, GOOGLE_SCOPE, newAuthParams, pkceChallenge } from "./oidc.ts";

describe("PKCE", () => {
  test("matches RFC 7636's own S256 example", () => {
    // Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // hashes to "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("newAuthParams", () => {
  test("mints a distinct state, nonce and verifier every time", () => {
    const a = newAuthParams();
    const b = newAuthParams();

    expect(new Set([a.state, a.nonce, a.codeVerifier, b.state, b.nonce, b.codeVerifier]).size).toBe(
      6,
    );
  });

  test("the verifier is inside RFC 7636's 43–128 character range", () => {
    const { codeVerifier } = newAuthParams();

    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("the challenge is the verifier's S256 hash, not the verifier", () => {
    const params = newAuthParams();

    expect(params.codeChallenge).toBe(pkceChallenge(params.codeVerifier));
    expect(params.codeChallenge).not.toBe(params.codeVerifier);
  });
});

describe("what the relay asks Google for", () => {
  test("openid and email, and nothing else", () => {
    expect(GOOGLE_SCOPE).toBe("openid email");
    expect(GOOGLE_ISSUER).toBe("https://accounts.google.com");
  });
});
