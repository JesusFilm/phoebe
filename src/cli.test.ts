// Argv parsing contract for the `phoebe` bin: `--config`/`-c` (with space or
// `=`), `--help`/`-h`, and everything else forwarded to `runEngine` for the
// engine to interpret. The full CLI is exercised at the smoke-test level in
// dev; here we just pin the surface.

import { describe, expect, test } from "vite-plus/test";
import { parseCliArgs } from "./cli.ts";

describe("parseCliArgs", () => {
  test("returns empty parsed state for empty argv", () => {
    expect(parseCliArgs([])).toEqual({ configPath: undefined, help: false, forward: [] });
  });

  test("forwards engine flags untouched", () => {
    const parsed = parseCliArgs(["--run-once", "--dry-run"]);
    expect(parsed.forward).toEqual(["--run-once", "--dry-run"]);
    expect(parsed.configPath).toBeUndefined();
  });

  test("accepts --config <path>", () => {
    expect(parseCliArgs(["--config", "cfg.ts"])).toEqual({
      configPath: "cfg.ts",
      help: false,
      forward: [],
    });
  });

  test("accepts -c <path>", () => {
    expect(parseCliArgs(["-c", "cfg.ts"])).toEqual({
      configPath: "cfg.ts",
      help: false,
      forward: [],
    });
  });

  test("accepts --config=<path>", () => {
    expect(parseCliArgs(["--config=cfg.ts"])).toEqual({
      configPath: "cfg.ts",
      help: false,
      forward: [],
    });
  });

  test("throws when --config lacks a following argument", () => {
    expect(() => parseCliArgs(["--config"])).toThrow(/requires a path/);
    expect(() => parseCliArgs(["-c"])).toThrow(/requires a path/);
  });

  test("--help and -h set help without swallowing other args", () => {
    expect(parseCliArgs(["--help", "--run-once"])).toEqual({
      configPath: undefined,
      help: true,
      forward: ["--run-once"],
    });
    expect(parseCliArgs(["-h"]).help).toBe(true);
  });

  test("mixes --config with forwarded engine flags", () => {
    expect(parseCliArgs(["--config", "cfg.ts", "--run-once", "--dry-run"])).toEqual({
      configPath: "cfg.ts",
      help: false,
      forward: ["--run-once", "--dry-run"],
    });
  });
});
