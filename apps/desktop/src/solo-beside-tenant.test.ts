import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { VerbIo } from "phoebe-agent/contracts";
import { initSoloBesideTenant, POINTER_SOURCE } from "./solo-beside-tenant.ts";
import { tenantFilesOf } from "./tenant-files.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const made: string[] = [];

function tenantFolder(config: string, env?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "phoebe-solo-beside-"));
  made.push(dir);
  writeFileSync(path.join(dir, "phoebe.config.ts"), config);
  if (env !== undefined) writeFileSync(path.join(dir, ".env"), env);
  return dir;
}

/** A workspace root pinned to `version`, with `widget/` as its tenant folder. */
function tenantUnderWorkspace(version: string, config: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "phoebe-solo-beside-ws-"));
  made.push(root);
  writeFileSync(
    path.join(root, "phoebe.config.ts"),
    `export default { workspace: { depth: 1 } };\n`,
  );
  mkdirSync(path.join(root, "container"));
  writeFileSync(
    path.join(root, "container", "Dockerfile"),
    `FROM node:24\nARG PHOEBE_AGENT_VERSION=${version}\n`,
  );
  const dir = path.join(root, "widget");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "phoebe.config.ts"), config);
  return dir;
}

function io(): VerbIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, stdout: (line) => lines.push(line), stderr: (line) => lines.push(`! ${line}`) };
}

function run(dir: string, out: VerbIo = io()) {
  return initSoloBesideTenant({
    install: dir,
    io: out,
    cliVersion: "1.2.3",
    deps: { packageRoot: PACKAGE_ROOT },
  });
}

const rootConfig = (dir: string): string =>
  readFileSync(path.join(dir, "phoebe.config.ts"), "utf8");
const nestedConfig = (dir: string): string =>
  readFileSync(path.join(dir, ".phoebe", "phoebe.config.ts"), "utf8");

const TENANT = `import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "pnpm install",
  checkCommand: "pnpm check",
  testCommand: "pnpm test",
  defaultBranch: "develop",

  // Spend where the agent reconstructs intent.
  pipelines: {
    work: { kinds: { issues: { effort: "high" } } },
  },
};

export default config;
`;

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a tenant's folder given a deployment of its own", () => {
  test("scaffolds into .phoebe/, moves the tenant's config there whole, and leaves a pointer", () => {
    const dir = tenantFolder(TENANT, "GH_TOKEN=ghp_x\n");
    const out = io();

    const outcome = run(dir, out);

    expect(outcome.profile).toBe("solo");
    expect(outcome.created).toContain("phoebe.config.ts");
    expect(existsSync(path.join(dir, ".phoebe", "container", "compose.yml"))).toBe(true);

    // The config is the tenant's own, every word: the nested block and the
    // comment a copy of top-level settings could never carry.
    const solo = nestedConfig(dir);
    expect(solo).toContain('repoSlug: "acme/widget"');
    expect(solo).toContain('defaultBranch: "develop"');
    expect(solo).toContain("// Spend where the agent reconstructs intent.");
    expect(solo).toContain('issues: { effort: "high" }');
    expect(solo).not.toContain("your-org/your-repo");
    expect(solo).not.toContain("configDir");
    // And it gains what only a deployment says, from the scaffold.
    expect(solo).toContain('engine: { source: "github", ref: "main" }');
    expect(solo).toContain("reporting: { maintainers: false }");

    // The root says where the config is and nothing else.
    expect(rootConfig(dir)).toBe(POINTER_SOURCE);
    expect(rootConfig(dir)).not.toContain("repoSlug");

    // One config, for the workspace and the deployment both.
    expect(tenantFilesOf(dir)).toEqual({
      rootConfigPath: path.join(dir, "phoebe.config.ts"),
      configPath: path.join(dir, ".phoebe", "phoebe.config.ts"),
      envPath: path.join(dir, ".phoebe", ".env"),
    });

    expect(readFileSync(path.join(dir, ".phoebe", ".env"), "utf8")).toBe("GH_TOKEN=ghp_x\n");
    expect(out.lines.some((line) => line.includes("moved    phoebe.config.ts"))).toBe(true);
    expect(out.lines.some((line) => line.includes("added    engine, reporting"))).toBe(true);
    expect(out.lines.some((line) => line.startsWith("!"))).toBe(false);
  });

  test("a second run changes nothing: init keeps its files, and the root is already a pointer", () => {
    const dir = tenantFolder(TENANT, "GH_TOKEN=ghp_x\n");
    run(dir);
    const soloBefore = nestedConfig(dir);
    const rootBefore = rootConfig(dir);
    const out = io();

    const again = run(dir, out);

    expect(again.created).toEqual([]);
    expect(nestedConfig(dir)).toBe(soloBefore);
    expect(rootConfig(dir)).toBe(rootBefore);
    expect(out.lines.some((line) => line.includes("it already points at"))).toBe(true);
    expect(out.lines.some((line) => /moved|carried|copied|wrote/.test(line))).toBe(false);
  });

  test("a tenant that already keeps its assets in .phoebe/ moves the same way", () => {
    const dir = tenantFolder(
      TENANT.replace('  defaultBranch: "develop",', '  configDir: ".phoebe",'),
    );

    run(dir);

    expect(rootConfig(dir)).toBe(POINTER_SOURCE);
    expect(nestedConfig(dir)).toContain('repoSlug: "acme/widget"');
    expect(nestedConfig(dir)).not.toContain("configDir");
  });

  test("a deployment field the tenant already declares is kept over the scaffold's", () => {
    const dir = tenantFolder(
      TENANT.replace(
        '  defaultBranch: "develop",',
        '  engine: { source: "github", ref: "v9.9.9" },',
      ),
    );
    const out = io();

    run(dir, out);

    expect(nestedConfig(dir)).toContain('ref: "v9.9.9"');
    expect(nestedConfig(dir)).not.toContain('ref: "main"');
    expect(out.lines.some((line) => line.includes("added    reporting from"))).toBe(true);
  });
});

describe("a move that would break the tenant is refused, and the settings are copied", () => {
  /** What the refusals have in common: both files stand, and the root still has its fields. */
  function expectCopied(dir: string, out: { lines: string[] }): void {
    expect(rootConfig(dir)).toContain('repoSlug: "acme/widget"');
    expect(nestedConfig(dir)).toContain('repoSlug: "acme/widget"');
    expect(tenantFilesOf(dir).configPath).toBe(path.join(dir, "phoebe.config.ts"));
    expect(out.lines.some((line) => line.includes("carried  repoSlug"))).toBe(true);
    expect(out.lines.some((line) => line.includes("left     phoebe.config.ts where it is"))).toBe(
      true,
    );
    expect(out.lines.some((line) => line.includes("has two configs now"))).toBe(true);
  }

  test("a config that names a file relative to itself", () => {
    const dir = tenantFolder(
      TENANT.replace(
        'issues: { effort: "high" }',
        'issues: { effort: "high", promptFile: "./prompts/issues.md" }',
      ),
    );
    const out = io();

    run(dir, out);

    expectCopied(dir, out);
    expect(rootConfig(dir)).toContain('configDir: ".phoebe"');
    expect(
      out.lines.some((line) => line.startsWith("!") && line.includes("./prompts/issues.md")),
    ).toBe(true);
  });

  test("a tenant entry that already names another configDir is left as it is", () => {
    const dir = tenantFolder(
      TENANT.replace('  defaultBranch: "develop",', '  configDir: "deploy",'),
    );
    const out = io();

    run(dir, out);

    expectCopied(dir, out);
    expect(rootConfig(dir)).toContain('configDir: "deploy"');
    expect(rootConfig(dir)).not.toContain('configDir: ".phoebe"');
  });

  test("a config already under .phoebe/ keeps every value it has", () => {
    const dir = tenantFolder(TENANT);
    mkdirSync(path.join(dir, ".phoebe"));
    const theirs = `export default { repoSlug: "acme/widget", defaultBranch: "main" };\n`;
    writeFileSync(path.join(dir, ".phoebe", "phoebe.config.ts"), theirs);
    const out = io();

    run(dir, out);

    expect(nestedConfig(dir)).toContain('defaultBranch: "main"');
    expect(rootConfig(dir)).toContain('repoSlug: "acme/widget"');
    expect(rootConfig(dir)).toContain('configDir: ".phoebe"');
    // Somebody's layout, reported and not a fault.
    expect(out.lines.some((line) => line.includes("was already there"))).toBe(true);
    expect(out.lines.some((line) => line.startsWith("!"))).toBe(false);
  });

  test("a workspace above on an older phoebe-agent, which may hold a pointer", () => {
    const dir = tenantUnderWorkspace("1.2.2", TENANT);
    const out = io();

    run(dir, out);

    expectCopied(dir, out);
    expect(
      out.lines.some((line) => line.startsWith("!") && line.includes("phoebe-agent 1.2.2")),
    ).toBe(true);
  });

  test("a workspace above on this companion's version or later is moved under", () => {
    for (const version of ["1.2.3", "1.3.0"]) {
      const dir = tenantUnderWorkspace(version, TENANT);

      run(dir);

      expect(rootConfig(dir)).toBe(POINTER_SOURCE);
    }
  });
});

describe("the files around the config", () => {
  test("a .env already under .phoebe/ is not overwritten by the root's", () => {
    const dir = tenantFolder(TENANT, "GH_TOKEN=root\n");
    mkdirSync(path.join(dir, ".phoebe"));
    writeFileSync(path.join(dir, ".phoebe", ".env"), "GH_TOKEN=nested\n");

    run(dir);

    expect(readFileSync(path.join(dir, ".phoebe", ".env"), "utf8")).toBe("GH_TOKEN=nested\n");
  });

  test("a folder with no tenant config is refused before anything is written", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "phoebe-solo-beside-"));
    made.push(dir);

    expect(() => run(dir)).toThrow("no tenant here");
    expect(existsSync(path.join(dir, ".phoebe"))).toBe(false);
  });
});
