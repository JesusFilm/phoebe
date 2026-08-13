import { describe, expect, test } from "vite-plus/test";
import { buildShellCommandEnv } from "./shell-env.ts";

describe("buildShellCommandEnv", () => {
  test("passes the parent env through untouched", () => {
    const env = buildShellCommandEnv({
      PATH: "/usr/bin",
      HOME: "/home/phoebe",
      NPM_TOKEN: "registry-secret",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/phoebe",
      NPM_TOKEN: "registry-secret",
    });
  });

  test("answers Corepack's download prompt when the operator left it unset", () => {
    const env = buildShellCommandEnv({ PATH: "/usr/bin" });
    expect(env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
  });

  test("keeps a value the operator set themselves", () => {
    for (const value of ["1", "0", ""]) {
      const env = buildShellCommandEnv({ COREPACK_ENABLE_DOWNLOAD_PROMPT: value });
      expect(env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe(value);
    }
  });
});
