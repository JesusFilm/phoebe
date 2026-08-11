// Argv parsing contract for the `phoebe` bin: `--config`/`-c` (with space or
// `=`), `--help`/`-h`, and everything else forwarded to `runEngine` for the
// engine to interpret. Init flags (`--workspace` / `--tenant`) are mutually
// exclusive profile selectors. The full CLI is exercised at the smoke-test
// level in dev; here we just pin the surface.

import { describe, expect, test } from "vite-plus/test";
import { assertNotWorkspaceRoot, parseCliArgs, parseInitArgs } from "./cli.ts";

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

  test("rejects an unknown flag instead of forwarding it into the void", () => {
    // The engine reads its flags with `argv.includes(...)`, so a forwarded
    // unknown flag is silently dropped — a typo would run the opposite of what
    // was asked. `--repo` is the case that motivated this: it selected a nested
    // tenant's config until 0.4.0 and must not survive as a no-op alias (#169).
    expect(() => parseCliArgs(["--repo", "acme/widget"])).toThrow(/Unknown flag `--repo`/);
    expect(() => parseCliArgs(["--repo=acme/widget"])).toThrow(/Unknown flag/);
    expect(() => parseCliArgs(["--dry-runn"])).toThrow(/Unknown flag/);
  });

  test("rejects a bare word as an unknown command instead of forwarding it", () => {
    // The newer-verb-on-older-CLI case: a deployment on 0.4.x running
    // `phoebe upgrade` saw the verb forwarded to the engine-run path, which
    // died deep in config validation with a "missing required field(s)" error.
    // The parser now names the real problem and points at the self-upgrade
    // path.
    expect(() => parseCliArgs(["upgrayedd"])).toThrow(/Unknown command `upgrayedd`/);
    expect(() => parseCliArgs(["upgrayedd"])).toThrow(/pnpm dlx phoebe-agent@latest upgrade/);
    expect(() => parseCliArgs(["--run-once", "extra"])).toThrow(/Unknown command `extra`/);
  });
});

describe("assertNotWorkspaceRoot", () => {
  test("lets a config without a workspace block through", () => {
    expect(() => assertNotWorkspaceRoot({}, "/tenant/phoebe.config.ts")).not.toThrow();
  });

  test("refuses a workspace-root config with a pointer, not the five-field error", () => {
    const call = () =>
      assertNotWorkspaceRoot({ workspace: { depth: 1 } }, "/root/phoebe.config.ts");
    expect(call).toThrow(/workspace root/);
    expect(call).toThrow(/phoebe boot/);
    expect(call).toThrow(String.raw`/root/phoebe.config.ts`);
  });
});

describe("parseInitArgs", () => {
  test("defaults to current directory and solo profile when no args given", () => {
    expect(parseInitArgs([])).toEqual({
      targetDir: ".",
      help: false,
      profile: "solo",
      withPrompts: false,
    });
  });

  test("accepts a positional target directory (solo)", () => {
    expect(parseInitArgs(["./my-agent"])).toEqual({
      targetDir: "./my-agent",
      help: false,
      profile: "solo",
      withPrompts: false,
    });
  });

  test("accepts --workspace with an optional directory", () => {
    expect(parseInitArgs(["--workspace"])).toEqual({
      targetDir: ".",
      help: false,
      profile: "workspace",
      withPrompts: false,
    });
    expect(parseInitArgs(["--workspace", "./ws"])).toEqual({
      targetDir: "./ws",
      help: false,
      profile: "workspace",
      withPrompts: false,
    });
    expect(parseInitArgs(["./ws", "--workspace"])).toEqual({
      targetDir: "./ws",
      help: false,
      profile: "workspace",
      withPrompts: false,
    });
  });

  test("accepts --tenant with an optional directory", () => {
    expect(parseInitArgs(["--tenant", "./child"])).toEqual({
      targetDir: "./child",
      help: false,
      profile: "tenant",
      withPrompts: false,
    });
    expect(parseInitArgs(["--tenant", "./child", "--root", "../ws"])).toEqual({
      targetDir: "./child",
      help: false,
      profile: "tenant",
      withPrompts: false,
      rootDir: "../ws",
    });
    expect(parseInitArgs(["--tenant", "--root=../ws"])).toEqual({
      targetDir: ".",
      help: false,
      profile: "tenant",
      withPrompts: false,
      rootDir: "../ws",
    });
  });

  test("accepts tenant overrides --slug / --url / --with-prompts", () => {
    expect(
      parseInitArgs([
        "--tenant",
        "./child",
        "--slug",
        "acme/widget",
        "--url",
        "git@example.com:acme/widget.git",
        "--with-prompts",
      ]),
    ).toEqual({
      targetDir: "./child",
      help: false,
      profile: "tenant",
      repoSlug: "acme/widget",
      repoUrl: "git@example.com:acme/widget.git",
      withPrompts: true,
    });
    expect(parseInitArgs(["--tenant", "--slug=acme/x", "--url=https://e/x.git"])).toEqual({
      targetDir: ".",
      help: false,
      profile: "tenant",
      repoSlug: "acme/x",
      repoUrl: "https://e/x.git",
      withPrompts: false,
    });
  });

  test("rejects tenant-only flags without --tenant", () => {
    expect(() => parseInitArgs(["--slug", "a/b"])).toThrow(/only valid with/);
    expect(() => parseInitArgs(["--workspace", "--with-prompts"])).toThrow(/only valid with/);
    expect(() => parseInitArgs(["--root", "."])).toThrow(/only valid with/);
  });

  test("--solo names the default: identical to a bare `phoebe init`", () => {
    expect(parseInitArgs(["--solo"])).toEqual(parseInitArgs([]));
    expect(parseInitArgs(["--solo", "./my-agent"])).toEqual(parseInitArgs(["./my-agent"]));
  });

  test("--solo, --workspace, and --tenant are mutually exclusive", () => {
    expect(() => parseInitArgs(["--workspace", "--tenant"])).toThrow(/mutually exclusive/);
    expect(() => parseInitArgs(["--tenant", "--workspace", "./x"])).toThrow(/mutually exclusive/);
    expect(() => parseInitArgs(["--solo", "--workspace"])).toThrow(/mutually exclusive/);
    expect(() => parseInitArgs(["--tenant", "--solo"])).toThrow(/mutually exclusive/);
  });

  test("--help / -h set help without requiring a directory", () => {
    expect(parseInitArgs(["--help"])).toEqual({
      targetDir: ".",
      help: true,
      profile: "solo",
      withPrompts: false,
    });
    expect(parseInitArgs(["-h"]).help).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(() => parseInitArgs(["--forcee"])).toThrow(/Unknown flag/);
  });

  test("rejects a second positional argument", () => {
    expect(() => parseInitArgs(["a", "b"])).toThrow(/at most one target directory/);
  });
});
