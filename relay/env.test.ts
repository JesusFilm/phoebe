import { describe, expect, test } from "vite-plus/test";
import { parseAllowedEmails, readRelayEnv, redirectUri, RelayEnvError } from "./env.ts";

const complete = {
  RELAY_HOST: "relay.example.test",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  ALLOWED_EMAILS: "Ada@example.test, grace@example.test",
} satisfies NodeJS.ProcessEnv;

describe("readRelayEnv", () => {
  test("reads the four required variables, and the optional fifth", () => {
    expect(readRelayEnv({ ...complete })).toEqual({
      host: "relay.example.test",
      clientId: "client-id",
      clientSecret: "client-secret",
      allowedEmails: ["ada@example.test", "grace@example.test"],
      alertWebhook: null,
    });
    expect(
      readRelayEnv({ ...complete, RELAY_ALERT_WEBHOOK: "  https://hooks.example.test/abc  " })
        .alertWebhook,
    ).toBe("https://hooks.example.test/abc");
    expect(readRelayEnv({ ...complete, RELAY_ALERT_WEBHOOK: "   " }).alertWebhook).toBe(null);
  });

  test("names every missing variable at once", () => {
    const partial = { RELAY_HOST: "relay.example.test" };
    expect(() => readRelayEnv(partial)).toThrow(RelayEnvError);
    try {
      readRelayEnv(partial);
      expect.unreachable("readRelayEnv accepted an incomplete environment");
    } catch (error) {
      expect((error as RelayEnvError).name).toBe("RelayEnvError");
      expect((error as RelayEnvError).missing).toEqual([
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "ALLOWED_EMAILS",
      ]);
      expect((error as Error).message).toContain("GOOGLE_CLIENT_SECRET");
    }
  });

  test("a blank host or credential is as missing as an absent one", () => {
    const blank = { ...complete, RELAY_HOST: "  ", GOOGLE_CLIENT_SECRET: "" };
    expect(() => readRelayEnv(blank)).toThrow(/RELAY_HOST, GOOGLE_CLIENT_SECRET/);
  });

  test("a blank ALLOWED_EMAILS is an answer, not an omission", () => {
    expect(readRelayEnv({ ...complete, ALLOWED_EMAILS: "" }).allowedEmails).toEqual([]);
  });
});

describe("parseAllowedEmails", () => {
  test("trims, lowercases, drops blanks and dedupes", () => {
    expect(parseAllowedEmails("A@x.test, ,a@X.test,b@y.test ")).toEqual(["a@x.test", "b@y.test"]);
  });

  test("an empty variable is nobody", () => {
    expect(parseAllowedEmails("")).toEqual([]);
    expect(parseAllowedEmails("  , ")).toEqual([]);
  });
});

describe("redirectUri", () => {
  test("is https, because Google will not register anything else", () => {
    expect(redirectUri("relay.example.test", "/auth/google/callback")).toBe(
      "https://relay.example.test/auth/google/callback",
    );
  });

  test("localhost is the one exemption Google grants", () => {
    expect(redirectUri("localhost:8787", "/cb")).toBe("http://localhost:8787/cb");
    expect(redirectUri("127.0.0.1:8787", "/cb")).toBe("http://127.0.0.1:8787/cb");
  });
});
