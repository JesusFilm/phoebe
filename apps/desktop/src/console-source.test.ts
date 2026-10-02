import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { CONSOLE_DEV_PORT, CONSOLE_DEV_URL, consoleSource } from "./console-source.ts";
import { CONSOLE_URL } from "./console-scheme.ts";

describe("the window's renderer", () => {
  test("is the bundle on disk unless --dev was passed", () => {
    expect(consoleSource([])).toBe(CONSOLE_URL);
    expect(consoleSource(["/usr/bin/electron", "."])).toBe(CONSOLE_URL);
  });

  test("is the console's dev server when it was", () => {
    expect(consoleSource(["/usr/bin/electron", ".", "--dev"])).toBe(CONSOLE_DEV_URL);
  });

  test("points at the port the console's dev server is pinned to", () => {
    // Two packages, one number. The console's vite config is the side that binds
    // it, so that file is what this reads rather than a copy of the number.
    const config = readFileSync(new URL("../../console/vite.config.ts", import.meta.url), "utf8");

    expect(config).toContain(`port: ${CONSOLE_DEV_PORT}`);
    expect(config).toContain("strictPort: true");
  });
});
