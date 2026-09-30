import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { VerbIo } from "phoebe-agent/contracts";
import { initSoloBesideTenant } from "./solo-beside-tenant.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const made: string[] = [];

function tenantFolder(config: string, env?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "phoebe-solo-beside-"));
  made.push(dir);
  writeFileSync(path.join(dir, "phoebe.config.ts"), config);
  if (env !== undefined) writeFileSync(path.join(dir, ".env"), env);
  return dir;
}

function io(): VerbIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, stdout: (line) => lines.push(line), stderr: (line) => lines.push(`! ${line}`) };
}

const TENANT = `import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "pnpm install",
  checkCommand: "pnpm check",
  testCommand: "pnpm test",
  defaultBranch: "develop",
};

export default config;
`;

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a tenant's folder given a deployment of its own", () => {
  test("scaffolds into .phoebe/, carries the tenant's settings, and points the entry at it", () => {
    const dir = tenantFolder(TENANT, "GH_TOKEN=ghp_x\n");
    const out = io();

    const outcome = initSoloBesideTenant({
      install: dir,
      io: out,
      cliVersion: "1.2.3",
      deps: { packageRoot: PACKAGE_ROOT },
    });

    expect(outcome.profile).toBe("solo");
    expect(outcome.created).toContain("phoebe.config.ts");
    expect(existsSync(path.join(dir, ".phoebe", "container", "compose.yml"))).toBe(true);

    const solo = readFileSync(path.join(dir, ".phoebe", "phoebe.config.ts"), "utf8");
    expect(solo).toContain('repoSlug: "acme/widget"');
    expect(solo).toContain('repoUrl: "https://github.com/acme/widget.git"');
    expect(solo).toContain('installCommand: "pnpm install"');
    expect(solo).toContain('defaultBranch: "develop"');
    expect(solo).not.toContain("your-org/your-repo");

    const tenant = readFileSync(path.join(dir, "phoebe.config.ts"), "utf8");
    expect(tenant).toContain('configDir: ".phoebe"');
    // The tenant keeps everything else it said.
    expect(tenant).toContain('repoSlug: "acme/widget"');

    expect(readFileSync(path.join(dir, ".phoebe", ".env"), "utf8")).toBe("GH_TOKEN=ghp_x\n");
    expect(out.lines.some((line) => line.includes("carried  repoSlug"))).toBe(true);
    expect(out.lines.some((line) => line.includes('configDir: ".phoebe"'))).toBe(true);
  });

  test("a second run changes nothing: init keeps its files, and the entry is already pointed", () => {
    const dir = tenantFolder(TENANT);
    initSoloBesideTenant({
      install: dir,
      io: io(),
      cliVersion: "1.2.3",
      deps: { packageRoot: PACKAGE_ROOT },
    });
    const soloBefore = readFileSync(path.join(dir, ".phoebe", "phoebe.config.ts"), "utf8");
    const tenantBefore = readFileSync(path.join(dir, "phoebe.config.ts"), "utf8");
    const out = io();

    const again = initSoloBesideTenant({
      install: dir,
      io: out,
      cliVersion: "1.2.3",
      deps: { packageRoot: PACKAGE_ROOT },
    });

    expect(again.created).toEqual([]);
    expect(readFileSync(path.join(dir, ".phoebe", "phoebe.config.ts"), "utf8")).toBe(soloBefore);
    expect(readFileSync(path.join(dir, "phoebe.config.ts"), "utf8")).toBe(tenantBefore);
    expect(out.lines.some((line) => line.includes("kept     configDir"))).toBe(true);
  });

  test("a tenant entry that already names a configDir is left as it is", () => {
    const dir = tenantFolder(
      TENANT.replace('  defaultBranch: "develop",', '  configDir: "deploy",'),
    );

    initSoloBesideTenant({
      install: dir,
      io: io(),
      cliVersion: "1.2.3",
      deps: { packageRoot: PACKAGE_ROOT },
    });

    expect(readFileSync(path.join(dir, "phoebe.config.ts"), "utf8")).toContain(
      'configDir: "deploy"',
    );
  });

  test("a .env already under .phoebe/ is not overwritten by the root's", () => {
    const dir = tenantFolder(TENANT, "GH_TOKEN=root\n");
    mkdirSync(path.join(dir, ".phoebe"));
    writeFileSync(path.join(dir, ".phoebe", ".env"), "GH_TOKEN=nested\n");

    initSoloBesideTenant({
      install: dir,
      io: io(),
      cliVersion: "1.2.3",
      deps: { packageRoot: PACKAGE_ROOT },
    });

    expect(readFileSync(path.join(dir, ".phoebe", ".env"), "utf8")).toBe("GH_TOKEN=nested\n");
  });

  test("a folder with no tenant config is refused before anything is written", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "phoebe-solo-beside-"));
    made.push(dir);

    expect(() =>
      initSoloBesideTenant({
        install: dir,
        io: io(),
        cliVersion: "1.2.3",
        deps: { packageRoot: PACKAGE_ROOT },
      }),
    ).toThrow("no tenant here");
    expect(existsSync(path.join(dir, ".phoebe"))).toBe(false);
  });
});
