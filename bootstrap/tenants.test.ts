// Discovery tests (#58/#63/#91): flat vs nested selection by `repos/` presence,
// the nested scan over `repos/<owner>/<repo>/`, and workspace tree walk.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  diffFleet,
  discoverTenants,
  discoverWorkspaceTenants,
  DuplicateTenantSlugError,
  isNestedDeployment,
  TENANT_CONFIG_FILE,
  TENANT_ENV_FILE,
  type DiscoveredTenant,
} from "./tenants.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phoebe-tenants-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(at: string): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, TENANT_CONFIG_FILE), "export default {}");
}

function writeSlugConfig(at: string, slug: string): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, TENANT_CONFIG_FILE),
    `export default { repoSlug: ${JSON.stringify(slug)} }`,
  );
}

describe("flat mode", () => {
  test("no repos/ dir → one in-place tenant", () => {
    writeConfig(dir);
    const discovery = discoverTenants(dir);
    expect(discovery.mode).toBe("flat");
    expect(discovery.tenants).toHaveLength(1);
    const [tenant] = discovery.tenants;
    expect(tenant.dir).toBe(dir);
    expect(tenant.slug).toBeNull();
    expect(tenant.configPath).toBe(join(dir, TENANT_CONFIG_FILE));
    expect(tenant.envPath).toBe(join(dir, TENANT_ENV_FILE));
  });

  test("isNestedDeployment is false without repos/", () => {
    writeConfig(dir);
    expect(isNestedDeployment(dir)).toBe(false);
  });
});

describe("nested mode", () => {
  test("repos/ dir → one tenant per <owner>/<repo> with a config", () => {
    writeConfig(join(dir, "repos", "acme", "widget"));
    writeConfig(join(dir, "repos", "acme", "gadget"));
    writeConfig(join(dir, "repos", "globex", "thing"));

    const discovery = discoverTenants(dir);
    expect(discovery.mode).toBe("nested");
    expect(discovery.tenants.map((t) => t.slug)).toEqual([
      "acme/gadget",
      "acme/widget",
      "globex/thing",
    ]);
    const widget = discovery.tenants.find((t) => t.slug === "acme/widget");
    expect(widget?.dir).toBe(join(dir, "repos", "acme", "widget"));
    expect(widget?.id).toBe(widget?.dir);
  });

  test("a repo dir without a config is not a tenant", () => {
    writeConfig(join(dir, "repos", "acme", "widget"));
    mkdirSync(join(dir, "repos", "acme", "empty"), { recursive: true });
    const discovery = discoverTenants(dir);
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/widget"]);
  });

  test("an empty repos/ is a valid nested deployment with zero tenants", () => {
    mkdirSync(join(dir, "repos"), { recursive: true });
    const discovery = discoverTenants(dir);
    expect(discovery.mode).toBe("nested");
    expect(discovery.tenants).toEqual([]);
    expect(isNestedDeployment(dir)).toBe(true);
  });
});

describe("workspace mode", () => {
  test("depth 1 finds immediate children with a config; root is never a tenant", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    writeSlugConfig(join(dir, "gadget"), "acme/gadget");
    // Root config would be the workspace declaration — not a tenant even if present.
    writeSlugConfig(dir, "acme/workspace-root");

    const slugs = new Map([
      [join(dir, "widget", TENANT_CONFIG_FILE), "acme/widget"],
      [join(dir, "gadget", TENANT_CONFIG_FILE), "acme/gadget"],
      [join(dir, TENANT_CONFIG_FILE), "acme/workspace-root"],
    ]);
    const discovery = await discoverWorkspaceTenants(dir, 1, {
      loadRepoSlug: (path) => {
        const slug = slugs.get(path);
        if (!slug) throw new Error(`unexpected path ${path}`);
        return slug;
      },
    });
    expect(discovery.mode).toBe("workspace");
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/gadget", "acme/widget"]);
    expect(discovery.tenants.every((t) => t.dir !== dir)).toBe(true);
    expect(discovery.holdIds).toEqual([]);
  });

  test("depth 2 walks nested dirs and prunes at the first config hit", async () => {
    writeSlugConfig(join(dir, "apps", "widget"), "acme/widget");
    // Nested under a found tenant — must not be discovered (prune-at-first-hit).
    writeSlugConfig(join(dir, "apps", "widget", "nested"), "acme/nested");
    // Deeper than depth without an intermediate config needs depth ≥ remaining.
    writeSlugConfig(join(dir, "apps", "lib", "gadget"), "acme/gadget");

    const discovery = await discoverWorkspaceTenants(dir, 2, {
      loadRepoSlug: (path) => {
        if (path.includes("/nested/")) return "acme/nested";
        if (path.includes("widget")) return "acme/widget";
        if (path.includes("gadget")) return "acme/gadget";
        throw new Error(path);
      },
    });
    // depth 2: root→apps (no config)→widget (config, prune); root→apps→lib has no config
    // at depth budget remaining 0 under lib when depth is 2...
    // walk(root, 2): apps has no config → walk(apps, 1): widget has config → tenant;
    // lib has no config → walk(lib, 0) → stop. gadget at apps/lib/gadget needs depth 3.
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/widget"]);
    expect(discovery.tenants.find((t) => t.slug === "acme/nested")).toBeUndefined();

    const deep = await discoverWorkspaceTenants(dir, 3, {
      loadRepoSlug: (path) => {
        if (path.includes("/nested/")) return "acme/nested";
        if (path.includes("widget")) return "acme/widget";
        if (path.includes("gadget")) return "acme/gadget";
        throw new Error(path);
      },
    });
    expect(deep.tenants.map((t) => t.slug)).toEqual(["acme/gadget", "acme/widget"]);
  });

  test("skips broken children with a warning and continues", async () => {
    writeSlugConfig(join(dir, "good"), "acme/good");
    writeConfig(join(dir, "broken")); // present config, load fails
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(dir, 1, {
      loadRepoSlug: (path) => {
        if (path.includes("broken")) throw new Error("parse failure");
        return "acme/good";
      },
      warn: (m) => warnings.push(m),
    });
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/good"]);
    expect(discovery.holdIds).toEqual([join(dir, "broken")]);
    expect(warnings.some((w) => /broken/.test(w) && /parse failure/.test(w))).toBe(true);
  });

  test("duplicate repoSlug is a fatal discovery error naming both paths", async () => {
    writeSlugConfig(join(dir, "a"), "acme/same");
    writeSlugConfig(join(dir, "b"), "acme/same");

    await expect(
      discoverWorkspaceTenants(dir, 1, {
        loadRepoSlug: () => "acme/same",
      }),
    ).rejects.toBeInstanceOf(DuplicateTenantSlugError);

    try {
      await discoverWorkspaceTenants(dir, 1, { loadRepoSlug: () => "acme/same" });
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateTenantSlugError);
      const dup = error as DuplicateTenantSlugError;
      expect(dup.slug).toBe("acme/same");
      expect(dup.paths).toContain(join(dir, "a"));
      expect(dup.paths).toContain(join(dir, "b"));
      expect(dup.message).toMatch(/duplicate repoSlug "acme\/same"/);
    }
  });

  test("skips noise dirs (node_modules, .git, dotdirs)", async () => {
    writeSlugConfig(join(dir, "real"), "acme/real");
    writeSlugConfig(join(dir, "node_modules", "pkg"), "acme/pkg");
    writeSlugConfig(join(dir, ".git", "modules", "x"), "acme/git");
    writeSlugConfig(join(dir, ".hidden"), "acme/hidden");

    const discovery = await discoverWorkspaceTenants(dir, 2, {
      loadRepoSlug: (path) => {
        if (path.includes("real")) return "acme/real";
        throw new Error(`should not load ${path}`);
      },
    });
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/real"]);
  });
});

describe("diffFleet", () => {
  const tenant = (id: string): DiscoveredTenant => ({
    id,
    slug: id,
    dir: id,
    configPath: `${id}/phoebe.config.ts`,
    envPath: `${id}/.env`,
  });

  test("classifies added, removed, changed, and unchanged", () => {
    const previous = new Map<string, string | null>([
      ["a", "fp1"],
      ["b", "fp1"],
      ["c", "fp1"],
    ]);
    const diff = diffFleet(previous, [
      { tenant: tenant("a"), fingerprint: "fp1" }, // unchanged
      { tenant: tenant("b"), fingerprint: "fp2" }, // changed
      { tenant: tenant("d"), fingerprint: "fp1" }, // added
      // c removed
    ]);
    expect(diff.added.map((t) => t.id)).toEqual(["d"]);
    expect(diff.changed.map((t) => t.id)).toEqual(["b"]);
    expect(diff.removed).toEqual(["c"]);
  });

  test("a null fingerprint on either side is never a change", () => {
    const previous = new Map<string, string | null>([
      ["a", null],
      ["b", "fp1"],
    ]);
    const diff = diffFleet(previous, [
      { tenant: tenant("a"), fingerprint: "fp2" }, // prev null → not changed
      { tenant: tenant("b"), fingerprint: null }, // now null → not changed
    ]);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("empty previous → everything is added", () => {
    const diff = diffFleet(new Map(), [{ tenant: tenant("a"), fingerprint: "fp1" }]);
    expect(diff.added.map((t) => t.id)).toEqual(["a"]);
  });

  test("held ids are not removed when absent from the current sample (#86)", () => {
    const previous = new Map<string, string | null>([
      ["a", "fp1"],
      ["b", "fp1"],
    ]);
    // b is gone from samples (unreadable config mid-rewrite) but still present → hold
    const diff = diffFleet(previous, [{ tenant: tenant("a"), fingerprint: "fp1" }], new Set(["b"]));
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("a held id that is no longer held is removed", () => {
    const previous = new Map<string, string | null>([
      ["a", "fp1"],
      ["b", "fp1"],
    ]);
    const diff = diffFleet(previous, [{ tenant: tenant("a"), fingerprint: "fp1" }], new Set());
    expect(diff.removed).toEqual(["b"]);
  });
});
