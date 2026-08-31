// Contract tests for `resolveConfig` / `validateUserConfig`: five required
// fields, engine defaults for the rest, and a shallow merge for the four
// nested records so a consumer can override one prompt file or one provider's
// model without repeating the others.

import { describe, expect, test } from "vite-plus/test";
import {
  CONFIG_DEFAULTS,
  PROVIDER_NAMES,
  resolveConfig,
  validateUserConfig,
  type PhoebeUserConfig,
} from "./config-schema.ts";

function minimalUserConfig(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

describe("validateUserConfig", () => {
  test("accepts a minimal five-field config", () => {
    expect(() => validateUserConfig(minimalUserConfig())).not.toThrow();
  });

  test.each([
    ["repoSlug"],
    ["repoUrl"],
    ["installCommand"],
    ["checkCommand"],
    ["testCommand"],
  ] as const)("rejects when %s is missing", (key) => {
    const config = { ...minimalUserConfig() } as Record<string, unknown>;
    delete config[key];
    expect(() => validateUserConfig(config as PhoebeUserConfig)).toThrow(
      new RegExp(`missing required field.*${key}`, "i"),
    );
  });

  test("rejects blank required strings the same as missing ones", () => {
    expect(() => validateUserConfig(minimalUserConfig({ repoSlug: "   " }))).toThrow(/repoSlug/);
  });

  test("lists every missing required field in one error", () => {
    const config = {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
    } as PhoebeUserConfig;
    expect(() => validateUserConfig(config)).toThrow(/installCommand.*checkCommand.*testCommand/);
  });

  test("rejects a blockedByPattern that is not a valid regex", () => {
    expect(() =>
      validateUserConfig(minimalUserConfig({ blockedByPattern: "Blocked by [" })),
    ).toThrow(/blockedByPattern/);
  });

  test("rejects a blockedByPattern that is valid but has no capture group", () => {
    // parseBlockedBy reads match[1]; a pattern without a group would silently
    // yield NaN blocker numbers.
    expect(() =>
      validateUserConfig(minimalUserConfig({ blockedByPattern: String.raw`Blocked by #\d+` })),
    ).toThrow(/capture group 1/);
  });

  test("rejects a blockedByPattern whose only groups are non-capturing", () => {
    expect(() =>
      validateUserConfig(minimalUserConfig({ blockedByPattern: String.raw`(?:Blocked by )#\d+` })),
    ).toThrow(/capture group 1/);
  });

  test("rejects a partOfPattern that is not a valid regex", () => {
    expect(() => validateUserConfig(minimalUserConfig({ partOfPattern: "Part of [" }))).toThrow(
      /partOfPattern/,
    );
  });

  test("rejects a partOfPattern with no capture group", () => {
    // parsePartOf reads match[1]; without a group every membership read is NaN.
    expect(() =>
      validateUserConfig(minimalUserConfig({ partOfPattern: String.raw`Part of #\d+` })),
    ).toThrow(/capture group 1/);
  });

  test("accepts a pattern that uses non-capturing groups plus a real capture group", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ blockedByPattern: String.raw`(?:Blocked by|Depends on)\s+#(\d+)` }),
      ),
    ).not.toThrow();
  });

  test("accepts a workspace block with omitted depth (bootstrap defaults to 1)", () => {
    expect(() => validateUserConfig(minimalUserConfig({ workspace: {} }))).not.toThrow();
  });

  test("accepts a workspace block with an integer depth ≥ 1", () => {
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: 1 } }))).not.toThrow();
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: 3 } }))).not.toThrow();
  });

  test("workspace-root config (workspace block, no tenant fields) does not throw", () => {
    // A workspace-root config carries workspace instead of the five tenant fields (#354).
    // validateUserConfig must not demand repoSlug/repoUrl/etc. from a workspace root.
    expect(() => validateUserConfig({ workspace: { depth: 1 } } as PhoebeUserConfig)).not.toThrow();
  });

  test("rejects workspace.depth < 1", () => {
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: 0 } }))).toThrow(
      /workspace\.depth.*integer ≥ 1/i,
    );
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: -1 } }))).toThrow(
      /workspace\.depth/i,
    );
  });

  test("rejects non-integer workspace.depth", () => {
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: 1.5 } }))).toThrow(
      /workspace\.depth/i,
    );
  });

  test("accepts an explicitly declared fleet", () => {
    expect(() =>
      validateUserConfig(minimalUserConfig({ workspace: { tenants: ["widget", "gadget"] } })),
    ).not.toThrow();
    expect(() =>
      validateUserConfig(minimalUserConfig({ workspace: { tenants: [] } })),
    ).not.toThrow();
  });

  test("engine-side validation shares the bootstrapper's tenants rules", () => {
    // Not re-testing every rule here — the point is that one validator backs
    // both entry points, so a rule added in bootstrap/workspace-source.ts is
    // enforced at `resolveConfig` too, without a second copy to keep in step.
    expect(() =>
      validateUserConfig(minimalUserConfig({ workspace: { tenants: ["apps/*"] } })),
    ).toThrow(/glob/i);
    expect(() =>
      validateUserConfig(minimalUserConfig({ workspace: { tenants: ["apps", "apps/web"] } })),
    ).toThrow(/nested/i);
  });

  test("rejects a workspace block declaring both arms", () => {
    expect(() =>
      validateUserConfig(
        // @ts-expect-error the WorkspaceField union rejects both arms at compile
        // time too — this asserts the runtime guard behind that type.
        minimalUserConfig({ workspace: { depth: 1, tenants: ["widget"] } }),
      ),
    ).toThrow(/exactly one of/i);
  });

  test("accepts a well-formed workKinds block (#300)", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          workKinds: {
            reviews: { provider: "claude", model: "claude-haiku-4-5", effort: "low" },
            issues: { effort: "high" },
          },
        }),
      ),
    ).not.toThrow();
  });

  test("accepts effort: null as an explicit clear in a workKinds block (#335)", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          workKinds: { reviews: { model: "claude-haiku-4-5", effort: null } },
        }),
      ),
    ).not.toThrow();
  });

  test("accepts a workKinds block for a kind absent from workOrder — allowed and inert", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          workOrder: ["issues"],
          workKinds: { reviews: { effort: "low" } },
        }),
      ),
    ).not.toThrow();
  });

  test("rejects an unknown workKinds kind key", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ workKinds: { review: { effort: "low" } } as unknown as never }),
      ),
    ).toThrow(/unknown work kind "review"/i);
  });

  test("rejects an unknown workKinds provider value", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ workKinds: { reviews: { provider: "gemini" } } as unknown as never }),
      ),
    ).toThrow(/workKinds\.reviews\.provider/);
  });

  test("rejects an unknown knob inside a workKinds block", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ workKinds: { reviews: { timeout: 5000 } } as unknown as never }),
      ),
    ).toThrow(/unknown knob "timeout"/i);
  });

  test("rejects a non-object workKinds block", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ workKinds: { reviews: "claude" } as unknown as never }),
      ),
    ).toThrow(/workKinds\.reviews/);
  });

  // --- workKinds.custom (#303/#350): the declaration surface's shape --------

  /** A syntactically plausible inline definition (members validated later). */
  const inlineKind = { name: "nudge", fetch: () => {} } as unknown as never;

  test("accepts the three custom-entry arms", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          workKinds: {
            custom: {
              inline: inlineKind,
              pathed: "./kinds/pathed.ts",
              wrapped: { module: "../kinds/wrapped.ts", options: { staleDays: 7 } },
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  test("a sibling override block may tune a declared custom kind", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          workKinds: {
            custom: { nudge: "./kinds/nudge.ts" },
            nudge: { model: "claude-haiku-4-5", effort: "low" },
          },
        }),
      ),
    ).not.toThrow();
  });

  test("a sibling key outside built-ins ∪ declared customs still rejects, naming both", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          workKinds: {
            custom: { nudge: "./kinds/nudge.ts" },
            nudgee: { effort: "low" },
          },
        }),
      ),
    ).toThrow(/unknown work kind "nudgee".*nudge/s);
  });

  test("rejects an illegal custom kind name", () => {
    for (const bad of ["Nudge", "1nudge", "nudge_thing", "x".repeat(33)]) {
      expect(() =>
        validateUserConfig(minimalUserConfig({ workKinds: { custom: { [bad]: inlineKind } } })),
      ).toThrow(/illegal kind/);
    }
  });

  test("rejects a custom kind claiming a reserved name", () => {
    for (const reserved of ["issues", "custom"]) {
      expect(() =>
        validateUserConfig(
          minimalUserConfig({ workKinds: { custom: { [reserved]: inlineKind } } }),
        ),
      ).toThrow(/reserved/);
    }
  });

  test("rejects a bare-specifier module path, explaining the constraint", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ workKinds: { custom: { nudge: "some-package/kind" } } }),
      ),
    ).toThrow(/bare specifier.*node_modules/s);
  });

  test("rejects an unknown wrapper field", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          workKinds: {
            custom: { nudge: { module: "./kinds/nudge.ts", option: {} } as unknown as never },
          },
        }),
      ),
    ).toThrow(/unknown wrapper field "option"/);
  });

  test("rejects non-object wrapper options", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          workKinds: {
            custom: { nudge: { module: "./kinds/nudge.ts", options: 7 } as unknown as never },
          },
        }),
      ),
    ).toThrow(/options must be a plain object/);
  });

  test("rejects wrapper options that are objects but not plain records", () => {
    for (const options of [new Date(), new Map(), Object.create({ inherited: true })]) {
      expect(() =>
        validateUserConfig(
          minimalUserConfig({
            workKinds: {
              custom: { nudge: { module: "./kinds/nudge.ts", options } as unknown as never },
            },
          }),
        ),
      ).toThrow(/options must be a plain object/);
    }
    // A null-prototype record is still a plain record.
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          workKinds: {
            custom: {
              nudge: {
                module: "./kinds/nudge.ts",
                options: Object.create(null),
              } as unknown as never,
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  test("accepts a relative configDir", () => {
    expect(() => validateUserConfig(minimalUserConfig({ configDir: ".phoebe" }))).not.toThrow();
    expect(() =>
      validateUserConfig(minimalUserConfig({ configDir: "deploy/phoebe" })),
    ).not.toThrow();
  });

  test("rejects an absolute configDir", () => {
    expect(() => validateUserConfig(minimalUserConfig({ configDir: "/etc/phoebe" }))).toThrow(
      /configDir.*absolute/i,
    );
  });

  test("rejects a `..`-escaping or empty configDir", () => {
    expect(() => validateUserConfig(minimalUserConfig({ configDir: "../sibling" }))).toThrow(
      /configDir/i,
    );
    expect(() => validateUserConfig(minimalUserConfig({ configDir: "" }))).toThrow(/configDir/i);
  });

  test("accepts a well-formed gitIdentity (#199)", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ gitIdentity: { name: "Widget Bot", email: "widget@acme.dev" } }),
      ),
    ).not.toThrow();
  });

  test("rejects a half-declared or malformed gitIdentity (#199)", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ gitIdentity: { name: "Widget Bot" } as unknown as never }),
      ),
    ).toThrow(/gitIdentity/i);
    expect(() =>
      validateUserConfig(minimalUserConfig({ gitIdentity: { name: "Bot", email: "nope" } })),
    ).toThrow(/gitIdentity/i);
  });

  test("accepts a well-formed deployment block (#260)", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          deployment: {
            startCommand: "systemctl start phoebe",
            stopCommand: "systemctl stop phoebe",
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          deployment: {
            startCommand: "podman compose up -d",
            stopCommand: "podman compose stop -t 3600",
            stopNowCommand: "podman compose stop -t 5",
          },
        }),
      ),
    ).not.toThrow();
  });

  test("rejects a deployment block missing or blanking startCommand / stopCommand (#260)", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          deployment: { stopCommand: "systemctl stop phoebe" } as unknown as never,
        }),
      ),
    ).toThrow(/deployment.*startCommand/i);
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          deployment: { startCommand: "systemctl start phoebe", stopCommand: "   " },
        }),
      ),
    ).toThrow(/deployment.*stopCommand/i);
    expect(() =>
      validateUserConfig(minimalUserConfig({ deployment: {} as unknown as never })),
    ).toThrow(/deployment.*startCommand.*stopCommand/i);
  });

  test("rejects a deployment block whose stopNowCommand is present but blank (#260)", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          deployment: {
            startCommand: "systemctl start phoebe",
            stopCommand: "systemctl stop phoebe",
            stopNowCommand: "",
          },
        }),
      ),
    ).toThrow(/deployment.*stopNowCommand/i);
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          deployment: {
            startCommand: "systemctl start phoebe",
            stopCommand: "systemctl stop phoebe",
            stopNowCommand: "   ",
          },
        }),
      ),
    ).toThrow(/deployment.*stopNowCommand/i);
  });

  test("rejects a deployment value that is not an object (#260)", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ deployment: "systemctl start phoebe" as unknown as never }),
      ),
    ).toThrow(/deployment.*must be an object/i);
  });
});

describe("resolveConfig", () => {
  test("fills every optional field from CONFIG_DEFAULTS", () => {
    const resolved = resolveConfig(minimalUserConfig());
    expect(resolved.defaultBranch).toBe(CONFIG_DEFAULTS.defaultBranch);
    expect(resolved.branchPrefix).toBe(CONFIG_DEFAULTS.branchPrefix);
    expect(resolved.readyLabel).toBe(CONFIG_DEFAULTS.readyLabel);
    expect(resolved.researchLabel).toBe(CONFIG_DEFAULTS.researchLabel);
    expect(resolved.processingLabel).toBe(CONFIG_DEFAULTS.processingLabel);
    expect(resolved.featureLabel).toBe(CONFIG_DEFAULTS.featureLabel);
    expect(resolved.featureBranchCatchUp).toBe(CONFIG_DEFAULTS.featureBranchCatchUp);
    expect(resolved.readyCommand).toBe(CONFIG_DEFAULTS.readyCommand);
    expect(resolved.blockedByPattern).toBe(CONFIG_DEFAULTS.blockedByPattern);
    expect(resolved.partOfPattern).toBe(CONFIG_DEFAULTS.partOfPattern);
    expect(resolved.reviewsSuccessHeading).toBe(CONFIG_DEFAULTS.reviewsSuccessHeading);
    expect(resolved.prScope).toBe(CONFIG_DEFAULTS.prScope);
    expect(resolved.draftPrs).toBe(CONFIG_DEFAULTS.draftPrs);
    expect(resolved.prOptOutLabel).toBe(CONFIG_DEFAULTS.prOptOutLabel);
    expect(resolved.workOrder).toEqual(CONFIG_DEFAULTS.workOrder);
    expect(resolved.defaultProvider).toBe(CONFIG_DEFAULTS.defaultProvider);
    expect(resolved.runTimeoutMs).toBe(CONFIG_DEFAULTS.runTimeoutMs);
    expect(resolved.maxUnproductiveRuns).toBe(CONFIG_DEFAULTS.maxUnproductiveRuns);
  });

  test("run-protection knobs carry sane shipped defaults", () => {
    expect(CONFIG_DEFAULTS.runTimeoutMs).toBe(2_700_000);
    expect(CONFIG_DEFAULTS.maxUnproductiveRuns).toBe(3);
    const resolved = resolveConfig(
      minimalUserConfig({ runTimeoutMs: 60_000, maxUnproductiveRuns: 5 }),
    );
    expect(resolved.runTimeoutMs).toBe(60_000);
    expect(resolved.maxUnproductiveRuns).toBe(5);
  });

  test("maxUnitTimeouts is a deprecated alias for maxUnproductiveRuns", () => {
    const resolved = resolveConfig(minimalUserConfig({ maxUnitTimeouts: 7 }));
    expect(resolved.maxUnproductiveRuns).toBe(7);
  });

  test("maxUnproductiveRuns takes precedence over deprecated maxUnitTimeouts", () => {
    const resolved = resolveConfig(
      minimalUserConfig({ maxUnproductiveRuns: 4, maxUnitTimeouts: 9 }),
    );
    expect(resolved.maxUnproductiveRuns).toBe(4);
  });

  test("creditIssueAuthor defaults on and can be switched off (#198)", () => {
    expect(CONFIG_DEFAULTS.creditIssueAuthor).toBe(true);
    expect(resolveConfig(minimalUserConfig()).creditIssueAuthor).toBe(true);
    expect(resolveConfig(minimalUserConfig({ creditIssueAuthor: false })).creditIssueAuthor).toBe(
      false,
    );
  });

  test("featureLabel defaults to phoebe:feature and is overridable (#341)", () => {
    expect(CONFIG_DEFAULTS.featureLabel).toBe("phoebe:feature");
    expect(resolveConfig(minimalUserConfig()).featureLabel).toBe("phoebe:feature");
    expect(resolveConfig(minimalUserConfig({ featureLabel: "epic" })).featureLabel).toBe("epic");
  });

  test("featureBranchCatchUp defaults on and can be switched off (#341)", () => {
    expect(CONFIG_DEFAULTS.featureBranchCatchUp).toBe(true);
    expect(resolveConfig(minimalUserConfig()).featureBranchCatchUp).toBe(true);
    expect(
      resolveConfig(minimalUserConfig({ featureBranchCatchUp: false })).featureBranchCatchUp,
    ).toBe(false);
  });

  test("disabled defaults false and can be switched on (#202)", () => {
    expect(CONFIG_DEFAULTS.disabled).toBe(false);
    expect(resolveConfig(minimalUserConfig()).disabled).toBe(false);
    expect(resolveConfig(minimalUserConfig({ disabled: true })).disabled).toBe(true);
  });

  test("preserves the caller's required-field values verbatim", () => {
    const resolved = resolveConfig(minimalUserConfig());
    expect(resolved.repoSlug).toBe("acme/widget");
    expect(resolved.repoUrl).toBe("https://github.com/acme/widget.git");
    expect(resolved.installCommand).toBe("npm ci");
    expect(resolved.checkCommand).toBe("npm run check");
    expect(resolved.testCommand).toBe("npm test");
  });

  test("caller overrides shadow the defaults", () => {
    const resolved = resolveConfig(
      minimalUserConfig({
        defaultBranch: "trunk",
        readyLabel: "green-light",
        readyCommand: "pnpm ready",
      }),
    );
    expect(resolved.defaultBranch).toBe("trunk");
    expect(resolved.readyLabel).toBe("green-light");
    expect(resolved.readyCommand).toBe("pnpm ready");
  });

  test("shallow-merges nested records: promptFiles overrides one at a time", () => {
    const resolved = resolveConfig(
      minimalUserConfig({ promptFiles: { issue: "custom/issue.md" } }),
    );
    expect(resolved.promptFiles.issue).toBe("custom/issue.md");
    expect(resolved.promptFiles.reviews).toBe(CONFIG_DEFAULTS.promptFiles.reviews);
    expect(resolved.promptFiles.conflict).toBe(CONFIG_DEFAULTS.promptFiles.conflict);
    expect(resolved.promptFiles.checks).toBe(CONFIG_DEFAULTS.promptFiles.checks);
    expect(resolved.promptFiles.research).toBe(CONFIG_DEFAULTS.promptFiles.research);
  });

  test("shallow-merges provider defaults: one model override leaves the others", () => {
    const resolved = resolveConfig(
      minimalUserConfig({ defaultModels: { claude: "claude-opus-4-7" } }),
    );
    expect(resolved.defaultModels.claude).toBe("claude-opus-4-7");
    expect(resolved.defaultModels.cursor).toBe(CONFIG_DEFAULTS.defaultModels.cursor);
    expect(resolved.defaultModels.codex).toBe(CONFIG_DEFAULTS.defaultModels.codex);
  });

  test("effort defaults to unset per provider, and merges the same way", () => {
    // No entry means no `--effort` flag at all, which is what leaves each
    // provider CLI's own default in place for consumers who never set one.
    const bare = resolveConfig(minimalUserConfig());
    for (const provider of PROVIDER_NAMES) {
      expect(bare.defaultEfforts[provider]).toBeUndefined();
    }
    const resolved = resolveConfig(minimalUserConfig({ defaultEfforts: { claude: "low" } }));
    expect(resolved.defaultEfforts.claude).toBe("low");
    expect(resolved.defaultEfforts.cursor).toBeUndefined();
  });

  test("workKinds defaults to empty and passes user blocks through (#300)", () => {
    expect(resolveConfig(minimalUserConfig()).workKinds).toEqual({});
    const resolved = resolveConfig(
      minimalUserConfig({ workKinds: { reviews: { provider: "claude", effort: "low" } } }),
    );
    expect(resolved.workKinds.reviews).toEqual({ provider: "claude", effort: "low" });
    expect(resolved.workKinds.issues).toBeUndefined();
  });

  test("shallow-merges provider env vars the same way", () => {
    const resolved = resolveConfig(minimalUserConfig({ providerEnv: { cursor: "MY_CURSOR_KEY" } }));
    expect(resolved.providerEnv.cursor).toBe("MY_CURSOR_KEY");
    expect(resolved.providerEnv.claude).toBe(CONFIG_DEFAULTS.providerEnv.claude);
  });

  test("derives per-tenant paths from the slug under the default data base", () => {
    const resolved = resolveConfig(minimalUserConfig());
    expect(resolved.paths.repoDir).toBe("/data/repos/acme/widget/repo");
    expect(resolved.paths.worktreesDir).toBe("/data/repos/acme/widget/worktrees");
    expect(resolved.paths.stateDir).toBe("/data/repos/acme/widget/state");
  });

  test("threads a custom data base into the derived paths", () => {
    const resolved = resolveConfig(minimalUserConfig(), { dataBase: "/srv/phoebe" });
    expect(resolved.paths.repoDir).toBe("/srv/phoebe/acme/widget/repo");
    expect(resolved.paths.worktreesDir).toBe("/srv/phoebe/acme/widget/worktrees");
    expect(resolved.paths.stateDir).toBe("/srv/phoebe/acme/widget/state");
  });

  test("defaults name a model and env var for every declared provider", () => {
    // Guards against a new provider being added without a matching default.
    for (const provider of PROVIDER_NAMES) {
      expect(CONFIG_DEFAULTS.defaultModels[provider]).toBeTruthy();
      expect(CONFIG_DEFAULTS.providerEnv[provider]).toBeTruthy();
    }
  });

  test("default partOfPattern compiles and captures the parent issue number", () => {
    const match = new RegExp(CONFIG_DEFAULTS.partOfPattern, "i").exec("Part of #341.");
    expect(Number(match?.[1])).toBe(341);
  });

  test("default blockedByPattern compiles and captures the issue number", () => {
    const pattern = new RegExp(CONFIG_DEFAULTS.blockedByPattern, "gi");
    const matches = [..."Blocked by #42\nblocked by  #7".matchAll(pattern)].map((m) =>
      Number(m[1]),
    );
    expect(matches).toEqual([42, 7]);
  });

  test("round-trips a config carrying bootstrapper-only engine + workspace fields", () => {
    // Type-level: assigning these on PhoebeUserConfig must compile. Runtime:
    // resolveConfig accepts the user shape and still produces a full engine config.
    const user: PhoebeUserConfig = minimalUserConfig({
      engine: { source: "github", ref: "v0.1.0" },
      workspace: { depth: 2 },
    });
    const resolved = resolveConfig(user);
    expect(resolved.repoSlug).toBe("acme/widget");
    expect(resolved.defaultBranch).toBe(CONFIG_DEFAULTS.defaultBranch);
    expect(resolved.paths.repoDir).toBe("/data/repos/acme/widget/repo");
  });

  test("drops bootstrapper-only engine, workspace, configDir, gitIdentity, and deployment from the engine-facing shape", () => {
    // Mirrors how `engine` is never on PhoebeConfig: the fields are accepted
    // on the user config so consumers type-check, then discarded by construction.
    const resolved = resolveConfig(
      minimalUserConfig({
        engine: { source: "local" },
        workspace: { depth: 2 },
        configDir: ".phoebe",
        gitIdentity: { name: "Widget Bot", email: "widget@acme.dev" },
        deployment: {
          startCommand: "systemctl start phoebe",
          stopCommand: "systemctl stop phoebe",
        },
      }),
    );
    expect(resolved).not.toHaveProperty("engine");
    expect(resolved).not.toHaveProperty("workspace");
    expect(resolved).not.toHaveProperty("configDir");
    expect(resolved).not.toHaveProperty("gitIdentity");
    expect(resolved).not.toHaveProperty("deployment");
    // A spread snapshot of keys must not sneak them back in under any alias.
    expect(Object.keys(resolved).sort()).not.toContain("engine");
    expect(Object.keys(resolved).sort()).not.toContain("workspace");
    expect(Object.keys(resolved).sort()).not.toContain("configDir");
    expect(Object.keys(resolved).sort()).not.toContain("gitIdentity");
    expect(Object.keys(resolved).sort()).not.toContain("deployment");
  });
});
