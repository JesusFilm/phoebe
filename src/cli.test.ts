// Argv parsing contract for the `phoebe` bin: `--config`/`-c` (with space or
// `=`), `--help`/`-h`, and everything else forwarded to `runEngine` for the
// engine to interpret. Init flags (`--workspace` / `--tenant`) are mutually
// exclusive profile selectors. The full CLI is exercised at the smoke-test
// level in dev; here we just pin the surface.

import { describe, expect, test } from "vite-plus/test";
import {
  assertNotWorkspaceRoot,
  formatListJson,
  formatListReport,
  parseCliArgs,
  parseInitArgs,
} from "./cli.ts";
import type { PipelineListing } from "./pipeline-listing.ts";
import type { ListTenantsResult, TenantListing } from "./tenant-commands.ts";

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

  test("forwards --pipeline and its value to the engine (#415)", () => {
    expect(parseCliArgs(["--pipeline", "intake", "--dry-run"])).toEqual({
      configPath: undefined,
      help: false,
      forward: ["--pipeline", "intake", "--dry-run"],
    });
    expect(parseCliArgs(["--pipeline=intake"]).forward).toEqual(["--pipeline=intake"]);
  });

  test("rejects --pipeline with no name", () => {
    expect(() => parseCliArgs(["--pipeline"])).toThrow(/requires a pipeline name/);
    expect(() => parseCliArgs(["--pipeline="])).toThrow(/requires a pipeline name/);
  });

  test("refuses to read the next flag as a value (#460)", () => {
    // The shared matchers hold both flags to one contract, so `--pipeline`
    // here rejects what `parsePipelineName` has always rejected — rather than
    // forwarding `--dry-run` as a pipeline name and losing the flag.
    expect(() => parseCliArgs(["--pipeline", "--dry-run"])).toThrow(/requires a pipeline name/);
    expect(() => parseCliArgs(["--config", "--dry-run"])).toThrow(/requires a path/);
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
    expect(() => parseCliArgs(["upgrayedd"])).toThrow(/Known commands:.*\bstop\b/);
    expect(() => parseCliArgs(["upgrayedd"])).toThrow(/Known commands:.*\bstart\b/);
    expect(() => parseCliArgs(["--run-once", "extra"])).toThrow(/Unknown command `extra`/);
  });

  test("points a direct-engine `boot` at the bootstrapper instead of calling it unknown", () => {
    // Through the packaged bin, bootstrap/cli.ts dispatches `boot` before the
    // engine CLI runs, so this only fires on a direct engine invocation — where
    // the generic error would list `boot` among the known commands while
    // rejecting it.
    expect(() => parseCliArgs(["boot"])).toThrow(/bootstrapper command/);
    expect(() => parseCliArgs(["boot"])).not.toThrow(/Unknown command/);
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

// --- `phoebe list` rendering (#427) --------------------------------------

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function pipeline(fields: Partial<PipelineListing> & { name: string }): PipelineListing {
  return {
    disabled: false,
    source: "enumerated",
    state: "idle",
    units: [],
    updatedAt: "2026-09-04T11:59:00.000Z",
    wedged: false,
    concurrency: 1,
    ...fields,
  };
}

function tenant(fields: Partial<TenantListing> & { path: string }): TenantListing {
  return {
    slug: "acme/widget",
    held: false,
    reason: null,
    configValid: true,
    envPresent: true,
    retainedData: true,
    pipelines: [],
    arm: "pat",
    disabled: false,
    ...fields,
  };
}

function result(listings: TenantListing[], fields: Partial<ListTenantsResult> = {}) {
  return {
    listings,
    declared: listings.length,
    live: listings.filter((l) => !l.held).length,
    explicit: false,
    solo: false,
    undeclared: [],
    ...fields,
  };
}

describe("formatListReport", () => {
  test("one indented line per pipeline, states and marks in the same grammar", () => {
    const report = formatListReport(
      result([
        tenant({
          path: "children/widget",
          pipelines: [
            pipeline({
              name: "work",
              state: "working",
              concurrency: 2,
              units: [
                {
                  unit: { kind: "issues", id: "12" },
                  startedAt: "2026-09-04T11:40:00.000Z",
                  runBudgetMs: 2_700_000,
                },
              ],
            }),
            pipeline({ name: "intake", state: "waiting for slot" }),
            pipeline({ name: "nightly", disabled: true, state: "no status" }),
          ],
        }),
      ]),
      NOW,
    );

    expect(report.split("\n")).toEqual([
      "[phoebe] 1 tenant(s):",
      "  children/widget  (acme/widget)",
      "      ✓ config  ✓ env  ✓ data  arm: pat",
      "        work     working 1/2 issues 12",
      "        intake   waiting for slot",
      "        nightly  no status  (disabled)",
    ]);
  });

  test("a wedged row keeps its refs and adds the age it has been running", () => {
    const report = formatListReport(
      result([
        tenant({
          path: "children/widget",
          pipelines: [
            pipeline({
              name: "work",
              state: "working",
              wedged: true,
              units: [
                {
                  unit: { kind: "issues", id: "12" },
                  startedAt: "2026-09-04T09:00:00.000Z",
                  runBudgetMs: 2_700_000,
                },
              ],
            }),
          ],
        }),
      ]),
      NOW,
    );
    expect(report).toContain("work  working 1/1 issues 12  wedged? 3h");
  });

  test("a stale dir gets a mark and a legend; a held tenant's lines come off disk", () => {
    const report = formatListReport(
      result(
        [
          tenant({
            path: "children/widget",
            pipelines: [pipeline({ name: "work" }), pipeline({ name: "old", source: "stale" })],
          }),
          tenant({
            path: "children/stuck",
            slug: "acme/stuck",
            held: true,
            reason: "missing repoSlug",
            pipelines: [pipeline({ name: "work", source: "disk", concurrency: null })],
          }),
        ],
        { explicit: true },
      ),
      NOW,
    );

    expect(report).toContain("old   idle  (stale)");
    expect(report).toContain("held — missing repoSlug");
    expect(report).toContain("work  idle  (from disk)");
    expect(report).toContain("stale = state/<name>/ directory");
    expect(report).toContain("held = discovery would skip this dir now");
  });

  test("solo names itself; an empty workspace still says No tenants", () => {
    const solo = formatListReport(
      result([tenant({ path: "/deploy", pipelines: [pipeline({ name: "work" })] })], {
        solo: true,
      }),
      NOW,
    );
    expect(solo.split("\n")[0]).toBe("[phoebe] 1 tenant (solo):");
    expect(solo).toContain("        work  idle");
    expect(formatListReport(result([]), NOW)).toContain("No tenants");
  });
});

describe("formatListJson", () => {
  test("each tenant carries pipelines[] and no tenant-level status", () => {
    const parsed = JSON.parse(
      formatListJson(
        result([
          tenant({
            path: "children/widget",
            pipelines: [pipeline({ name: "work", state: "working", wedged: true })],
          }),
        ]),
      ),
    ) as { tenants: { status?: unknown; pipelines: Record<string, unknown>[] }[] };

    expect(parsed.tenants[0]).not.toHaveProperty("status");
    expect(Object.keys(parsed.tenants[0]!.pipelines[0]!).sort()).toEqual([
      "disabled",
      "name",
      "source",
      "state",
      "units",
      "updatedAt",
      "wedged",
    ]);
    expect(parsed.tenants[0]!.pipelines[0]).toMatchObject({ state: "working", wedged: true });
  });
});
