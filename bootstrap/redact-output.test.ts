// The redactor (map #690): learned values go wherever they appear, keys that
// do not name a secret teach nothing, the known shapes are caught on sight,
// and a git SHA survives.

import { describe, expect, test } from "vite-plus/test";
import { createRedactor, REDACTED, SECRET_KEY } from "./redact-output.ts";

describe("learned values", () => {
  test("every value under a key that names a secret is replaced wherever it appears", () => {
    const redactor = createRedactor();
    redactor.learnEnv({
      GH_TOKEN: "ghp_abc123def456ghi789jkl012mno345",
      ANTHROPIC_API_KEY: "sk-ant-api03-verysecretvalue",
      PHOEBE_REPO_SLUG: "JesusFilm/phoebe",
      PHOEBE_INSTALL_COMMAND: "pnpm install --frozen-lockfile",
      GH_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0123456789\nabcdefghijklmnop\n-----END RSA PRIVATE KEY-----",
    });
    expect(
      redactor.redact("git push https://x:ghp_abc123def456ghi789jkl012mno345@github.com/a/b"),
    ).toBe(`git push https://x:${REDACTED}@github.com/a/b`);
    expect(redactor.redact("[acme:JesusFilm/phoebe:work] cycle: 1 candidate")).toBe(
      "[acme:JesusFilm/phoebe:work] cycle: 1 candidate",
    );
    expect(redactor.redact("running pnpm install --frozen-lockfile")).toBe(
      "running pnpm install --frozen-lockfile",
    );
    // A PEM value is caught a line at a time, as a child prints it.
    expect(redactor.redact("MIIEpAIBAAKCAQEA0123456789")).toBe(REDACTED);
    expect(redactor.redact("key: sk-ant-api03-verysecretvalue done")).toBe(`key: ${REDACTED} done`);
  });

  test("short values are not learned: they would blank prose", () => {
    const redactor = createRedactor();
    redactor.learnEnv({ GH_TOKEN: "main", SECRET_X: "" });
    expect(redactor.size()).toBe(0);
    expect(redactor.redact("on branch main")).toBe("on branch main");
  });

  test("values can be learned outright, as a store's are", () => {
    const redactor = createRedactor();
    redactor.learn(["store-value-one", undefined, null, "short"]);
    expect(redactor.redact("got store-value-one and short")).toBe(`got ${REDACTED} and short`);
  });

  test("a value containing another is replaced whole", () => {
    const redactor = createRedactor();
    redactor.learn(["abcdefgh", "abcdefghijkl"]);
    expect(redactor.redact("x abcdefghijkl y")).toBe(`x ${REDACTED} y`);
  });

  test("values with regex characters are matched literally", () => {
    const redactor = createRedactor();
    redactor.learn(["a.b+c(d)[e]"]);
    expect(redactor.redact("saw a.b+c(d)[e] here")).toBe(`saw ${REDACTED} here`);
    expect(redactor.redact("saw aXb+c(d)[e] here")).toBe("saw aXb+c(d)[e] here");
  });

  test("the key rule", () => {
    for (const key of [
      "GH_TOKEN",
      "SLACK_SIGNING_SECRET",
      "DB_PASSWORD",
      "GH_APP_PRIVATE_KEY",
      "OPENAI_API_KEY",
      "API_KEY",
      "AWS_CREDENTIALS",
      "KEY",
    ]) {
      expect(SECRET_KEY.test(key), key).toBe(true);
    }
    for (const key of ["PHOEBE_REPO_SLUG", "PATH", "HOME", "GH_APP_ID", "KEYBOARD"]) {
      expect(SECRET_KEY.test(key), key).toBe(false);
    }
  });
});

describe("shapes caught on sight", () => {
  const redactor = createRedactor();

  test("the well-known token prefixes", () => {
    expect(redactor.redact("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 used")).toBe(
      `token ${REDACTED} used`,
    );
    expect(redactor.redact("github_pat_11ABCDEFG0123456789_abcdefghijklmnop")).toBe(REDACTED);
    expect(redactor.redact("sk-ant-api03-AbCdEfGhIjKlMnOpQrSt")).toBe(REDACTED);
    expect(redactor.redact("tskey-auth-kABCDEF1234-xyz")).toBe(REDACTED);
    expect(redactor.redact("xoxb-123456789012-abcdefghij")).toBe(REDACTED);
    expect(redactor.redact("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED);
    expect(
      redactor.redact(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
      ),
    ).toBe(REDACTED);
  });

  test("a bearer and an authorization header keep their scheme", () => {
    expect(redactor.redact("authorization: Bearer abcdefghijklmnop")).toBe(
      `authorization: Bearer ${REDACTED}`,
    );
    expect(redactor.redact("Authorization: Basic dXNlcjpwYXNz")).toBe(
      `Authorization: Basic ${REDACTED}`,
    );
  });

  test("an assignment to a secret-named key keeps the key", () => {
    expect(redactor.redact("GH_TOKEN=abcdefghijkl DEBUG=1")).toBe(`GH_TOKEN=${REDACTED} DEBUG=1`);
    expect(redactor.redact('export DB_PASSWORD="hunter22"')).toBe(`export DB_PASSWORD=${REDACTED}`);
  });

  test("a git SHA, a branch and a tag are left alone", () => {
    const line =
      "[phoebe] boot: engine at 2114a26c5a8f1b0e9d7c6b5a4f3e2d1c0b9a8f7e on main (v0.15.0)";
    expect(redactor.redact(line)).toBe(line);
  });
});
