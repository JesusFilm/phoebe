import { describe, expect, test } from "vite-plus/test";
import { buildInstallCommandEnv, buildPromptShellEnv } from "./shell-env.ts";

const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

describe("buildInstallCommandEnv", () => {
  test("passes the operator's toolchain env through", () => {
    const env = buildInstallCommandEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/phoebe",
        NPM_TOKEN: "registry-secret",
      },
      PROVIDER_KEYS,
    );
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/phoebe",
      NPM_TOKEN: "registry-secret",
    });
  });

  test("drops the engine's own credentials", () => {
    const env = buildInstallCommandEnv(
      {
        PATH: "/usr/bin",
        GH_TOKEN: "minted",
        GH_APP_ID: "12345",
        GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
        ANTHROPIC_API_KEY: "sk-ant",
        OPENAI_API_KEY: "sk-oai",
      },
      PROVIDER_KEYS,
    );
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("GH_APP_ID");
    expect(env).not.toHaveProperty("GH_APP_PRIVATE_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("answers Corepack's download prompt when the operator left it unset", () => {
    const env = buildInstallCommandEnv({ PATH: "/usr/bin" }, PROVIDER_KEYS);
    expect(env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
  });

  test("keeps a value the operator set themselves", () => {
    for (const value of ["1", "0", ""]) {
      const env = buildInstallCommandEnv({ COREPACK_ENABLE_DOWNLOAD_PROMPT: value }, PROVIDER_KEYS);
      expect(env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe(value);
    }
  });

  test("leaves the parent env object untouched", () => {
    const parent = { GH_TOKEN: "minted", PATH: "/usr/bin" };
    buildInstallCommandEnv(parent, PROVIDER_KEYS);
    expect(parent.GH_TOKEN).toBe("minted");
  });
});

describe("buildPromptShellEnv", () => {
  test("keeps GH_TOKEN for the templates' gh calls", () => {
    const env = buildPromptShellEnv({ GH_TOKEN: "minted", PATH: "/usr/bin" }, PROVIDER_KEYS);
    expect(env.GH_TOKEN).toBe("minted");
  });

  test("drops the App credentials and provider keys", () => {
    const env = buildPromptShellEnv(
      {
        GH_APP_ID: "12345",
        GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
        ANTHROPIC_API_KEY: "sk-ant",
        OPENAI_API_KEY: "sk-oai",
        PATH: "/usr/bin",
      },
      PROVIDER_KEYS,
    );
    expect(env).not.toHaveProperty("GH_APP_ID");
    expect(env).not.toHaveProperty("GH_APP_PRIVATE_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("answers Corepack's download prompt when the operator left it unset", () => {
    const env = buildPromptShellEnv({ PATH: "/usr/bin" }, PROVIDER_KEYS);
    expect(env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
  });
});
