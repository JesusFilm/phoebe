// Contract tests for the supervisor's per-tenant env scrub (#61 §1). Isolation
// is structural: each engine child gets a deny-by-default env built from an
// explicit allowlist plus *only* its own tenant's parsed `.env`. Tenant B's
// secrets and the deployment engine-clone credential must be structurally
// absent from tenant A's child env — never spread in, so fail-closed.

import { describe, expect, test } from "vite-plus/test";
import { buildEngineChildEnv, envReconcileDigest, parseDotenv } from "./engine-child-env.ts";
import { GH_APP_CREDENTIAL_PREFIX } from "./github-app.ts";

describe("parseDotenv", () => {
  test("parses KEY=VALUE lines, ignoring blanks and comments", () => {
    const parsed = parseDotenv(
      ["# a comment", "", "GH_TOKEN=ghp_abc", "CURSOR_API_KEY=sk-123", "  # indented", ""].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({ GH_TOKEN: "ghp_abc", CURSOR_API_KEY: "sk-123" });
  });

  test("strips surrounding quotes and an optional `export` prefix", () => {
    const parsed = parseDotenv(['export GH_TOKEN="ghp_x"', "OPENAI_KEY='sk-y'"].join("\n"));
    expect(parsed).toEqual({ GH_TOKEN: "ghp_x", OPENAI_KEY: "sk-y" });
  });

  test("keeps `=` inside values and trims key whitespace", () => {
    expect(parseDotenv("FOO = a=b=c")).toEqual({ FOO: "a=b=c" });
  });

  test("ignores malformed lines with no `=`", () => {
    expect(parseDotenv("not a pair\nGH_TOKEN=ok")).toEqual({ GH_TOKEN: "ok" });
  });
});

describe("buildEngineChildEnv", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/phoebe",
    TZ: "UTC",
    GIT_AUTHOR_NAME: "Phoebe",
    GH_TOKEN: "DEPLOYMENT_CLONE_TOKEN",
    PHOEBE_POLL_INTERVAL_MS: "300000",
    PHOEBE_RECONCILE_INTERVAL_MS: "60000",
    PHOEBE_REPO_SLUG: "someone/else",
    SECRET_ON_SUPERVISOR: "leak-me",
  };

  test("passes PATH/HOME/git-identity and allowlisted deployment knobs through", () => {
    const env = buildEngineChildEnv({ base, tenantEnv: {} });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/phoebe");
    expect(env.GIT_AUTHOR_NAME).toBe("Phoebe");
    expect(env.PHOEBE_POLL_INTERVAL_MS).toBe("300000");
  });

  test("passes the per-work-kind agent knobs through (#300)", () => {
    const env = buildEngineChildEnv({
      base: { ...base, PHOEBE_REVIEWS_MODEL: "claude-haiku-4-5", PHOEBE_ISSUES_EFFORT: "high" },
      tenantEnv: {},
    });
    expect(env.PHOEBE_REVIEWS_MODEL).toBe("claude-haiku-4-5");
    expect(env.PHOEBE_ISSUES_EFFORT).toBe("high");
  });

  test("gives the child its own tenant's secrets", () => {
    const env = buildEngineChildEnv({
      base,
      tenantEnv: { GH_TOKEN: "TENANT_A_TOKEN", CURSOR_API_KEY: "TENANT_A_CURSOR" },
    });
    expect(env.GH_TOKEN).toBe("TENANT_A_TOKEN");
    expect(env.CURSOR_API_KEY).toBe("TENANT_A_CURSOR");
  });

  test("never spreads the supervisor's own process.env — deployment token fail-closed", () => {
    // The #60 engine-clone credential lives in the supervisor's GH_TOKEN. A
    // child that sets no tenant GH_TOKEN must NOT inherit the deployment one.
    const env = buildEngineChildEnv({ base, tenantEnv: { CURSOR_API_KEY: "x" } });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.SECRET_ON_SUPERVISOR).toBeUndefined();
  });

  test("does not leak config-overlay knobs that would corrupt a tenant's own config", () => {
    // PHOEBE_REPO_SLUG (and the other overlay keys) are per-tenant; passing the
    // supervisor's through would override every tenant identically.
    const env = buildEngineChildEnv({ base, tenantEnv: {} });
    expect(env.PHOEBE_REPO_SLUG).toBeUndefined();
  });

  test("tenant A's env never contains tenant B's secrets", () => {
    const a = buildEngineChildEnv({ base, tenantEnv: { GH_TOKEN: "A", CURSOR_API_KEY: "A_KEY" } });
    expect(a.GH_TOKEN).toBe("A");
    expect(Object.values(a)).not.toContain("B_KEY");
  });

  test("omits allowlisted keys that are absent or empty on the base", () => {
    const env = buildEngineChildEnv({ base: { PATH: "/bin", HOME: "" }, tenantEnv: {} });
    expect(env.PATH).toBe("/bin");
    expect("HOME" in env).toBe(false);
  });

  // Named regression guard (#209): the App private key and ID must never reach
  // a child process, even when accidentally allowlisted. The allowlist is the
  // primary barrier; this tripwire makes the claim checkable in CI.
  test("no key matching the App credential prefix (GH_APP_*) survives the child-env builder", () => {
    const baseWithAppKeys = {
      ...base,
      GH_APP_ID: "12345",
      GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
      GH_APP_INSTALLATION_ID: "99999",
    };
    const env = buildEngineChildEnv({ base: baseWithAppKeys, tenantEnv: {} });
    for (const key of Object.keys(env)) {
      expect(
        key.startsWith(GH_APP_CREDENTIAL_PREFIX),
        `${key} must not start with ${GH_APP_CREDENTIAL_PREFIX}`,
      ).toBe(false);
    }
  });

  // Runtime allowlist guard: mintedEnv keys outside the explicit set must never
  // reach the child even if the caller bypasses the MintedCredentials type.
  test("mintedEnv keys outside the allowlist do not reach the child", () => {
    const leakyMintedEnv = {
      GH_TOKEN: "ghs_minted",
      PHOEBE_GH_LOGIN: "bot",
      GIT_AUTHOR_NAME: "bot",
      GIT_AUTHOR_EMAIL: "bot@example.com",
      GIT_COMMITTER_NAME: "bot",
      GIT_COMMITTER_EMAIL: "bot@example.com",
      GH_APP_ID: "secret-app-id",
      GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
    } as Record<string, string>;
    const env = buildEngineChildEnv({ base, mintedEnv: leakyMintedEnv, tenantEnv: {} });
    expect(env.GH_TOKEN).toBe("ghs_minted");
    expect(env.GH_APP_ID).toBeUndefined();
    expect(env.GH_APP_PRIVATE_KEY).toBeUndefined();
  });

  test("mintedEnv is applied after base+knobs and before tenantEnv", () => {
    const mintedToken = "ghs_minted_token";
    const env = buildEngineChildEnv({
      base,
      mintedEnv: {
        GH_TOKEN: mintedToken,
        PHOEBE_GH_LOGIN: "phoebe-app[bot]",
        GIT_AUTHOR_NAME: "phoebe-app[bot]",
        GIT_AUTHOR_EMAIL: "12345+phoebe-app[bot]@users.noreply.github.com",
      },
      tenantEnv: {},
    });
    expect(env.GH_TOKEN).toBe(mintedToken);
    expect(env.PHOEBE_GH_LOGIN).toBe("phoebe-app[bot]");
    expect(env.GIT_AUTHOR_NAME).toBe("phoebe-app[bot]");
  });

  test("an explicit GH_TOKEN in tenantEnv wins over a minted one", () => {
    const env = buildEngineChildEnv({
      base,
      mintedEnv: { GH_TOKEN: "ghs_minted" },
      tenantEnv: { GH_TOKEN: "ghp_tenant_own" },
    });
    expect(env.GH_TOKEN).toBe("ghp_tenant_own");
  });

  // The `gitIdentity` rung (#199): above everything said deployment-wide (the
  // base allowlist and the App-mode bot fallback), below anything said about
  // this tenant specifically (its own `.env`).
  describe("configIdentity", () => {
    const configIdentity = { name: "Widget Bot", email: "widget@acme.dev" };

    test("outranks the deployment-global base identity", () => {
      const env = buildEngineChildEnv({ base, configIdentity, tenantEnv: {} });
      expect(env.GIT_AUTHOR_NAME).toBe("Widget Bot");
      expect(env.GIT_AUTHOR_EMAIL).toBe("widget@acme.dev");
      expect(env.GIT_COMMITTER_NAME).toBe("Widget Bot");
      expect(env.GIT_COMMITTER_EMAIL).toBe("widget@acme.dev");
    });

    test("outranks the App-mode bot fallback", () => {
      const env = buildEngineChildEnv({
        base,
        mintedEnv: {
          GH_TOKEN: "ghs_minted",
          PHOEBE_GH_LOGIN: "phoebe-app[bot]",
          GIT_AUTHOR_NAME: "phoebe-app[bot]",
          GIT_AUTHOR_EMAIL: "12345+phoebe-app[bot]@users.noreply.github.com",
          GIT_COMMITTER_NAME: "phoebe-app[bot]",
          GIT_COMMITTER_EMAIL: "12345+phoebe-app[bot]@users.noreply.github.com",
        },
        configIdentity,
        tenantEnv: {},
      });
      expect(env.GIT_AUTHOR_NAME).toBe("Widget Bot");
      expect(env.GIT_COMMITTER_EMAIL).toBe("widget@acme.dev");
      // Only the identity moves — the minted token is untouched.
      expect(env.GH_TOKEN).toBe("ghs_minted");
      expect(env.PHOEBE_GH_LOGIN).toBe("phoebe-app[bot]");
    });

    test("loses to the tenant's own .env, per var", () => {
      const env = buildEngineChildEnv({
        base,
        configIdentity,
        tenantEnv: { GIT_AUTHOR_NAME: "Operator", GIT_COMMITTER_NAME: "Operator" },
      });
      expect(env.GIT_AUTHOR_NAME).toBe("Operator");
      expect(env.GIT_COMMITTER_NAME).toBe("Operator");
      // The `.env` said nothing about the address, so the repo's declaration stands.
      expect(env.GIT_AUTHOR_EMAIL).toBe("widget@acme.dev");
      expect(env.GIT_COMMITTER_EMAIL).toBe("widget@acme.dev");
    });

    test("no declared identity leaves today's env byte-for-byte", () => {
      const withField = buildEngineChildEnv({ base, configIdentity: null, tenantEnv: {} });
      const without = buildEngineChildEnv({ base, tenantEnv: {} });
      expect(withField).toEqual(without);
      expect(without.GIT_AUTHOR_NAME).toBe("Phoebe");
    });
  });
});

describe("envReconcileDigest", () => {
  test("is stable across a GH_TOKEN rotation (#205)", () => {
    const before = envReconcileDigest("GH_TOKEN=ghp_old\nCURSOR_API_KEY=sk-123\n");
    const after = envReconcileDigest("GH_TOKEN=ghp_new\nCURSOR_API_KEY=sk-123\n");
    expect(after).toBe(before);
  });

  test("moves when any other value changes", () => {
    const before = envReconcileDigest("GH_TOKEN=ghp_x\nCURSOR_API_KEY=sk-123\n");
    const after = envReconcileDigest("GH_TOKEN=ghp_x\nCURSOR_API_KEY=sk-456\n");
    expect(after).not.toBe(before);
  });

  test("moves when a non-token key is added or removed", () => {
    const base = envReconcileDigest("GH_TOKEN=ghp_x\n");
    expect(envReconcileDigest("GH_TOKEN=ghp_x\nNEW_KEY=1\n")).not.toBe(base);
  });

  test("adding or removing GH_TOKEN itself moves the digest", () => {
    // Only the token's *value* is rotation-invisible. Its presence is counted:
    // the lease can deliver a new value but not an absence (null means "keep
    // what you have"), so a removed PAT must relaunch the child — the respawn
    // is what actually stops the deleted token being used.
    expect(envReconcileDigest("GH_TOKEN=ghp_x\nA=1\n")).not.toBe(envReconcileDigest("A=1\n"));
  });

  test("a blank GH_TOKEN= counts as absent, not present", () => {
    // Matches isSet everywhere else: the arm resolver and the lease handler
    // both read a whitespace-only token as "carries none".
    expect(envReconcileDigest("GH_TOKEN=\nA=1\n")).toBe(envReconcileDigest("A=1\n"));
    expect(envReconcileDigest("GH_TOKEN=\nA=1\n")).not.toBe(
      envReconcileDigest("GH_TOKEN=ghp_x\nA=1\n"),
    );
  });

  test("is insensitive to line order and comments (content, not bytes)", () => {
    const a = envReconcileDigest("A=1\nB=2\n");
    const b = envReconcileDigest("# comment\nB=2\nA=1\n");
    expect(a).toBe(b);
  });

  test("distinguishes key/value boundaries unambiguously", () => {
    // A=1B, B=2 must not collide with A=1, BB=2 under any naive join.
    expect(envReconcileDigest("A=1B\nB=2\n")).not.toBe(envReconcileDigest("A=1\nBB=2\n"));
  });
});
