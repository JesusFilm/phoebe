// Argv parsing contract for the `phoebe` bin: `--config`/`-c` (with space or
// `=`), `--help`/`-h`, and everything else forwarded to `runEngine` for the
// engine to interpret. The full CLI is exercised at the smoke-test level in
// dev; here we just pin the surface.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  BOOTSTRAP_RESOLVED_CONFIG_ENV,
  loadEngineConfiguration,
  parseCliArgs,
  parseConfigResolveArgs,
  parseInitArgs,
  runConfigResolve,
} from "./cli.ts";

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
  test("defaults to current directory when no positional given", () => {
    expect(parseInitArgs([])).toEqual({ targetDir: ".", help: false });
  });

  test("accepts a positional target directory", () => {
    expect(parseInitArgs(["./my-agent"])).toEqual({ targetDir: "./my-agent", help: false });
  });

  test("--help / -h set help without requiring a directory", () => {
    expect(parseInitArgs(["--help"])).toEqual({ targetDir: ".", help: true });
    expect(parseInitArgs(["-h"]).help).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(() => parseInitArgs(["--forcee"])).toThrow(/Unknown flag/);
  });

  test("rejects a second positional argument", () => {
    expect(() => parseInitArgs(["a", "b"])).toThrow(/at most one target directory/);
  });
});

describe("phoebe config resolve --json", () => {
  test("parses the required JSON form with an optional repository config path", () => {
    expect(parseConfigResolveArgs(["resolve", "--json", "--config", "other.ts"])).toEqual({
      configPath: "other.ts",
    });
    expect(parseConfigResolveArgs(["resolve", "--json"])).toEqual({
      configPath: undefined,
    });
  });

  test("rejects missing --json, unknown subcommands, and unrelated flags", () => {
    expect(() => parseConfigResolveArgs(["resolve"])).toThrow(/requires --json/);
    expect(() => parseConfigResolveArgs(["show", "--json"])).toThrow(/config resolve/);
    expect(() => parseConfigResolveArgs(["resolve", "--json", "--dry-run"])).toThrow(
      /Unknown flag/,
    );
  });

  test("emits the shared canonical resolution without starting the engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "phoebe-config-resolve-cli-"));
    try {
      writeFileSync(
        join(root, "phoebe.config.ts"),
        `export default {
          repoSlug: "acme/widget",
          repoUrl: "https://github.com/acme/widget.git",
          installCommand: "npm ci",
          checkCommand: "npm run check",
          testCommand: "npm test",
          readyLabel: "repository-ready"
        };\n`,
      );
      const basePath = join(root, "base.json");
      writeFileSync(
        basePath,
        `${JSON.stringify({
          schemaVersion: 1,
          config: {
            branchPrefix: "managed/",
            engine: { source: "github", ref: "stable", repo: "acme/phoebe" },
          },
        })}\n`,
      );

      const output = await runConfigResolve(["resolve", "--json"], {
        cwd: root,
        env: { PHOEBE_BASE_CONFIG: basePath, PHOEBE_READY_LABEL: "environment-ready" },
      });
      const parsed = JSON.parse(output);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.config.branchPrefix).toBe("managed/");
      expect(parsed.config.readyLabel).toBe("environment-ready");
      expect(parsed.config.engine).toEqual({
        source: "github",
        repo: "acme/phoebe",
        ref: "stable",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses boot's resolved snapshot if authored files change before the engine reads them", async () => {
    const root = mkdtempSync(join(tmpdir(), "phoebe-config-snapshot-cli-"));
    try {
      const repositoryPath = join(root, "phoebe.config.ts");
      writeFileSync(
        repositoryPath,
        `export default {
          repoSlug: "acme/widget",
          repoUrl: "https://github.com/acme/widget.git",
          installCommand: "npm ci",
          checkCommand: "npm run check",
          testCommand: "npm test"
        };\n`,
      );
      const basePath = join(root, "base.json");
      writeFileSync(
        basePath,
        `${JSON.stringify({
          schemaVersion: 1,
          config: {
            branchPrefix: "before/",
            engine: { source: "github", ref: "before" },
          },
        })}\n`,
      );
      const env = { PHOEBE_BASE_CONFIG: basePath };
      const snapshot = await runConfigResolve(["resolve", "--json"], { cwd: root, env });

      writeFileSync(
        basePath,
        `${JSON.stringify({
          schemaVersion: 1,
          config: {
            branchPrefix: "after/",
            engine: { source: "github", ref: "after" },
          },
        })}\n`,
      );

      const resolved = await loadEngineConfiguration(repositoryPath, {
        ...env,
        [BOOTSTRAP_RESOLVED_CONFIG_ENV]: snapshot,
      });
      expect(resolved.config.branchPrefix).toBe("before/");
      expect(resolved.engine).toMatchObject({ source: "github", ref: "before" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
