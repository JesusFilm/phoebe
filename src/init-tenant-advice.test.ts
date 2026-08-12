// Advisory registration hints for `phoebe init --tenant` (#142).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  formatInitTenantRegistrationAdvice,
  formatTenantListEntry,
  resolveInitTenantRootState,
} from "./init-tenant-advice.ts";

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-init-tenant-"));
  tempDirs.push(dir);
  return dir;
}

describe("formatTenantListEntry", () => {
  test("uses a relative path without ./ when the child is inside the root", () => {
    const root = makeTempDir();
    const child = join(root, "widget");
    mkdirSync(child);
    expect(formatTenantListEntry(root, child)).toBe("widget");
  });

  test("uses an absolute POSIX path when the child is outside the root", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    const entry = formatTenantListEntry(root, outside);
    expect(entry).toBe(resolve(outside).split("\\").join("/"));
    expect(entry.startsWith("..")).toBe(false);
  });
});

describe("resolveInitTenantRootState / formatInitTenantRegistrationAdvice", () => {
  test("explicit arm + child not listed → paste line, root path, spawn-order note", async () => {
    const root = makeTempDir();
    const child = join(root, "widget");
    mkdirSync(child);
    writeFileSync(
      join(root, "phoebe.config.ts"),
      `export default { workspace: { tenants: ["gadget"] } };\n`,
    );

    const state = await resolveInitTenantRootState({ rootDir: root, tenantDir: child });
    expect(state.kind).toBe("explicit-missing");
    const advice = formatInitTenantRegistrationAdvice(state, child, root);
    expect(advice).toContain(join(root, "phoebe.config.ts"));
    expect(advice).toContain("declared order is spawn order");
    expect(advice).toContain('  "widget",');
  });

  test("explicit arm + already listed → nothing to register", async () => {
    const root = makeTempDir();
    const child = join(root, "widget");
    mkdirSync(child);
    writeFileSync(
      join(root, "phoebe.config.ts"),
      `export default { workspace: { tenants: ["widget"] } };\n`,
    );

    const state = await resolveInitTenantRootState({ rootDir: root, tenantDir: child });
    expect(state.kind).toBe("explicit-listed");
    const advice = formatInitTenantRegistrationAdvice(state, child, root);
    expect(advice).toContain(`already declared in ${join(root, "phoebe.config.ts")}`);
    expect(advice).toContain("nothing to register");
  });

  test("walk arm → one line about the next poll", async () => {
    const root = makeTempDir();
    const child = join(root, "widget");
    mkdirSync(child);
    writeFileSync(join(root, "phoebe.config.ts"), `export default { workspace: { depth: 1 } };\n`);

    const state = await resolveInitTenantRootState({ rootDir: root, tenantDir: child });
    expect(state.kind).toBe("walk");
    expect(formatInitTenantRegistrationAdvice(state, child, root)).toMatch(
      /walk discovers this child on the next boot poll/,
    );
  });

  test("no workspace block → soft not-in-workspace-mode line", async () => {
    const root = makeTempDir();
    const child = join(root, "widget");
    mkdirSync(child);
    writeFileSync(
      join(root, "phoebe.config.ts"),
      `export default { engine: { source: "local" } };\n`,
    );

    const state = await resolveInitTenantRootState({ rootDir: root, tenantDir: child });
    expect(state.kind).toBe("no-workspace");
    expect(formatInitTenantRegistrationAdvice(state, child, root)).toMatch(/not in workspace mode/);
  });

  test("root absent → uncertain hint plus paste line if tenants", async () => {
    const root = makeTempDir();
    const child = join(root, "widget");
    mkdirSync(child);

    const state = await resolveInitTenantRootState({ rootDir: root, tenantDir: child });
    expect(state.kind).toBe("uncertain");
    const advice = formatInitTenantRegistrationAdvice(state, child, root);
    expect(advice).toMatch(/Could not determine workspace mode/);
    expect(advice).toMatch(/If this root uses workspace\.tenants/);
    expect(advice).toContain('  "widget",');
  });

  test("unreadable root → uncertain hint plus paste line if tenants", async () => {
    const root = makeTempDir();
    const child = join(root, "widget");
    mkdirSync(child);
    writeFileSync(join(root, "phoebe.config.ts"), `export default { workspace: { depth: 1 } };\n`);

    const state = await resolveInitTenantRootState({
      rootDir: root,
      tenantDir: child,
      loadConfig: async () => {
        throw new Error("syntax error");
      },
    });
    expect(state.kind).toBe("uncertain");
    const advice = formatInitTenantRegistrationAdvice(state, child, root);
    expect(advice).toMatch(/could not read phoebe\.config\.ts/i);
    expect(advice).toContain('  "widget",');
  });

  test("malformed workspace → uncertain hint plus paste line if tenants", async () => {
    const root = makeTempDir();
    const child = join(root, "widget");
    mkdirSync(child);
    writeFileSync(join(root, "phoebe.config.ts"), "export default {};\n");

    const state = await resolveInitTenantRootState({
      rootDir: root,
      tenantDir: child,
      loadConfig: async () => ({ workspace: { depth: 0 } }),
    });
    expect(state.kind).toBe("uncertain");
    const advice = formatInitTenantRegistrationAdvice(state, child, root);
    expect(advice).toMatch(/workspace block.*could not be parsed/i);
    expect(advice).toContain('  "widget",');
  });
});
