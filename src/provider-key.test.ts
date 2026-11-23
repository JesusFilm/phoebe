import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { CONFIG_DEFAULTS } from "./config-schema.ts";
import {
  assertProviderKeysPresent,
  loginFileProbe,
  providerKeyUses,
  type ProviderKeyConfig,
} from "./provider-key.ts";

const base: ProviderKeyConfig = {
  defaultProvider: "claude",
  defaultModels: CONFIG_DEFAULTS.defaultModels,
  defaultEfforts: {},
  workKinds: {},
  providerEnv: CONFIG_DEFAULTS.providerEnv,
};

const noLogin = () => false;

describe("providerKeyUses", () => {
  test("a set key is set", () => {
    expect(
      providerKeyUses({
        kinds: [{ kind: "issues", config: base }],
        env: { ANTHROPIC_API_KEY: "sk-test" },
        loginFile: noLogin,
      }),
    ).toEqual([{ provider: "claude", key: "ANTHROPIC_API_KEY", kinds: ["issues"], state: "set" }]);
  });

  test("an unset or blank key is missing (#886)", () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: "" }, { ANTHROPIC_API_KEY: "  " }]) {
      const [use] = providerKeyUses({
        kinds: [{ kind: "issues", config: base }],
        env,
        loginFile: noLogin,
      });
      expect(use?.state).toBe("missing");
    }
  });

  test("the key is the one providerEnv names, not the default", () => {
    const config = {
      ...base,
      providerEnv: { ...base.providerEnv, claude: "CLAUDE_CODE_OAUTH_TOKEN" },
    };
    const [use] = providerKeyUses({
      kinds: [{ kind: "issues", config }],
      env: { ANTHROPIC_API_KEY: "sk-test" },
      loginFile: noLogin,
    });
    expect(use).toMatchObject({ key: "CLAUDE_CODE_OAUTH_TOKEN", state: "missing" });
  });

  test("a kind block's provider adds its key, grouped by provider", () => {
    const config = { ...base, workKinds: { reviews: { provider: "codex" as const } } };
    const uses = providerKeyUses({
      kinds: [
        { kind: "issues", config },
        { kind: "reviews", config },
        { kind: "checks", config },
      ],
      env: { ANTHROPIC_API_KEY: "sk-test" },
      loginFile: noLogin,
    });
    expect(uses).toEqual([
      { provider: "claude", key: "ANTHROPIC_API_KEY", kinds: ["issues", "checks"], state: "set" },
      { provider: "codex", key: "OPENAI_KEY", kinds: ["reviews"], state: "missing" },
    ]);
  });

  test("an env flip moves the kind to the provider it will really run", () => {
    const uses = providerKeyUses({
      kinds: [{ kind: "issues", config: base }],
      env: { PHOEBE_AGENT: "cursor", ANTHROPIC_API_KEY: "sk-test" },
      loginFile: noLogin,
    });
    expect(uses).toEqual([
      { provider: "cursor", key: "CURSOR_API_KEY", kinds: ["issues"], state: "missing" },
    ]);
  });

  test("a label stands in for the kind name", () => {
    const [use] = providerKeyUses({
      kinds: [{ kind: "issues", label: "default/issues", config: base }],
      env: {},
      loginFile: noLogin,
    });
    expect(use?.kinds).toEqual(["default/issues"]);
  });

  test("a missing key with a login file signs in from the file", () => {
    const [use] = providerKeyUses({
      kinds: [{ kind: "issues", config: base }],
      env: {},
      loginFile: () => true,
    });
    expect(use?.state).toBe("login-file");
  });

  test("a missing key whose login file nobody can look for is unverifiable", () => {
    const [use] = providerKeyUses({
      kinds: [{ kind: "issues", config: base }],
      env: {},
      loginFile: () => null,
    });
    expect(use?.state).toBe("unverifiable");
  });

  test("the login file is never asked about when the key is set", () => {
    const [use] = providerKeyUses({
      kinds: [{ kind: "issues", config: base }],
      env: { ANTHROPIC_API_KEY: "sk-test" },
      loginFile: () => {
        throw new Error("asked");
      },
    });
    expect(use?.state).toBe("set");
  });
});

describe("loginFileProbe", () => {
  test("finds Claude's credentials file under HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "phoebe-provider-key-"));
    const probe = loginFileProbe(home);
    expect(probe("claude")).toBe(false);
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    expect(probe("claude")).toBe(true);
  });

  test("a provider with no documented login file has none", () => {
    const home = mkdtempSync(join(tmpdir(), "phoebe-provider-key-"));
    expect(loginFileProbe(home)("codex")).toBe(false);
    expect(loginFileProbe(home)("cursor")).toBe(false);
  });

  test("no HOME, no login file", () => {
    expect(loginFileProbe(undefined)("claude")).toBe(false);
  });
});

describe("assertProviderKeysPresent", () => {
  test("passes when every provider can sign in", () => {
    expect(() =>
      assertProviderKeysPresent({
        repoSlug: "acme/widget",
        pipeline: "default",
        kinds: [{ kind: "issues", config: base }],
        env: { ANTHROPIC_API_KEY: "sk-test" },
        loginFile: noLogin,
      }),
    ).not.toThrow();
  });

  test("refuses the boot naming the key, the kinds and the agent's error", () => {
    expect(() =>
      assertProviderKeysPresent({
        repoSlug: "acme/widget",
        pipeline: "default",
        kinds: [
          { kind: "issues", config: base },
          { kind: "reviews", config: base },
        ],
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
        loginFile: noLogin,
      }),
    ).toThrow(
      /acme\/widget pipeline default.*providerEnv\.claude names ANTHROPIC_API_KEY.*issues, reviews.*Not logged in/s,
    );
  });

  test("a login file stands in for the key", () => {
    expect(() =>
      assertProviderKeysPresent({
        repoSlug: "acme/widget",
        pipeline: "default",
        kinds: [{ kind: "issues", config: base }],
        env: {},
        loginFile: () => true,
      }),
    ).not.toThrow();
  });
});
