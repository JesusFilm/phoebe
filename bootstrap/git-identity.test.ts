// Tests for the bootstrapper-only `gitIdentity` reader (#199): absent ⇒ null,
// both halves required, email shape checked, and the two env shapers — the
// four-var overlay the fleet layers between the deployment base and a tenant's
// `.env`, and the gap-fill solo applies to the ambient container env.

import { describe, expect, test } from "vite-plus/test";
import {
  fillGitIdentityGaps,
  gitIdentityEnv,
  readGitIdentity,
  validateGitIdentityField,
} from "./git-identity.ts";

describe("readGitIdentity", () => {
  test("absent field ⇒ null (nothing declared)", () => {
    expect(readGitIdentity({})).toBeNull();
    expect(readGitIdentity({ repoSlug: "acme/widget" })).toBeNull();
  });

  test("reads a declared name + email, trimmed", () => {
    expect(readGitIdentity({ gitIdentity: { name: "Phoebe", email: "phoebe@acme.dev" } })).toEqual({
      name: "Phoebe",
      email: "phoebe@acme.dev",
    });
    expect(
      readGitIdentity({ gitIdentity: { name: "  Phoebe  ", email: " phoebe@acme.dev " } }),
    ).toEqual({ name: "Phoebe", email: "phoebe@acme.dev" });
  });

  test("rejects a half-declared identity — a name without the exact email is the trap", () => {
    expect(() => readGitIdentity({ gitIdentity: { name: "Phoebe" } })).toThrow(/email/);
    expect(() => readGitIdentity({ gitIdentity: { email: "phoebe@acme.dev" } })).toThrow(/name/);
    expect(() => readGitIdentity({ gitIdentity: { name: "Phoebe", email: "" } })).toThrow(/email/);
    expect(() => readGitIdentity({ gitIdentity: { name: "   ", email: "a@b.dev" } })).toThrow(
      /name/,
    );
  });

  test("rejects an email GitHub could not link to an account", () => {
    expect(() => readGitIdentity({ gitIdentity: { name: "P", email: "not-an-email" } })).toThrow(
      /email/,
    );
    expect(() => readGitIdentity({ gitIdentity: { name: "P", email: "a b@acme.dev" } })).toThrow(
      /email/,
    );
    expect(() => readGitIdentity({ gitIdentity: { name: "P", email: "@acme.dev" } })).toThrow(
      /email/,
    );
    expect(() => readGitIdentity({ gitIdentity: { name: "P", email: "phoebe@" } })).toThrow(
      /email/,
    );
  });

  test("rejects a non-object field", () => {
    expect(() => readGitIdentity({ gitIdentity: "Phoebe <phoebe@acme.dev>" })).toThrow(
      /gitIdentity/,
    );
    expect(() => readGitIdentity({ gitIdentity: ["Phoebe", "phoebe@acme.dev"] })).toThrow(
      /gitIdentity/,
    );
    expect(() => readGitIdentity({ gitIdentity: null })).toThrow(/gitIdentity/);
    expect(() => readGitIdentity({ gitIdentity: { name: 1, email: 2 } })).toThrow(/gitIdentity/);
  });

  test("validateGitIdentityField is the same check, for the engine's config validator", () => {
    expect(() =>
      validateGitIdentityField({ name: "Phoebe", email: "phoebe@acme.dev" }),
    ).not.toThrow();
    expect(() => validateGitIdentityField({ name: "Phoebe", email: "nope" })).toThrow(/email/);
  });
});

describe("gitIdentityEnv", () => {
  test("a declared identity is all four vars — author and committer alike", () => {
    expect(gitIdentityEnv({ name: "Phoebe", email: "phoebe@acme.dev" })).toEqual({
      GIT_AUTHOR_NAME: "Phoebe",
      GIT_AUTHOR_EMAIL: "phoebe@acme.dev",
      GIT_COMMITTER_NAME: "Phoebe",
      GIT_COMMITTER_EMAIL: "phoebe@acme.dev",
    });
  });

  test("no identity ⇒ no vars (the layer is absent, not empty)", () => {
    expect(gitIdentityEnv(null)).toEqual({});
    expect(gitIdentityEnv(undefined)).toEqual({});
  });
});

describe("fillGitIdentityGaps", () => {
  const identity = { name: "Phoebe", email: "phoebe@acme.dev" };

  test("fills only the vars the ambient env leaves unset", () => {
    const filled = fillGitIdentityGaps(
      { PATH: "/usr/bin", GIT_AUTHOR_NAME: "Operator", GIT_COMMITTER_NAME: "Operator" },
      identity,
    );
    // The env said who; it wins. It said nothing about the address; config fills it.
    expect(filled.GIT_AUTHOR_NAME).toBe("Operator");
    expect(filled.GIT_COMMITTER_NAME).toBe("Operator");
    expect(filled.GIT_AUTHOR_EMAIL).toBe("phoebe@acme.dev");
    expect(filled.GIT_COMMITTER_EMAIL).toBe("phoebe@acme.dev");
    expect(filled.PATH).toBe("/usr/bin");
  });

  test("an empty-string var counts as unset", () => {
    const filled = fillGitIdentityGaps({ GIT_AUTHOR_NAME: "" }, identity);
    expect(filled.GIT_AUTHOR_NAME).toBe("Phoebe");
  });

  test("no identity ⇒ the env is passed through untouched", () => {
    const base = { PATH: "/usr/bin", GIT_AUTHOR_NAME: "Operator" };
    expect(fillGitIdentityGaps(base, null)).toEqual(base);
  });

  test("does not mutate the env it was given", () => {
    const base: Record<string, string | undefined> = { PATH: "/usr/bin" };
    fillGitIdentityGaps(base, identity);
    expect(base.GIT_AUTHOR_NAME).toBeUndefined();
  });
});
