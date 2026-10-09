// The relay's one edge onto Google (#499, #506 §9), behind a seam.
//
// The flow is OpenID Connect's authorization-code (server) flow: the browser
// goes to Google carrying `state`, `nonce` and a PKCE challenge; Google sends
// it back with a code; the relay exchanges the code for an ID token over TLS
// straight from the token endpoint and reads `sub`, `email` and
// `email_verified` out of it. No refresh token is asked for, the userinfo
// endpoint is never called, and the tokeninfo endpoint — Google's own docs call
// it a debugging aid — is not in the picture.
//
// `openid-client` does the parts that are easy to get subtly wrong: the state
// and nonce comparisons, the PKCE exchange, and the ID-token claim checks
// (`iss`, `aud`, `exp`, `iat`, `nonce`). It does not verify the JWS signature
// on the ID token, and that is correct rather than a gap: OIDC Core 3.1.3.7
// rule 6 lets a client that received the token directly from the token endpoint
// over TLS rely on TLS server validation instead.
//
// The seam is here so the sign-in routes can be tested without a Google. The
// only thing on the far side of it is the network.

import { createHash, randomBytes } from "node:crypto";

/** Google's discovery issuer. `openid-client` reads the rest off it. */
export const GOOGLE_ISSUER = "https://accounts.google.com";

/** Everything the relay asks Google for: who this is, and their address. */
export const GOOGLE_SCOPE = "openid email";

/** The per-sign-in randomness, generated before the redirect and checked after. */
export type AuthParams = {
  /** Anti-forgery token echoed back on the callback. */
  state: string;
  /** Replay protection, bound into the ID token. */
  nonce: string;
  /** PKCE verifier; only its S256 hash goes to Google. */
  codeVerifier: string;
  /** `BASE64URL(SHA256(codeVerifier))`. */
  codeChallenge: string;
};

/** What the ID token said, before the relay has an opinion about it. */
export type GoogleIdentity = {
  /** Google's subject identifier: the key a person is recorded under. */
  sub: string;
  /** Present when the `email` scope was granted. */
  email?: string;
  /** Google's own word on whether it took steps to confirm the address. */
  emailVerified: boolean;
};

/**
 * The relay's view of an OpenID provider: build the URL to send a browser to,
 * then turn the callback into an identity. Two methods, both network-bound,
 * which is why they are a seam and not an import.
 */
export type IdentityProvider = {
  authorizationUrl: (params: Omit<AuthParams, "codeVerifier">) => Promise<string>;
  /** Throws when any check fails; the caller turns that into a refusal. */
  verifyCallback: (input: {
    currentUrl: URL;
    expectedState: string;
    expectedNonce: string;
    codeVerifier: string;
  }) => Promise<GoogleIdentity>;
};

/**
 * Fresh `state`, `nonce` and PKCE pair for one sign-in. 32 bytes each, well
 * past the "30 or so characters" Google asks of `state` and inside RFC 7636's
 * 43–128 character verifier range once base64url-encoded (43 characters).
 */
export function newAuthParams(): AuthParams {
  const codeVerifier = randomBytes(32).toString("base64url");
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    codeVerifier,
    codeChallenge: pkceChallenge(codeVerifier),
  };
}

/** RFC 7636 S256: `BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`. */
export function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

type OpenIdClient = typeof import("openid-client");
type Discovered = {
  client: OpenIdClient;
  config: Awaited<ReturnType<OpenIdClient["discovery"]>>;
};

/**
 * The real provider, talking to Google. Discovery happens once, lazily, on the
 * first sign-in: a relay nobody has signed into yet has made no outbound
 * request, and a start-up that does not depend on Google being reachable is a
 * start-up that survives a Google outage.
 */
export function createGoogleIdentityProvider(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): IdentityProvider {
  let discovered: Promise<Discovered> | undefined;

  function configuration(): Promise<Discovered> {
    discovered ??= (async () => {
      const client: OpenIdClient = await import("openid-client");
      const config = await client.discovery(
        new URL(GOOGLE_ISSUER),
        options.clientId,
        options.clientSecret,
      );
      return { client, config };
    })();
    return discovered;
  }

  return {
    async authorizationUrl({ state, nonce, codeChallenge }) {
      const { client, config } = await configuration();
      return client.buildAuthorizationUrl(config, {
        redirect_uri: options.redirectUri,
        scope: GOOGLE_SCOPE,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).href;
    },

    async verifyCallback({ currentUrl, expectedState, expectedNonce, codeVerifier }) {
      const { client, config } = await configuration();
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        expectedState,
        expectedNonce,
        pkceCodeVerifier: codeVerifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (claims === undefined) throw new Error("Google returned no ID token");
      return {
        sub: claims.sub,
        ...(typeof claims.email === "string" ? { email: claims.email } : {}),
        emailVerified: claims.email_verified === true,
      };
    },
  };
}
