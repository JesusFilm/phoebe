// Multi-tenant lifecycle command tests (#63): add-repo / remove-repo / list /
// purge against temp config + data trees.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  addRepo,
  defaultRepoUrl,
  isNested,
  listTenants,
  parseSlug,
  purgeTenant,
  readFlatRepoFields,
  removeRepo,
  renderTenantConfig,
} from "./tenant-commands.ts";

let configDir: string;
let dataBase: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "phoebe-cfg-"));
  dataBase = mkdtempSync(join(tmpdir(), "phoebe-data-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dataBase, { recursive: true, force: true });
});

describe("parseSlug / defaultRepoUrl", () => {
  test("splits a valid slug", () => {
    expect(parseSlug("acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });
  test("rejects malformed slugs", () => {
    for (const bad of ["widget", "a/b/c", "acme/", "/widget", "acme /widget"]) {
      expect(() => parseSlug(bad)).toThrow(/Invalid repo slug/);
    }
  });
  test("derives the GitHub HTTPS url", () => {
    expect(defaultRepoUrl("acme/widget")).toBe("https://github.com/acme/widget.git");
  });
});

describe("renderTenantConfig", () => {
  test("carries the repo fields and NO engine field (engine is shared)", () => {
    const src = renderTenantConfig({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "pnpm i",
      checkCommand: "pnpm check",
      testCommand: "pnpm test",
    });
    expect(src).toContain('repoSlug: "acme/widget"');
    expect(src).toContain('installCommand: "pnpm i"');
    expect(src).not.toMatch(/\bengine\s*:/); // no engine field — engine source is shared
  });
});

describe("addRepo", () => {
  test("scaffolds repos/<owner>/<repo>/ with config + .env.example, and goes nested", () => {
    expect(isNested(configDir)).toBe(false);
    const result = addRepo({ configDir, slug: "acme/widget" });
    expect(result.tenantDir).toBe(join(configDir, "repos", "acme", "widget"));
    expect(existsSync(join(result.tenantDir, "phoebe.config.ts"))).toBe(true);
    expect(existsSync(join(result.tenantDir, ".env.example"))).toBe(true);
    expect(isNested(configDir)).toBe(true);
  });

  test("uses the derived url and default commands when none given", () => {
    const { tenantDir } = addRepo({ configDir, slug: "acme/widget" });
    const src = readFileSync(join(tenantDir, "phoebe.config.ts"), "utf8");
    expect(src).toContain("https://github.com/acme/widget.git");
    expect(src).toContain('installCommand: "npm ci"');
  });

  test("honors explicit url + commands (e.g. from --from-config)", () => {
    const { tenantDir } = addRepo({
      configDir,
      slug: "acme/widget",
      repoUrl: "git@example.com:acme/widget.git",
      installCommand: "pnpm install --frozen-lockfile",
    });
    const src = readFileSync(join(tenantDir, "phoebe.config.ts"), "utf8");
    expect(src).toContain("git@example.com:acme/widget.git");
    expect(src).toContain("pnpm install --frozen-lockfile");
  });

  test("seeds prompts only with withPrompts", () => {
    const seedPrompt = (dir: string): string[] => {
      mkdirSync(dir, { recursive: true });
      const p = join(dir, "issues-prompt.md");
      writeFileSync(p, "prompt");
      return [p];
    };
    const bare = addRepo({ configDir, slug: "acme/one" });
    expect(bare.created.some((p) => p.includes("prompts"))).toBe(false);
    const withP = addRepo({ configDir, slug: "acme/two", withPrompts: true, seedPrompt });
    expect(withP.created.some((p) => p.includes("prompts"))).toBe(true);
  });

  test("refuses to overwrite an existing tenant", () => {
    addRepo({ configDir, slug: "acme/widget" });
    expect(() => addRepo({ configDir, slug: "acme/widget" })).toThrow(/already exists/);
  });
});

describe("removeRepo", () => {
  test("deletes the tenant config dir", () => {
    const { tenantDir } = addRepo({ configDir, slug: "acme/widget" });
    removeRepo({ configDir, slug: "acme/widget" });
    expect(existsSync(tenantDir)).toBe(false);
  });
  test("throws for an unknown tenant", () => {
    expect(() => removeRepo({ configDir, slug: "acme/ghost" })).toThrow(/No tenant/);
  });
});

describe("listTenants", () => {
  test("reports config/env/retained-data per tenant, sorted", () => {
    addRepo({ configDir, slug: "acme/widget" });
    addRepo({ configDir, slug: "acme/gadget" });
    // widget has a real .env and retained /data; gadget has neither.
    writeFileSync(join(configDir, "repos", "acme", "widget", ".env"), "GH_TOKEN=x");
    mkdirSync(join(dataBase, "acme", "widget"), { recursive: true });

    const listings = listTenants({ configDir, dataBase });
    expect(listings.map((l) => l.slug)).toEqual(["acme/gadget", "acme/widget"]);
    const widget = listings.find((l) => l.slug === "acme/widget")!;
    expect(widget).toMatchObject({ configValid: true, envPresent: true, retainedData: true });
    const gadget = listings.find((l) => l.slug === "acme/gadget")!;
    expect(gadget).toMatchObject({ envPresent: false, retainedData: false });
  });

  test("reads status.json when present", () => {
    addRepo({ configDir, slug: "acme/widget" });
    const stateDir = join(dataBase, "acme", "widget", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "status.json"),
      JSON.stringify({ tenant: "acme/widget", currentUnit: { kind: "issues", id: "5" } }),
    );
    const [widget] = listTenants({ configDir, dataBase });
    expect(widget?.status?.currentUnit).toEqual({ kind: "issues", id: "5" });
  });

  test("empty when there is no repos/ dir", () => {
    expect(listTenants({ configDir, dataBase })).toEqual([]);
  });
});

describe("purgeTenant", () => {
  test("wipes retained data for a removed tenant with --yes", () => {
    addRepo({ configDir, slug: "acme/widget" });
    mkdirSync(join(dataBase, "acme", "widget"), { recursive: true });
    removeRepo({ configDir, slug: "acme/widget" });

    const { purged } = purgeTenant({ configDir, dataBase, slug: "acme/widget", confirm: true });
    expect(purged).toBe(join(dataBase, "acme", "widget"));
    expect(existsSync(purged)).toBe(false);
  });

  test("refuses without confirm", () => {
    expect(() =>
      purgeTenant({ configDir, dataBase, slug: "acme/widget", confirm: false }),
    ).toThrow(/without --yes/);
  });

  test("refuses while a live config still exists", () => {
    addRepo({ configDir, slug: "acme/widget" });
    mkdirSync(join(dataBase, "acme", "widget"), { recursive: true });
    expect(() =>
      purgeTenant({ configDir, dataBase, slug: "acme/widget", confirm: true }),
    ).toThrow(/still has a live config/);
  });

  test("throws when there is no retained data", () => {
    expect(() =>
      purgeTenant({ configDir, dataBase, slug: "acme/ghost", confirm: true }),
    ).toThrow(/No retained data/);
  });
});

describe("readFlatRepoFields", () => {
  test("extracts install/check/test from a flat top config", () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `const config = {
        repoSlug: "acme/widget",
        installCommand: "pnpm install --frozen-lockfile",
        checkCommand: "pnpm run check",
        testCommand: "pnpm run test",
      };`,
    );
    expect(readFlatRepoFields(configDir)).toEqual({
      installCommand: "pnpm install --frozen-lockfile",
      checkCommand: "pnpm run check",
      testCommand: "pnpm run test",
    });
  });

  test("returns empty when the file is missing", () => {
    expect(readFlatRepoFields(configDir)).toEqual({});
  });
});
