// `phoebe config` — the I/O half (#531): which configs it reads, what it does
// with one that will not load, and what the two output modes say.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import {
  collectEffectiveConfig,
  everyTenantErrored,
  formatEffectiveConfig,
  parseConfigArgs,
  type EffectiveConfigReport,
} from "./config-command.ts";
import {
  EFFECTIVE_CONFIG_VERSION,
  type TenantEffectiveConfig,
} from "./contracts/effective-config.ts";
import { writeSecretStore } from "./secret-store.ts";

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-config-"));
  temps.push(dir);
  return dir;
}

/** Write a tenant config into `dir` and return its path. */
function writeConfig(dir: string, body: string): string {
  const path = join(dir, "phoebe.config.ts");
  writeFileSync(path, body);
  return path;
}

const TENANT_CONFIG = (slug: string, extra = ""): string =>
  `export const config = {
  repoSlug: ${JSON.stringify(slug)},
  repoUrl: "https://github.com/${slug}.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",${extra}
};
`;

async function collect(configPath: string, processEnv: NodeJS.ProcessEnv = {}) {
  return await collectEffectiveConfig({ configPath, dataBase: "/data/repos", processEnv });
}

describe("parseConfigArgs", () => {
  test("defaults to human output against the config under cwd", () => {
    expect(parseConfigArgs([])).toEqual({ help: false, json: false });
  });

  test("takes --json and --config", () => {
    expect(parseConfigArgs(["--json", "--config", "a/phoebe.config.ts"])).toEqual({
      help: false,
      json: true,
      configPath: "a/phoebe.config.ts",
    });
  });

  test("rejects a flag it does not know rather than ignoring it", () => {
    expect(() => parseConfigArgs(["--jsonn"])).toThrow(/Unknown flag/);
  });
});

describe("collecting one tenant", () => {
  test("a solo deployment reports itself, named by its slug", async () => {
    const dir = tempDir();
    const report = await collect(writeConfig(dir, TENANT_CONFIG("acme/widget")));
    expect(report.version).toBe(EFFECTIVE_CONFIG_VERSION);
    expect(report.tenants).toHaveLength(1);
    expect(report.tenants[0]).toMatchObject({ tenant: "acme/widget", error: null });
  });

  test("the tenant's own .env is read, and reported as its location", async () => {
    const dir = tempDir();
    const path = writeConfig(dir, TENANT_CONFIG("acme/widget"));
    writeFileSync(join(dir, ".env"), "GH_TOKEN=ghp_from_file\nPHOEBE_READY_LABEL=from-file\n");
    const report = await collect(path);
    const tenant = report.tenants[0]!;
    expect(tenant.env?.["GH_TOKEN"]).toEqual({ present: true, from: "tenantEnv" });
    expect(JSON.stringify(tenant)).not.toContain("ghp_from_file");
    expect(tenant.fields?.["readyLabel"]).toMatchObject({
      value: "from-file",
      source: "overlay",
      from: "tenantEnv",
    });
  });

  test("configDir relocates where that .env is looked for", async () => {
    const dir = tempDir();
    const path = writeConfig(dir, TENANT_CONFIG("acme/widget", `\n  configDir: ".phoebe",`));
    mkdirSync(join(dir, ".phoebe"));
    writeFileSync(join(dir, ".phoebe", ".env"), "GH_TOKEN=x\n");
    const report = await collect(path);
    expect(report.tenants[0]!.env?.["GH_TOKEN"]).toEqual({ present: true, from: "tenantEnv" });
  });

  test("a config that will not load is the error arm, not a crash", async () => {
    const dir = tempDir();
    const path = writeConfig(dir, "export const config = { repoSlug: 1 };\n");
    const report = await collect(path);
    expect(report.tenants[0]).toMatchObject({ fields: null, env: null });
    expect(report.tenants[0]!.error).toBeTruthy();
  });
});

describe("collecting a workspace", () => {
  /** A root with two children, one of them broken. */
  function workspace(): string {
    const root = tempDir();
    writeFileSync(
      join(root, "phoebe.config.ts"),
      `export const config = { workspace: { depth: 1 } };\n`,
    );
    writeFileSync(join(root, ".env"), "GH_APP_ID=42\n");
    for (const [name, body] of [
      ["good", TENANT_CONFIG("acme/good")],
      ["broken", "export const config = { repoSlug: 1 };\n"],
    ] as const) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "phoebe.config.ts"), body);
    }
    return join(root, "phoebe.config.ts");
  }

  test("every child is a row, working and broken alike", async () => {
    const report = await collect(workspace());
    expect(
      report.tenants.map((tenant) => tenant.error === null).sort((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
  });

  test("the root .env is a location a child's value can name", async () => {
    const report = await collect(workspace());
    const good = report.tenants.find((tenant) => tenant.error === null)!;
    expect(good.env?.["GH_APP_ID"]).toEqual({ present: true, from: "rootEnv" });
  });
});

// --- output -----------------------------------------------------------------

const REPORT: EffectiveConfigReport = {
  version: EFFECTIVE_CONFIG_VERSION,
  tenants: [
    {
      tenant: "acme/widget",
      error: null,
      fields: {
        readyLabel: {
          value: "now",
          source: "overlay",
          via: "PHOEBE_READY_LABEL",
          from: "tenantEnv",
          reader: "engine",
          shadowed: [{ source: "file", via: "/etc/phoebe/phoebe.config.ts", value: "go" }],
        },
        pipelines: {
          work: {
            concurrency: { value: 1, source: "default", reader: "engine" },
            kinds: {
              reviews: {
                model: { value: "m", source: "inherited", via: "model", reader: "engine" },
              },
            },
          },
        },
      },
      env: { GH_TOKEN: { present: true, from: "tenantEnv" }, CURSOR_API_KEY: { present: false } },
      warnings: [{ path: "workOrder", message: "moved to `pipelines.work.order`" }],
    } satisfies TenantEffectiveConfig,
  ],
};

describe("the human report", () => {
  const text = formatEffectiveConfig(REPORT, "/etc/phoebe");

  test("one line per leaf, carrying its path, value and source", () => {
    expect(text).toContain(`  readyLabel = "now"  (overlay via PHOEBE_READY_LABEL from tenantEnv)`);
  });

  test("a shadowed value prints under its winner", () => {
    expect(text).toContain(`    shadowed: (file via phoebe.config.ts) = "go"`);
  });

  test("pipelines and their kinds indent", () => {
    const concurrency = text
      .split("\n")
      .find((line) => line.includes("pipelines.work.concurrency"))!;
    const model = text.split("\n").find((line) => line.includes("kinds.reviews.model"))!;
    expect(concurrency.length - concurrency.trimStart().length).toBe(6);
    expect(model.length - model.trimStart().length).toBe(10);
  });

  test("the env section says present or missing, never a value", () => {
    expect(text).toContain("    GH_TOKEN — present (tenantEnv)");
    expect(text).toContain("    CURSOR_API_KEY — missing");
  });

  test("warnings are their own section", () => {
    expect(text).toContain("  warnings");
    expect(text).toContain("    workOrder: moved to `pipelines.work.order`");
  });

  test("an errored tenant prints its error and nothing else", () => {
    const text = formatEffectiveConfig({
      version: EFFECTIVE_CONFIG_VERSION,
      tenants: [
        {
          tenant: "tenants/held",
          error: "held — no config",
          fields: null,
          env: null,
          warnings: [],
        },
      ],
    });
    expect(text).toContain("tenants/held\n  error: held — no config");
  });
});

describe("the exit code", () => {
  const rows = (...errors: (string | null)[]): EffectiveConfigReport => ({
    version: EFFECTIVE_CONFIG_VERSION,
    tenants: errors.map((error, index) => ({
      tenant: `t${index}`,
      error,
      fields: null,
      env: null,
      warnings: [],
    })),
  });

  test("one broken tenant beside a working one is a finding, not a failure", () => {
    expect(everyTenantErrored(rows("broken", null))).toBe(false);
  });

  test("every tenant broken is a failed command", () => {
    expect(everyTenantErrored(rows("broken", "also broken"))).toBe(true);
  });

  test("no tenants at all is not a failure", () => {
    expect(everyTenantErrored(rows())).toBe(false);
  });
});

describe("the JSON report", () => {
  test("survives the round trip a console does", () => {
    const parsed = JSON.parse(JSON.stringify(REPORT)) as EffectiveConfigReport;
    expect(parsed.version).toBe(EFFECTIVE_CONFIG_VERSION);
    expect(parsed.tenants[0]!.fields).toBeTruthy();
  });
});

describe("the secret store in the env section (#504)", () => {
  test("a store-set key reports its tier and the file it shadows", async () => {
    const dir = tempDir();
    const dataBase = join(dir, "data");
    mkdirSync(join(dataBase, "acme", "widget", "state"), { recursive: true });
    writeSecretStore(join(dataBase, "acme", "widget", "state"), { CURSOR_API_KEY: "sk-store" });
    const configPath = writeConfig(dir, TENANT_CONFIG("acme/widget"));
    writeFileSync(join(dir, ".env"), "CURSOR_API_KEY=sk-file\n");

    const report = await collectEffectiveConfig({ configPath, dataBase, processEnv: {} });
    expect(report.tenants[0]?.env?.["CURSOR_API_KEY"]).toEqual({
      present: true,
      from: "store",
      shadowed: true,
    });
    expect(JSON.stringify(report)).not.toContain("sk-store");
  });

  test("the printed line names the collision, so an inert .env edit is explained", async () => {
    const dir = tempDir();
    const dataBase = join(dir, "data");
    mkdirSync(join(dataBase, "acme", "widget", "state"), { recursive: true });
    writeSecretStore(join(dataBase, "acme", "widget", "state"), { CURSOR_API_KEY: "sk-store" });
    const configPath = writeConfig(dir, TENANT_CONFIG("acme/widget"));
    writeFileSync(join(dir, ".env"), "CURSOR_API_KEY=sk-file\n");

    const text = formatEffectiveConfig(
      await collectEffectiveConfig({ configPath, dataBase, processEnv: {} }),
    );
    expect(text).toContain("CURSOR_API_KEY — present (store) — shadowed");
    expect(text).not.toContain("sk-store");
  });

  test("a deployment with no store reads exactly as it did before there was one", async () => {
    const dir = tempDir();
    const configPath = writeConfig(dir, TENANT_CONFIG("acme/widget"));
    writeFileSync(join(dir, ".env"), "CURSOR_API_KEY=sk-file\n");
    const report = await collectEffectiveConfig({
      configPath,
      dataBase: join(dir, "data"),
      processEnv: {},
    });
    expect(report.tenants[0]?.env?.["CURSOR_API_KEY"]).toEqual({
      present: true,
      from: "tenantEnv",
    });
  });
});
