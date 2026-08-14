// `phoebe upgrade` contracts: argv parsing, release-tag discovery over
// ls-remote output, ref classification, the strict-literal config rewrite (the
// risky half — every refusal path is pinned here), the --check verdict, and the
// migration ordering guarantee (migrations run from the target checkout before
// engine.ref is written).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  buildCheckReport,
  classifyRef,
  compareVersions,
  engineEditInstruction,
  latestReleaseTag,
  parseUpgradeArgs,
  redactToken,
  releaseVersion,
  rewriteEngineRef,
  upgradeEngineHalf,
} from "./upgrade.ts";

describe("redactToken", () => {
  test("strips every occurrence of the token, tolerating an absent one", () => {
    const message = "fatal: could not read from https://x-access-token:ghs_secret@github.com";
    expect(redactToken(message, "ghs_secret")).toBe(
      "fatal: could not read from https://x-access-token:***@github.com",
    );
    expect(redactToken(message, undefined)).toBe(message);
    expect(redactToken(message, "")).toBe(message);
  });
});

describe("parseUpgradeArgs", () => {
  test("bare invocation leaves ref and target undefined (prompt territory)", () => {
    expect(parseUpgradeArgs([])).toEqual({
      ref: undefined,
      target: undefined,
      check: false,
      json: false,
      help: false,
      configPath: undefined,
    });
  });

  test("positional ref and a target flag", () => {
    const parsed = parseUpgradeArgs(["v0.4.0", "--both"]);
    expect(parsed.ref).toBe("v0.4.0");
    expect(parsed.target).toBe("both");
  });

  test("target flags are mutually exclusive", () => {
    expect(() => parseUpgradeArgs(["--engine", "--cli"])).toThrow(/mutually exclusive/);
  });

  test("at most one positional ref", () => {
    expect(() => parseUpgradeArgs(["v0.4.0", "v0.5.0"])).toThrow(/at most one ref/);
  });

  test("--check is read-only: no ref, no target, --json allowed", () => {
    expect(parseUpgradeArgs(["--check", "--json"]).check).toBe(true);
    expect(() => parseUpgradeArgs(["--check", "v0.4.0"])).toThrow(/read-only/);
    expect(() => parseUpgradeArgs(["--check", "--engine"])).toThrow(/read-only/);
  });

  test("--json without --check is rejected", () => {
    expect(() => parseUpgradeArgs(["--json"])).toThrow(/only valid with `--check`/);
  });

  test("--config in both spellings", () => {
    expect(parseUpgradeArgs(["--config", "cfg.ts"]).configPath).toBe("cfg.ts");
    expect(parseUpgradeArgs(["--config=cfg.ts"]).configPath).toBe("cfg.ts");
    expect(() => parseUpgradeArgs(["--config"])).toThrow(/requires a path/);
  });

  test("unknown flags are rejected loudly", () => {
    expect(() => parseUpgradeArgs(["--bothh"])).toThrow(/Unknown flag/);
  });
});

describe("release tags", () => {
  test("releaseVersion parses vX.Y.Z and rejects prereleases", () => {
    expect(releaseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(releaseVersion("v0.4.0-rc.1")).toBeNull();
    expect(releaseVersion("main")).toBeNull();
    expect(releaseVersion("1.2.3")).toBeNull();
  });

  test("compareVersions orders numerically, not lexically", () => {
    expect(compareVersions([0, 10, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([1, 0, 0], [1, 0, 0])).toBe(0);
  });

  test("latestReleaseTag picks the highest release, skipping prereleases and peeled rows", () => {
    const output = [
      "aaa\trefs/tags/v0.3.1",
      "bbb\trefs/tags/v0.3.2",
      "ccc\trefs/tags/v0.3.2^{}",
      "ddd\trefs/tags/v0.4.0-rc.1",
      "eee\trefs/heads/main",
      "fff\trefs/tags/not-a-version",
    ].join("\n");
    expect(latestReleaseTag(output)).toBe("v0.3.2");
  });

  test("latestReleaseTag is null when the remote has no release tags", () => {
    expect(latestReleaseTag("aaa\trefs/heads/main")).toBeNull();
  });
});

describe("classifyRef", () => {
  test("release tag / sha / everything else", () => {
    expect(classifyRef("v1.0.0")).toBe("release-tag");
    expect(classifyRef("a".repeat(40))).toBe("sha");
    expect(classifyRef("main")).toBe("other");
    expect(classifyRef("v0.4.0-rc.1")).toBe("other");
  });
});

describe("rewriteEngineRef", () => {
  const scaffold = `import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  engine: { source: "github", ref: "v0.3.1" },
};

export default config;
`;

  test("rewrites a literal ref in place, reporting the previous one", () => {
    const result = rewriteEngineRef(scaffold, "v0.3.2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previousRef).toBe("v0.3.1");
    expect(result.content).toContain('engine: { source: "github", ref: "v0.3.2" }');
    expect(result.content).not.toContain("v0.3.1");
    // Nothing else moved.
    expect(result.content.replace("v0.3.2", "v0.3.1")).toBe(scaffold);
  });

  test("preserves single-quote style", () => {
    const single = scaffold.replace(`ref: "v0.3.1"`, `ref: 'v0.3.1'`);
    const result = rewriteEngineRef(single, "v0.3.2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`ref: 'v0.3.2'`);
  });

  test("inserts a ref into an engine block that has none", () => {
    const noRef = scaffold.replace(`, ref: "v0.3.1"`, "");
    const result = rewriteEngineRef(noRef, "v0.4.0");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previousRef).toBeNull();
    expect(result.content).toContain('engine: { source: "github", ref: "v0.4.0" }');
  });

  test("inserts a whole engine block into a scaffold-shaped config without one", () => {
    const noEngine = scaffold.replace(`  engine: { source: "github", ref: "v0.3.1" },\n`, "");
    const result = rewriteEngineRef(noEngine, "v0.4.0");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('  engine: { source: "github", ref: "v0.4.0" },\n};');
  });

  test("refuses a local source", () => {
    const local = scaffold.replace(`{ source: "github", ref: "v0.3.1" }`, `{ source: "local" }`);
    const result = rewriteEngineRef(local, "v0.4.0");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/local/);
  });

  test("refuses a computed ref rather than guessing", () => {
    const computed = scaffold.replace(`ref: "v0.3.1"`, "ref: process.env.REF!");
    const result = rewriteEngineRef(computed, "v0.4.0");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not a plain string literal/);
  });

  test("refuses two engine blocks", () => {
    const doubled = scaffold + `\nconst other = { engine: { source: "github", ref: "main" } };\n`;
    expect(rewriteEngineRef(doubled, "v0.4.0").ok).toBe(false);
  });

  test("refuses an ambiguous file with no insertable config object", () => {
    const weird = `export default makeConfig();\n`;
    const result = rewriteEngineRef(weird, "v0.4.0");
    expect(result.ok).toBe(false);
  });

  test("the refusal instruction is the exact one-line edit", () => {
    expect(engineEditInstruction("v0.4.0")).toBe('engine: { source: "github", ref: "v0.4.0" },');
  });
});

describe("buildCheckReport", () => {
  test("pinned behind the latest release is not ok", () => {
    const report = buildCheckReport({
      source: { source: "github", ref: "v0.3.1", repo: "JesusFilm/phoebe" },
      latestTag: "v0.3.2",
      installedCli: "0.3.2",
      latestCli: "0.3.2",
    });
    expect(report.engine.behind).toBe(true);
    expect(report.cli.behind).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("a tracking branch is never 'behind' — it auto-upgrades", () => {
    const report = buildCheckReport({
      source: { source: "github", ref: "main", repo: "JesusFilm/phoebe" },
      latestTag: "v0.3.2",
      installedCli: null,
      latestCli: null,
    });
    expect(report.engine.tracking).toBe(true);
    expect(report.engine.behind).toBeNull();
    expect(report.ok).toBe(true);
  });

  test("an installed CLI newer than the registry's latest is not 'behind'", () => {
    const report = buildCheckReport({
      source: { source: "github", ref: "v0.4.0", repo: "JesusFilm/phoebe" },
      latestTag: "v0.4.0",
      installedCli: "0.5.0-rc.1",
      latestCli: "0.4.0",
    });
    // Non-X.Y.Z installed version falls back to inequality…
    expect(report.cli.behind).toBe(true);
    const ahead = buildCheckReport({
      source: { source: "github", ref: "v0.4.0", repo: "JesusFilm/phoebe" },
      latestTag: "v0.4.0",
      installedCli: "0.5.0",
      latestCli: "0.4.0",
    });
    // …but a plain newer version compares by ordering, not string inequality.
    expect(ahead.cli.behind).toBe(false);
    expect(ahead.ok).toBe(true);
  });

  test("unknowns stay null and do not fail the check", () => {
    const report = buildCheckReport({
      source: { source: "github", ref: "v0.3.2", repo: "JesusFilm/phoebe" },
      latestTag: null,
      installedCli: "0.3.1",
      latestCli: null,
    });
    expect(report.engine.behind).toBeNull();
    expect(report.cli.behind).toBeNull();
    expect(report.ok).toBe(true);
  });
});

// ------------------------------------------------------------------ migration ordering

const SCAFFOLD = `import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  engine: { source: "github", ref: "v0.3.1" },
};

export default config;
`;

/** ls-remote output that validates a release tag ref. */
const VALID_LS_REMOTE = "aabb1234cc\trefs/tags/v0.3.2\n";

function makeTempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-upgrade-test-"));
  const configPath = join(dir, "phoebe.config.ts");
  writeFileSync(configPath, SCAFFOLD);
  return configPath;
}

function makeIo(overrides: {
  runMigrations: (opts: {
    source: { source: "github"; ref: string; repo: string };
    configPath: string;
    token: string | undefined;
  }) => number | null;
}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    git: (_args: readonly string[]) => VALID_LS_REMOTE,
    npm: (_args: readonly string[]) => "",
    stdout: (line: string) => {
      stdout.push(line);
    },
    stderr: (line: string) => {
      stderr.push(line);
    },
    runMigrations: overrides.runMigrations,
    _stdout: stdout,
    _stderr: stderr,
  };
}

describe("upgradeEngineHalf migration ordering", () => {
  let savedExitCode: number | undefined;
  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  test("no migrations index (runMigrations returns null) — flip proceeds", () => {
    savedExitCode = process.exitCode as number | undefined;
    const configPath = makeTempConfig();
    const io = makeIo({ runMigrations: () => null });
    const moved = upgradeEngineHalf({
      configPath,
      source: { source: "github", ref: "v0.3.1", repo: "JesusFilm/phoebe" },
      ref: "v0.3.2",
      refKind: "release-tag",
      token: undefined,
      io,
    });
    expect(moved).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain('ref: "v0.3.2"');
  });

  test("migrations exit 0 — flip proceeds", () => {
    savedExitCode = process.exitCode as number | undefined;
    const configPath = makeTempConfig();
    const io = makeIo({ runMigrations: () => 0 });
    const moved = upgradeEngineHalf({
      configPath,
      source: { source: "github", ref: "v0.3.1", repo: "JesusFilm/phoebe" },
      ref: "v0.3.2",
      refKind: "release-tag",
      token: undefined,
      io,
    });
    expect(moved).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain('ref: "v0.3.2"');
  });

  test("migrations exit nonzero — flip aborted, engine.ref unchanged", () => {
    savedExitCode = process.exitCode as number | undefined;
    const configPath = makeTempConfig();
    const originalContent = readFileSync(configPath, "utf8");
    const io = makeIo({ runMigrations: () => 1 });
    const moved = upgradeEngineHalf({
      configPath,
      source: { source: "github", ref: "v0.3.1", repo: "JesusFilm/phoebe" },
      ref: "v0.3.2",
      refKind: "release-tag",
      token: undefined,
      io,
    });
    expect(moved).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(readFileSync(configPath, "utf8")).toBe(originalContent);
    expect(io._stderr.some((line) => line.includes("migrations failed"))).toBe(true);
  });

  test("migrations are called before the pin moves", () => {
    savedExitCode = process.exitCode as number | undefined;
    const configPath = makeTempConfig();
    let contentAtMigrateTime: string | null = null;
    const io = makeIo({
      runMigrations: () => {
        // Capture the config content at the moment migrations run
        contentAtMigrateTime = readFileSync(configPath, "utf8");
        return 0;
      },
    });
    upgradeEngineHalf({
      configPath,
      source: { source: "github", ref: "v0.3.1", repo: "JesusFilm/phoebe" },
      ref: "v0.3.2",
      refKind: "release-tag",
      token: undefined,
      io,
    });
    // At migration time, the pin was still at v0.3.1 (pre-flip)
    expect(contentAtMigrateTime).toContain('ref: "v0.3.1"');
    // After flip, the config now shows v0.3.2
    expect(readFileSync(configPath, "utf8")).toContain('ref: "v0.3.2"');
  });
});
