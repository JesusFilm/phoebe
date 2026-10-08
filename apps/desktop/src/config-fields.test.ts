import { describe, expect, test } from "vite-plus/test";
import { configFieldsOf, LOCAL_OPEN_PATHS, type ConfigRole } from "./config-fields.ts";

const config = (body: string): string => `export default defineConfig({\n${body}\n});\n`;

const ROOT = config(
  '  engine: { source: "github", ref: "main" },\n  reporting: { maintainers: false },\n  workspace: { depth: 2 },',
);

function field(source: string, path: string, role: ConfigRole = "tenant") {
  return configFieldsOf(source, role).find((candidate) => candidate.path === path);
}

describe("a tenant's settings", () => {
  test("a literal in the file is the field's value, with its type and env name", () => {
    const source = config('  repoSlug: "acme/widget",\n  featureBranchCatchUp: true,');

    expect(field(source, "repoSlug")).toMatchObject({
      scope: "tenant",
      type: "string",
      env: "PHOEBE_REPO_SLUG",
      state: "set",
      value: "acme/widget",
    });
    expect(field(source, "featureBranchCatchUp")).toMatchObject({
      type: "boolean",
      state: "set",
      value: true,
    });
  });

  test("a setting the file does not name is unset, and says what applies instead", () => {
    const source = config('  repoSlug: "acme/widget",');

    expect(field(source, "defaultBranch")).toMatchObject({ state: "unset", default: "main" });
    expect(field(source, "defaultBranch")).not.toHaveProperty("value");
    // No default to state is no default stated.
    expect(field(source, "checkCommand")).not.toHaveProperty("default");
  });

  test("an enum carries the values it accepts", () => {
    const source = config('  prScope: "all",');

    expect(field(source, "prScope")).toMatchObject({
      type: "enum",
      values: ["phoebe", "all"],
      state: "set",
      value: "all",
    });
  });

  test("a text setting with values worth offering carries them, and stays a text setting", () => {
    const source = config('  repoSlug: "acme/widget",');

    expect(field(source, "model")).toMatchObject({
      type: "string",
      suggestions: ["composer-2.5", "claude-sonnet-5-5", "gpt-5.4-mini"],
    });
    expect(field(source, "effort")?.suggestions).toContain("xhigh");
    expect(field(source, "repoSlug")).not.toHaveProperty("suggestions");
  });

  test("a computed value is handed over as written, not as a value to replace", () => {
    const source = config("  repoSlug: process.env.SLUG!,");

    expect(field(source, "repoSlug")).toMatchObject({ state: "computed" });
    expect(field(source, "repoSlug")?.raw).toContain("process.env.SLUG");
    expect(field(source, "repoSlug")).not.toHaveProperty("value");
  });

  test("leaves out what a form could not write, and everything that is the root's", () => {
    const paths = configFieldsOf(config('  repoSlug: "acme/widget",'), "tenant").map(
      (one) => one.path,
    );

    expect(paths).toContain("repoSlug");
    expect(paths).not.toContain("pollIntervalMs");
    expect(paths.some((path) => path.includes("."))).toBe(false);
  });
});

describe("a workspace root's settings", () => {
  test("are the deployment's alone: the engine, reporting and the fleet", () => {
    const fields = configFieldsOf(ROOT, "workspace");

    expect(fields.map((one) => one.path)).toEqual([
      "engine.source",
      "engine.repo",
      "engine.ref",
      "reporting.maintainers",
      "reporting.dsn",
      "reporting.includeRef",
      "workspace.depth",
    ]);
    expect(fields.every((one) => one.scope === "deployment")).toBe(true);
  });

  test("the engine is open, each row by its own way in", () => {
    // Where it comes from is a choice of two; the repository offers the default
    // and takes any; both are written by `config set`, which is let into them.
    expect(field(ROOT, "engine.source", "workspace")).toMatchObject({
      type: "enum",
      values: ["github", "local"],
      state: "set",
      value: "github",
    });
    expect(field(ROOT, "engine.repo", "workspace")).toMatchObject({
      state: "unset",
      default: "JesusFilm/phoebe",
      suggestions: ["JesusFilm/phoebe"],
    });
    expect(LOCAL_OPEN_PATHS).toEqual(["engine.source", "engine.repo"]);
    // The ref moves with `upgrade`, and offers the refs the caller knows.
    expect(field(ROOT, "engine.ref", "workspace")).toMatchObject({
      state: "set",
      value: "main",
      via: "upgrade",
      suggestions: ["main"],
    });
    expect(field(ROOT, "engine.ref", "workspace")).not.toHaveProperty("locked");
    const offered = configFieldsOf(ROOT, "workspace", { engineRefs: ["main", "v0.13.0"] });
    expect(offered.find((one) => one.path === "engine.ref")?.suggestions).toEqual([
      "main",
      "v0.13.0",
    ]);
  });

  test("the fleet is shown, locked, with the reason", () => {
    expect(field(ROOT, "workspace.depth", "workspace")).toMatchObject({
      value: 2,
      locked: expect.stringContaining("git edit"),
    });
  });

  test("reporting is the root's to change from here", () => {
    expect(field(ROOT, "reporting.maintainers", "workspace")).toMatchObject({
      type: "boolean",
      state: "set",
      value: false,
    });
    expect(field(ROOT, "reporting.maintainers", "workspace")).not.toHaveProperty("locked");
    expect(field(ROOT, "reporting.dsn", "workspace")).toMatchObject({ state: "unset" });
  });

  test("a locked row the file does not set is left out", () => {
    expect(field(ROOT, "workspace.tenants", "workspace")).toBeUndefined();
  });

  test("a declared fleet is shown as written", () => {
    const declared = config('  workspace: { tenants: ["a", "b"] },');

    expect(field(declared, "workspace.tenants", "workspace")).toMatchObject({
      state: "computed",
      raw: '["a", "b"]',
    });
  });

  test("a computed block costs its own rows and no others", () => {
    const source = config("  engine: engineFor(env),\n  reporting: { maintainers: true },");
    const paths = configFieldsOf(source, "workspace").map((one) => one.path);

    expect(paths).not.toContain("engine.ref");
    expect(paths).toContain("reporting.maintainers");
  });
});

describe("a solo install's one config", () => {
  test("has the deployment's rows, then the tenant's, and no fleet", () => {
    const source = config('  engine: { source: "github", ref: "main" },\n  repoSlug: "acme/a",');
    const fields = configFieldsOf(source, "solo");

    expect(fields[0]).toMatchObject({ path: "engine.source", scope: "deployment" });
    expect(fields.find((one) => one.path === "repoSlug")).toMatchObject({ scope: "tenant" });
    expect(fields.some((one) => one.path.startsWith("workspace."))).toBe(false);
  });
});

describe("a config that will not parse", () => {
  test("offers no form at all, whoever's it is", () => {
    for (const role of ["workspace", "tenant", "solo"] as const) {
      expect(configFieldsOf("export default defineConfig({", role), role).toEqual([]);
    }
  });
});
