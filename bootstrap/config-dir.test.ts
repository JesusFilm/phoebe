// Tests for the bootstrapper-only `configDir` reader (#98): default when
// absent, accept a relative asset subdir, reject absolute / `..` / empty.

import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_TENANT_CONFIG_DIR, readConfigDir } from "./config-dir.ts";

describe("readConfigDir", () => {
  test("absent field ⇒ default '.' (co-located)", () => {
    expect(readConfigDir({})).toBe(DEFAULT_TENANT_CONFIG_DIR);
    expect(readConfigDir({ repoSlug: "acme/widget" })).toBe(".");
  });

  test("accepts a relative asset subdir", () => {
    expect(readConfigDir({ configDir: ".phoebe" })).toBe(".phoebe");
    expect(readConfigDir({ configDir: "deploy/phoebe" })).toBe("deploy/phoebe");
    expect(readConfigDir({ configDir: "." })).toBe(".");
  });

  test("rejects an absolute path", () => {
    expect(() => readConfigDir({ configDir: "/etc/phoebe" })).toThrow(/configDir/);
  });

  test("rejects a `..` escape", () => {
    expect(() => readConfigDir({ configDir: "../sibling" })).toThrow(/\.\./);
    expect(() => readConfigDir({ configDir: "a/../../b" })).toThrow(/\.\./);
  });

  test("rejects empty / non-string", () => {
    expect(() => readConfigDir({ configDir: "" })).toThrow(/configDir/);
    expect(() => readConfigDir({ configDir: "   " })).toThrow(/configDir/);
    expect(() => readConfigDir({ configDir: 42 })).toThrow(/configDir/);
  });
});
