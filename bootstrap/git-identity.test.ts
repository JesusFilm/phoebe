// Tests for the bootstrapper-only `gitIdentity` reader (#199): absent ⇒ null,
// both halves required, email shape checked, and the two env shapers — the
// four-var overlay the fleet layers between the deployment base and a tenant's
// `.env`, and the gap-fill solo applies to the ambient container env.

import { describe, expect, test } from "vite-plus/test";
import {
  gitIdentityEnv,
  readGitIdentity,
  soloIdentityEnv,
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

describe("soloIdentityEnv", () => {
  const identity = { name: "Phoebe", email: "phoebe@acme.dev" };

  test("fills only the vars the ambient env leaves unset", () => {
    const { env } = soloIdentityEnv(
      { PATH: "/usr/bin", GIT_AUTHOR_NAME: "Operator", GIT_COMMITTER_NAME: "Operator" },
      identity,
    );
    // The env said who; it wins. It said nothing about the address; config fills it.
    expect(env?.GIT_AUTHOR_NAME).toBe("Operator");
    expect(env?.GIT_COMMITTER_NAME).toBe("Operator");
    expect(env?.GIT_AUTHOR_EMAIL).toBe("phoebe@acme.dev");
    expect(env?.GIT_COMMITTER_EMAIL).toBe("phoebe@acme.dev");
    expect(env?.PATH).toBe("/usr/bin");
  });

  test("reports the vars the env overrode, so boot can say so", () => {
    const { overridden } = soloIdentityEnv(
      { GIT_AUTHOR_NAME: "Operator", GIT_COMMITTER_NAME: "Operator" },
      identity,
    );
    expect(overridden).toEqual(["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]);
  });

  test("an env that agrees with the declaration is not an override", () => {
    const { overridden } = soloIdentityEnv(
      { GIT_AUTHOR_NAME: "Phoebe", GIT_AUTHOR_EMAIL: "phoebe@acme.dev" },
      identity,
    );
    expect(overridden).toEqual([]);
  });

  test("an empty-string var counts as unset", () => {
    const { env, overridden } = soloIdentityEnv({ GIT_AUTHOR_NAME: "" }, identity);
    expect(env?.GIT_AUTHOR_NAME).toBe("Phoebe");
    expect(overridden).toEqual([]);
  });

  test("no identity ⇒ no env at all — the child inherits, as it always has", () => {
    expect(soloIdentityEnv({ PATH: "/usr/bin" }, null)).toEqual({ env: null, overridden: [] });
    expect(soloIdentityEnv({ PATH: "/usr/bin" }, undefined).env).toBeNull();
  });

  test("does not mutate the env it was given", () => {
    const base: Record<string, string | undefined> = { PATH: "/usr/bin" };
    soloIdentityEnv(base, identity);
    expect(base.GIT_AUTHOR_NAME).toBeUndefined();
  });
});
