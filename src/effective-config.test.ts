// The effective config's ladders (#531). Every test here is a literal config
// plus a literal environment: the module reads nothing, which is what lets the
// whole precedence story be asserted without a deployment under it.

import { describe, expect, test } from "vite-plus/test";
import type { EffectiveFields, EffectiveLeaf } from "./contracts/effective-config.ts";
import { catalogueEnvNames } from "./settings-catalogue.ts";
import {
  computeEffectiveConfig,
  effectiveConfigError,
  isLeaf,
  walkLeaves,
  type EffectiveConfigInput,
  type EnvLayers,
} from "./effective-config.ts";
import type { PhoebeUserConfig } from "./config-schema.ts";

const CONFIG_PATH = "/etc/phoebe/phoebe.config.ts";

function userConfig(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

function compute(opts: {
  user?: Partial<PhoebeUserConfig>;
  env?: EnvLayers;
  declaredEnv?: readonly string[];
}) {
  const input: EffectiveConfigInput = {
    user: userConfig(opts.user),
    configPath: CONFIG_PATH,
    dataBase: "/data/repos",
    env: opts.env ?? {},
    ...(opts.declaredEnv !== undefined ? { declaredEnv: opts.declaredEnv } : {}),
  };
  return computeEffectiveConfig(input);
}

/** The leaf at a dotted path, asserted to exist and to be a leaf. */
function leafAt(fields: EffectiveFields | null, path: string): EffectiveLeaf {
  let node: unknown = fields;
  for (const segment of path.split(".")) {
    expect(node, `no branch at ${path}`).toBeTruthy();
    node = (node as EffectiveFields)[segment];
  }
  if (!isLeaf(node)) throw new Error(`${path} is not a leaf`);
  return node;
}

describe("the source of one tenant leaf", () => {
  test("nothing said otherwise — the shipped default", () => {
    const leaf = leafAt(compute({}).fields, "readyLabel");
    expect(leaf).toMatchObject({ value: "ready-for-agent", source: "default", reader: "engine" });
    expect(leaf.via).toBeUndefined();
  });

  test("the config file, named by its path", () => {
    const leaf = leafAt(compute({ user: { readyLabel: "go" } }).fields, "readyLabel");
    expect(leaf).toMatchObject({ value: "go", source: "file", via: CONFIG_PATH });
  });

  test("an env var under its catalogued name is an overlay, and shadows the file", () => {
    const leaf = leafAt(
      compute({
        user: { readyLabel: "go" },
        env: { process: { PHOEBE_READY_LABEL: "now" } },
      }).fields,
      "readyLabel",
    );
    expect(leaf).toMatchObject({
      value: "now",
      source: "overlay",
      via: "PHOEBE_READY_LABEL",
      from: "process",
    });
    expect(leaf.shadowed).toEqual([{ source: "file", via: CONFIG_PATH, value: "go" }]);
  });

  test("a permanent older name is an alias, and the canonical name outranks it", () => {
    const aliasOnly = leafAt(
      compute({ env: { process: { PHOEBE_AGENT: "codex" } } }).fields,
      "defaultProvider",
    );
    expect(aliasOnly).toMatchObject({ value: "codex", source: "alias", via: "PHOEBE_AGENT" });

    const both = leafAt(
      compute({
        env: { process: { PHOEBE_AGENT: "codex", PHOEBE_DEFAULT_PROVIDER: "claude" } },
      }).fields,
      "defaultProvider",
    );
    expect(both).toMatchObject({ value: "claude", source: "overlay" });
    expect(both.shadowed).toEqual([{ source: "alias", via: "PHOEBE_AGENT", value: "codex" }]);
  });

  test("a fallback that lost is not listed as shadowed", () => {
    const leaf = leafAt(compute({ user: { readyLabel: "go" } }).fields, "readyLabel");
    expect(leaf.shadowed).toBeUndefined();
  });

  test("an env value is typed the way the config field holds it", () => {
    const fields = compute({
      env: { process: { PHOEBE_RUN_TIMEOUT_MS: "60000", PHOEBE_FEATURE_BRANCH_CATCH_UP: "false" } },
    }).fields;
    expect(leafAt(fields, "runTimeoutMs").value).toBe(60000);
    expect(leafAt(fields, "featureBranchCatchUp").value).toBe(false);
  });
});

describe("where an env value was set", () => {
  const layers: EnvLayers = {
    process: { PHOEBE_READY_LABEL: "from-process", PHOEBE_BRANCH_PREFIX: "p/" },
    root: { PHOEBE_READY_LABEL: "from-root" },
    tenant: { PHOEBE_READY_LABEL: "from-tenant" },
  };

  test("the most specific layer that set it wins, and says so", () => {
    expect(leafAt(compute({ env: layers }).fields, "readyLabel")).toMatchObject({
      value: "from-tenant",
      from: "tenantEnv",
    });
  });

  test("a name only the process holds is attributed to the process", () => {
    expect(leafAt(compute({ env: layers }).fields, "branchPrefix").from).toBe("process");
  });

  test("a blank value in a file never overwrites one the process has", () => {
    const fields = compute({
      env: { process: { PHOEBE_READY_LABEL: "kept" }, tenant: { PHOEBE_READY_LABEL: "" } },
    }).fields;
    expect(leafAt(fields, "readyLabel")).toMatchObject({ value: "kept", from: "process" });
  });
});

describe("the provider-relative leaves", () => {
  test("model falls through to the active provider's entry, and says it is derived", () => {
    const leaf = leafAt(compute({ user: { defaultProvider: "codex" } }).fields, "model");
    expect(leaf).toMatchObject({ source: "derived", via: "defaultModels.codex" });
    expect(leaf.value).toBe("gpt-5.4-mini");
  });

  test("the derivation follows a provider an env var flipped", () => {
    const leaf = leafAt(
      compute({ env: { process: { PHOEBE_DEFAULT_PROVIDER: "claude" } } }).fields,
      "model",
    );
    expect(leaf.via).toBe("defaultModels.claude");
  });

  test("effort is unset when no provider entry names one", () => {
    expect(leafAt(compute({}).fields, "effort")).toMatchObject({ value: null, source: "default" });
  });
});

describe("a kind's leaves", () => {
  const withBlock = (block: Record<string, unknown>) => ({
    pipelines: { work: { kinds: { reviews: block } } },
  });

  test("a kind with no block inherits from the tenant leaf, and names the path", () => {
    const leaf = leafAt(compute({}).fields, "pipelines.work.kinds.reviews.model");
    expect(leaf).toMatchObject({ source: "inherited", via: "model", value: "composer-2.5" });
  });

  test("a kind's own block beats the tenant leaf and shadows it", () => {
    const leaf = leafAt(
      compute({ user: withBlock({ model: "kind-model" }) }).fields,
      "pipelines.work.kinds.reviews.model",
    );
    expect(leaf).toMatchObject({ value: "kind-model", source: "file" });
    expect(leaf.shadowed?.[0]).toMatchObject({ source: "inherited", via: "model" });
  });

  test("the per-kind env name beats the kind's block", () => {
    const leaf = leafAt(
      compute({
        user: withBlock({ model: "kind-model" }),
        env: { process: { PHOEBE_REVIEWS_MODEL: "env-model" } },
      }).fields,
      "pipelines.work.kinds.reviews.model",
    );
    expect(leaf).toMatchObject({
      value: "env-model",
      source: "overlay",
      via: "PHOEBE_REVIEWS_MODEL",
    });
    expect(leaf.shadowed?.[0]).toMatchObject({ source: "file", value: "kind-model" });
  });

  test("a per-kind alias reads as an alias", () => {
    expect(
      leafAt(
        compute({ env: { process: { PHOEBE_REVIEWS_AGENT: "claude" } } }).fields,
        "pipelines.work.kinds.reviews.provider",
      ),
    ).toMatchObject({ value: "claude", source: "alias", via: "PHOEBE_REVIEWS_AGENT" });
  });

  test("a block speaking for another provider drops below the inherited value", () => {
    // The block names `claude`; an env var moved the run to `codex`, so the
    // block's claude-specific model must not reach the codex CLI.
    const leaf = leafAt(
      compute({
        user: withBlock({ provider: "claude", model: "claude-only" }),
        env: { process: { PHOEBE_REVIEWS_PROVIDER: "codex" } },
      }).fields,
      "pipelines.work.kinds.reviews.model",
    );
    expect(leaf).toMatchObject({ source: "inherited", via: "model" });
    expect(leaf.shadowed).toEqual([{ source: "file", via: CONFIG_PATH, value: "claude-only" }]);
  });

  test("the forced base is env-only, and only under the issues kind", () => {
    const fields = compute({ env: { process: { PHOEBE_BASE: "release/2" } } }).fields;
    expect(leafAt(fields, "pipelines.work.kinds.issues.base")).toMatchObject({
      value: "release/2",
      source: "overlay",
      via: "PHOEBE_BASE",
    });
    expect((fields?.["pipelines"] as EffectiveFields)["work"]).toBeTruthy();
    expect(
      ((fields?.["pipelines"] as EffectiveFields)["work"] as EffectiveFields)["kinds"],
    ).toBeTruthy();
    const reviews = (
      ((fields?.["pipelines"] as EffectiveFields)["work"] as EffectiveFields)[
        "kinds"
      ] as EffectiveFields
    )["reviews"] as EffectiveFields;
    expect(reviews["base"]).toBeUndefined();
  });

  test("a prompt file still declared through the retired block reads as an alias", () => {
    expect(
      leafAt(
        compute({ user: { promptFiles: { reviews: "prompts/mine.md" } } }).fields,
        "pipelines.work.kinds.reviews.promptFile",
      ),
    ).toMatchObject({ source: "alias", via: "promptFiles.reviews", value: "prompts/mine.md" });
  });
});

describe("a pipeline's leaves", () => {
  test("a named pipeline inherits the cadence from the tenant leaf the env name sets", () => {
    const fields = compute({
      user: { pipelines: { intake: {} } },
      env: { process: { PHOEBE_POLL_INTERVAL_MS: "15000" } },
    }).fields;
    expect(leafAt(fields, "pipelines.intake.pollIntervalMs")).toMatchObject({
      value: 15000,
      source: "inherited",
      via: "pollIntervalMs",
    });
  });

  test("a pipeline's own cadence is the more specific path and wins", () => {
    const leaf = leafAt(
      compute({
        user: { pipelines: { intake: { pollIntervalMs: 900 } } },
        env: { process: { PHOEBE_POLL_INTERVAL_MS: "15000" } },
      }).fields,
      "pipelines.intake.pollIntervalMs",
    );
    expect(leaf).toMatchObject({ value: 900, source: "file" });
    expect(leaf.shadowed?.[0]).toMatchObject({ source: "inherited", value: 15000 });
  });

  test("an undeclared order is derived from the kinds the pipeline owns", () => {
    expect(leafAt(compute({}).fields, "pipelines.work.order")).toMatchObject({
      source: "derived",
      value: ["conflicts", "checks", "reviews", "issues", "research"],
    });
  });
});

describe("the bootstrapper's fields", () => {
  test("they carry a bootstrapper reader tag", () => {
    const fields = compute({ user: { configDir: ".phoebe" } }).fields;
    expect(leafAt(fields, "configDir")).toMatchObject({
      value: ".phoebe",
      source: "file",
      reader: "bootstrapper",
    });
    expect(leafAt(fields, "deployment.slotFloorBudget").reader).toBe("bootstrapper");
  });

  test("an unset slot cap is derived from the pipelines it would size for", () => {
    expect(
      leafAt(
        compute({ user: { pipelines: { work: { concurrency: 3 } } } }).fields,
        "deployment.slotCap",
      ),
    ).toMatchObject({ value: 3, source: "derived", via: "max(pipelines.*.concurrency)" });
  });

  test("a host knob's permanent alias still sets it", () => {
    expect(
      leafAt(
        compute({ env: { process: { PHOEBE_MAX_CONCURRENT_AGENTS: "6" } } }).fields,
        "deployment.slotCap",
      ),
    ).toMatchObject({ value: 6, source: "alias", via: "PHOEBE_MAX_CONCURRENT_AGENTS" });
  });
});

describe("a value that does not survive JSON", () => {
  test("an inline kind definition renders as a summary and is marked opaque", () => {
    const definition = { name: "nudger", fetch: () => [], run: () => undefined };
    const leaf = leafAt(
      compute({ user: { pipelines: { work: { kinds: { nudger: definition as never } } } } }).fields,
      "pipelines.work.kinds.nudger.definition",
    );
    expect(leaf.opaque).toBe(true);
    expect(String(leaf.value)).toContain("inline definition");
  });
});

describe("the env section", () => {
  test("reports presence and location, never a value", () => {
    const report = compute({
      env: { process: { GH_TOKEN: "ghp_secret" }, tenant: { CURSOR_API_KEY: "key_secret" } },
    });
    expect(report.env).toMatchObject({
      GH_TOKEN: { present: true, from: "process" },
      CURSOR_API_KEY: { present: true, from: "tenantEnv" },
      GH_APP_ID: { present: false },
    });
    expect(JSON.stringify(report.env)).not.toContain("secret");
  });

  test("a key a work kind declared is reported too", () => {
    const report = compute({ declaredEnv: ["SENTRY_AUTH_TOKEN"] });
    expect(report.env?.["SENTRY_AUTH_TOKEN"]).toEqual({ present: false });
  });

  test("a blank value is not presence", () => {
    expect(compute({ env: { process: { GH_TOKEN: "" } } }).env?.["GH_TOKEN"]).toEqual({
      present: false,
    });
  });

  test("the secret store is the tier above every file (#504)", () => {
    const report = compute({
      env: {
        process: { GH_TOKEN: "ambient" },
        tenant: { CURSOR_API_KEY: "file_key" },
        store: { CURSOR_API_KEY: "store_key" },
      },
    });
    expect(report.env?.["CURSOR_API_KEY"]).toEqual({
      present: true,
      from: "store",
      shadowed: true,
    });
    expect(JSON.stringify(report.env)).not.toContain("store_key");
  });

  test("a store key nothing else sets is not shadowing anything", () => {
    const report = compute({ env: { store: { CURSOR_API_KEY: "store_key" } } });
    expect(report.env?.["CURSOR_API_KEY"]).toEqual({ present: true, from: "store" });
  });

  test("a store entry no kind declares any more still gets a line", () => {
    const report = compute({ env: { store: { RETIRED_KEY: "x" } } });
    expect(report.env?.["RETIRED_KEY"]).toEqual({ present: true, from: "store" });
  });
});

describe("warnings", () => {
  test("an env alias in use is indexed at the path it set", () => {
    const report = compute({ env: { process: { PHOEBE_AGENT: "claude" } } });
    expect(report.warnings).toContainEqual({
      path: "defaultProvider",
      message: expect.stringContaining("PHOEBE_DEFAULT_PROVIDER") as unknown as string,
    });
  });

  test("a superseded config field is named with its replacement", () => {
    const report = compute({ user: { workOrder: ["issues"] } });
    expect(report.warnings).toContainEqual({
      path: "workOrder",
      message: expect.stringContaining("pipelines.work.order") as unknown as string,
    });
  });

  test("a config using neither warns about nothing", () => {
    expect(compute({}).warnings).toEqual([]);
  });
});

describe("a tenant whose config will not load", () => {
  test("an invalid config yields the error arm, not a throw", () => {
    const report = computeEffectiveConfig({
      user: { ...userConfig(), blockedByPattern: "Blocked by [" },
      configPath: CONFIG_PATH,
    });
    expect(report.fields).toBeNull();
    expect(report.env).toBeNull();
    expect(report.error).toMatch(/blockedByPattern/);
  });

  test("a required field supplied only by env is a working tenant, not a broken one", () => {
    const report = computeEffectiveConfig({
      user: { ...userConfig(), repoSlug: undefined as never },
      configPath: CONFIG_PATH,
      env: { process: { PHOEBE_REPO_SLUG: "acme/other" } },
    });
    expect(report.error).toBeNull();
    expect(leafAt(report.fields, "repoSlug")).toMatchObject({
      value: "acme/other",
      source: "overlay",
    });
  });

  test("the error arm can be built without a config at all", () => {
    expect(effectiveConfigError("tenants/widget", new Error("held — no config"))).toEqual({
      tenant: "tenants/widget",
      error: "held — no config",
      fields: null,
      env: null,
      warnings: [],
    });
  });
});

describe("the catalogue invariant", () => {
  test("every catalogued env name is reachable from some leaf in the view", () => {
    // #502's acceptance check: the view is keyed by the catalogue, so a setting
    // that exists but is not rendered would be a hole an operator cannot see.
    const report = compute({});
    const covered = new Set<string>();
    walkLeaves(report.fields!, (path) => {
      covered.add(path.replace(/^pipelines\.[a-z0-9-]+\.kinds\./, "kinds."));
      covered.add(path.replace(/^pipelines\.[a-z0-9-]+\./, ""));
      covered.add(path);
    });
    const missing = ["defaultProvider", "model", "effort", "runTimeoutMs", "pollIntervalMs"].filter(
      (path) => !covered.has(path),
    );
    expect(missing).toEqual([]);
    // Every kind-level name the catalogue derives has a home under each kind.
    expect(covered.has("kinds.reviews.provider")).toBe(true);
    expect(covered.has("kinds.issues.base")).toBe(true);
    // And the catalogue is not empty, which would pass the above vacuously.
    expect(catalogueEnvNames().length).toBeGreaterThan(40);
  });
});
