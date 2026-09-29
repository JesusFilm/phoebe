import { describe, expect, test } from "vite-plus/test";
import { configFieldsOf } from "./config-fields.ts";

const config = (body: string): string => `export default defineConfig({\n${body}\n});\n`;

function field(source: string, path: string) {
  return configFieldsOf(source).find((candidate) => candidate.path === path);
}

describe("the settings a config form offers", () => {
  test("a literal in the file is the field's value, with its type and env name", () => {
    const source = config('  repoSlug: "acme/widget",\n  featureBranchCatchUp: true,');

    expect(field(source, "repoSlug")).toMatchObject({
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

  test("a computed value is handed over as written, not as a value to replace", () => {
    const source = config("  repoSlug: process.env.SLUG!,");

    expect(field(source, "repoSlug")).toMatchObject({ state: "computed" });
    expect(field(source, "repoSlug")?.raw).toContain("process.env.SLUG");
    expect(field(source, "repoSlug")).not.toHaveProperty("value");
  });

  test("leaves out what a form could not write: env-only settings and the deployment block", () => {
    const paths = configFieldsOf(config('  repoSlug: "acme/widget",')).map((one) => one.path);

    expect(paths).toContain("repoSlug");
    expect(paths).not.toContain("pollIntervalMs");
    expect(paths.some((path) => path.includes("."))).toBe(false);
  });

  test("a config that will not parse offers no form at all", () => {
    expect(configFieldsOf("export default defineConfig({")).toEqual([]);
  });
});
