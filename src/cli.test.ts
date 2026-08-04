// Argv parsing contract for the `phoebe` bin: `--config`/`-c` (with space or
// `=`), `--help`/`-h`, and everything else forwarded to `runEngine` for the
// engine to interpret. Init flags (`--workspace` / `--tenant`) are mutually
// exclusive profile selectors. The full CLI is exercised at the smoke-test
// level in dev; here we just pin the surface.

import { describe, expect, test } from "vite-plus/test";
import { parseCliArgs, parseInitArgs } from "./cli.ts";

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

describe("parseInitArgs", () => {
  test("defaults to current directory and flat profile when no args given", () => {
    expect(parseInitArgs([])).toEqual({ targetDir: ".", help: false, profile: "flat" });
  });

  test("accepts a positional target directory (flat)", () => {
    expect(parseInitArgs(["./my-agent"])).toEqual({
      targetDir: "./my-agent",
      help: false,
      profile: "flat",
    });
  });

  test("accepts --workspace with an optional directory", () => {
    expect(parseInitArgs(["--workspace"])).toEqual({
      targetDir: ".",
      help: false,
      profile: "workspace",
    });
    expect(parseInitArgs(["--workspace", "./ws"])).toEqual({
      targetDir: "./ws",
      help: false,
      profile: "workspace",
    });
    expect(parseInitArgs(["./ws", "--workspace"])).toEqual({
      targetDir: "./ws",
      help: false,
      profile: "workspace",
    });
  });

  test("accepts --tenant with an optional directory", () => {
    expect(parseInitArgs(["--tenant", "./child"])).toEqual({
      targetDir: "./child",
      help: false,
      profile: "tenant",
    });
  });

  test("--workspace and --tenant are mutually exclusive", () => {
    expect(() => parseInitArgs(["--workspace", "--tenant"])).toThrow(/mutually exclusive/);
    expect(() => parseInitArgs(["--tenant", "--workspace", "./x"])).toThrow(/mutually exclusive/);
  });

  test("--help / -h set help without requiring a directory", () => {
    expect(parseInitArgs(["--help"])).toEqual({ targetDir: ".", help: true, profile: "flat" });
    expect(parseInitArgs(["-h"]).help).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(() => parseInitArgs(["--forcee"])).toThrow(/Unknown flag/);
  });

  test("rejects a second positional argument", () => {
    expect(() => parseInitArgs(["a", "b"])).toThrow(/at most one target directory/);
  });
});
