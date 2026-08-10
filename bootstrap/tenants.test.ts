// Discovery tests (#58/#63/#91/#92): flat vs nested selection by `repos/`
// presence, the nested scan over `repos/<owner>/<repo>/`, workspace tree walk,
// origin cross-check, and fleet-level slug uniqueness.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  diffFleet,
  discoverTenants,
  discoverUndeclaredInTreeTenants,
  discoverWorkspaceTenants,
  DIRECTORY_ABSENT_HOLD_REASON,
  DuplicateOriginSlugError,
  DuplicateTenantSlugError,
  isNestedDeployment,
  OUT_OF_TREE_CONTAINER_HOLD_REASON,
  readTenantOriginUrl,
  resolveDeclaredTenantDir,
  slugFromUrl,
  TENANT_CONFIG_FILE,
  TENANT_ENV_FILE,
  tenantForDir,
  withTenantConfigDir,
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

/** Injected origin map so tests never need a real git checkout. */
function origins(map: Record<string, string | null>): (tenantDir: string) => string | null {
  return (tenantDir) => (Object.hasOwn(map, tenantDir) ? map[tenantDir]! : null);
}

describe("slugFromUrl", () => {
  test("returns the same slug for SSH and HTTPS forms of one repo", () => {
    expect(slugFromUrl("git@github.com:acme/widget.git")).toBe("acme/widget");
    expect(slugFromUrl("https://github.com/acme/widget.git")).toBe("acme/widget");
    expect(slugFromUrl("https://github.com/acme/widget")).toBe("acme/widget");
    expect(slugFromUrl("git@github.com:acme/widget")).toBe("acme/widget");
  });

  test("strips .git and tolerates https credentials", () => {
    expect(slugFromUrl("https://x-access-token:ghs_x@github.com/acme/widget.git")).toBe(
      "acme/widget",
    );
  });

  test("returns null for empty, malformed, and non-GitHub URLs", () => {
    expect(slugFromUrl("")).toBeNull();
    expect(slugFromUrl("   ")).toBeNull();
    expect(slugFromUrl("not-a-url")).toBeNull();
    expect(slugFromUrl("git@gitlab.com:acme/widget.git")).toBeNull();
    expect(slugFromUrl("https://gitlab.com/acme/widget.git")).toBeNull();
    expect(slugFromUrl("https://github.com/only-owner")).toBeNull();
    expect(slugFromUrl("git@github.com:acme")).toBeNull();
  });
});

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
    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 1 },
      {
        loadRepoSlug: (path) => {
          const slug = slugs.get(path);
          if (!slug) throw new Error(`unexpected path ${path}`);
          return slug;
        },
        readOriginUrl: () => null,
      },
    );
    expect(discovery.mode).toBe("workspace");
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/gadget", "acme/widget"]);
    expect(discovery.tenants.every((t) => t.dir !== dir)).toBe(true);
    expect(discovery.holds).toEqual([]);
  });

  test("depth 2 walks nested dirs and prunes at the first config hit", async () => {
    writeSlugConfig(join(dir, "apps", "widget"), "acme/widget");
    // Nested under a found tenant — must not be discovered (prune-at-first-hit).
    writeSlugConfig(join(dir, "apps", "widget", "nested"), "acme/nested");
    // Deeper than depth without an intermediate config needs depth ≥ remaining.
    writeSlugConfig(join(dir, "apps", "lib", "gadget"), "acme/gadget");

    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 2 },
      {
        loadRepoSlug: (path) => {
          if (path.includes("/nested/")) return "acme/nested";
          if (path.includes("widget")) return "acme/widget";
          if (path.includes("gadget")) return "acme/gadget";
          throw new Error(path);
        },
        readOriginUrl: () => null,
      },
    );
    // depth 2: root→apps (no config)→widget (config, prune); root→apps→lib has no config
    // at depth budget remaining 0 under lib when depth is 2...
    // walk(root, 2): apps has no config → walk(apps, 1): widget has config → tenant;
    // lib has no config → walk(lib, 0) → stop. gadget at apps/lib/gadget needs depth 3.
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/widget"]);
    expect(discovery.tenants.find((t) => t.slug === "acme/nested")).toBeUndefined();

    const deep = await discoverWorkspaceTenants(
      dir,
      { depth: 3 },
      {
        loadRepoSlug: (path) => {
          if (path.includes("/nested/")) return "acme/nested";
          if (path.includes("widget")) return "acme/widget";
          if (path.includes("gadget")) return "acme/gadget";
          throw new Error(path);
        },
        readOriginUrl: () => null,
      },
    );
    expect(deep.tenants.map((t) => t.slug)).toEqual(["acme/gadget", "acme/widget"]);
  });

  test("skips broken children with a warning and continues", async () => {
    writeSlugConfig(join(dir, "good"), "acme/good");
    writeConfig(join(dir, "broken")); // present config, load fails
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 1 },
      {
        loadRepoSlug: (path) => {
          if (path.includes("broken")) throw new Error("parse failure");
          return "acme/good";
        },
        readOriginUrl: () => null,
        warn: (m) => warnings.push(m),
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/good"]);
    expect(discovery.holds).toEqual([
      { dir: join(dir, "broken"), reason: "parse failure", slug: null },
    ]);
    expect(warnings.some((w) => /broken/.test(w) && /parse failure/.test(w))).toBe(true);
  });

  test("duplicate repoSlug is a fatal discovery error naming both paths", async () => {
    writeSlugConfig(join(dir, "a"), "acme/same");
    writeSlugConfig(join(dir, "b"), "acme/same");

    await expect(
      discoverWorkspaceTenants(
        dir,
        { depth: 1 },
        {
          loadRepoSlug: () => "acme/same",
          readOriginUrl: () => null,
        },
      ),
    ).rejects.toBeInstanceOf(DuplicateTenantSlugError);

    try {
      await discoverWorkspaceTenants(
        dir,
        { depth: 1 },
        {
          loadRepoSlug: () => "acme/same",
          readOriginUrl: () => null,
        },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateTenantSlugError);
      const dup = error as DuplicateTenantSlugError;
      expect(dup.slug).toBe("acme/same");
      expect(dup.paths).toContain(join(dir, "a"));
      expect(dup.paths).toContain(join(dir, "b"));
      expect(dup.message).toMatch(/duplicate repoSlug "acme\/same"/);
    }
  });

  test("origin mismatch with config repoSlug is skip-and-warn (config authoritative)", async () => {
    const good = join(dir, "good");
    const mismatch = join(dir, "mismatch");
    writeSlugConfig(good, "acme/good");
    writeSlugConfig(mismatch, "acme/configured");
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 1 },
      {
        loadRepoSlug: (path) => {
          if (path.includes("mismatch")) return "acme/configured";
          return "acme/good";
        },
        readOriginUrl: origins({
          [good]: "git@github.com:acme/good.git",
          [mismatch]: "https://github.com/acme/other.git",
        }),
        warn: (m) => warnings.push(m),
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/good"]);
    expect(discovery.holds).toEqual([
      {
        dir: mismatch,
        reason:
          'origin slug "acme/other" does not match config repoSlug "acme/configured" ' +
          "(config is authoritative; fix the checkout origin or the child's repoSlug)",
        // Config was readable before the mismatch skip, so `phoebe list` keeps
        // the row's slug and its data / status.json columns lit (#140).
        slug: "acme/configured",
      },
    ]);
    expect(
      warnings.some(
        (w) => w.includes("mismatch") && w.includes("acme/other") && w.includes("acme/configured"),
      ),
    ).toBe(true);
  });

  test("absent origin admits the child on config repoSlug authority", async () => {
    writeSlugConfig(join(dir, "orphan"), "acme/orphan");
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 1 },
      {
        loadRepoSlug: () => "acme/orphan",
        readOriginUrl: () => null,
        warn: (m) => warnings.push(m),
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/orphan"]);
    expect(discovery.holds).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("malformed / non-GitHub origin is treated as absent and admits", async () => {
    writeSlugConfig(join(dir, "child"), "acme/child");
    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 1 },
      {
        loadRepoSlug: () => "acme/child",
        readOriginUrl: () => "https://gitlab.com/acme/child.git",
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/child"]);
  });

  test("matching origin slug (SSH or HTTPS) admits the child", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    writeSlugConfig(a, "acme/widget");
    writeSlugConfig(b, "acme/gadget");

    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 1 },
      {
        loadRepoSlug: (path) =>
          path === join(a, TENANT_CONFIG_FILE) ? "acme/widget" : "acme/gadget",
        readOriginUrl: origins({
          [a]: "git@github.com:acme/widget.git",
          [b]: "https://github.com/acme/gadget",
        }),
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/gadget", "acme/widget"]);
  });

  test("duplicate origin-slug across the fleet is a fatal discovery error", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    writeSlugConfig(a, "acme/one");
    writeSlugConfig(b, "acme/two");

    const loadSlug = (path: string): string =>
      path === join(a, TENANT_CONFIG_FILE) ? "acme/one" : "acme/two";
    const sameRemote = origins({
      // Same remote under different config slugs (SSH vs HTTPS normalises equal)
      [a]: "git@github.com:acme/shared.git",
      [b]: "https://github.com/acme/shared.git",
    });

    await expect(
      discoverWorkspaceTenants(
        dir,
        { depth: 1 },
        {
          loadRepoSlug: loadSlug,
          readOriginUrl: sameRemote,
        },
      ),
    ).rejects.toBeInstanceOf(DuplicateOriginSlugError);

    try {
      await discoverWorkspaceTenants(
        dir,
        { depth: 1 },
        {
          loadRepoSlug: loadSlug,
          readOriginUrl: sameRemote,
        },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateOriginSlugError);
      const dup = error as DuplicateOriginSlugError;
      expect(dup.originSlug).toBe("acme/shared");
      expect(dup.paths).toContain(a);
      expect(dup.paths).toContain(b);
      expect(dup.message).toMatch(/duplicate origin slug "acme\/shared"/);
    }
  });

  test("skips noise dirs (node_modules, .git, dotdirs)", async () => {
    writeSlugConfig(join(dir, "real"), "acme/real");
    writeSlugConfig(join(dir, "node_modules", "pkg"), "acme/pkg");
    writeSlugConfig(join(dir, ".git", "modules", "x"), "acme/git");
    writeSlugConfig(join(dir, ".hidden"), "acme/hidden");

    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 2 },
      {
        loadRepoSlug: (path) => {
          if (path.includes("real")) return "acme/real";
          throw new Error(`should not load ${path}`);
        },
        readOriginUrl: () => null,
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/real"]);
  });

  test("discoverUndeclaredInTreeTenants finds depth-1 config dirs not in the declaration", () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    writeSlugConfig(join(dir, "orphan"), "acme/orphan");
    writeSlugConfig(join(dir, "apps", "nested"), "acme/nested");

    expect(discoverUndeclaredInTreeTenants(dir, ["widget"])).toEqual(["orphan"]);
  });
});

describe("configDir asset relocation (#98)", () => {
  test("workspace discovery relocates a tenant's .env under configDir; config stays at root", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    writeSlugConfig(join(dir, "gadget"), "acme/gadget");

    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 1 },
      {
        loadRepoSlug: (path) => (path.includes("widget") ? "acme/widget" : "acme/gadget"),
        loadConfigDir: (path) => (path.includes("widget") ? ".phoebe" : "."),
        readOriginUrl: () => null,
      },
    );

    const widget = discovery.tenants.find((t) => t.slug === "acme/widget");
    const gadget = discovery.tenants.find((t) => t.slug === "acme/gadget");
    // widget: `.env` relocated into `.phoebe/`, but the config path is unchanged.
    expect(widget?.configPath).toBe(join(dir, "widget", TENANT_CONFIG_FILE));
    expect(widget?.envPath).toBe(join(dir, "widget", ".phoebe", TENANT_ENV_FILE));
    // gadget: configDir "." → co-located, byte-for-byte unchanged.
    expect(gadget?.envPath).toBe(join(dir, "gadget", TENANT_ENV_FILE));
  });

  test("a malformed configDir skip-and-warns the child, like a bad repoSlug", async () => {
    writeSlugConfig(join(dir, "good"), "acme/good");
    writeSlugConfig(join(dir, "bad"), "acme/bad");
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 1 },
      {
        loadRepoSlug: (path) => (path.includes("bad") ? "acme/bad" : "acme/good"),
        loadConfigDir: (path) => {
          if (path.includes("bad")) throw new Error("`configDir` must be relative");
          return ".";
        },
        readOriginUrl: () => null,
        warn: (m) => warnings.push(m),
      },
    );

    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/good"]);
    expect(discovery.holds).toEqual([
      { dir: join(dir, "bad"), reason: "`configDir` must be relative", slug: null },
    ]);
    expect(warnings.some((w) => /bad/.test(w) && /configDir/.test(w))).toBe(true);
  });

  test("no loadConfigDir dep keeps .env co-located (back-compat)", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    const discovery = await discoverWorkspaceTenants(
      dir,
      { depth: 1 },
      {
        loadRepoSlug: () => "acme/widget",
        readOriginUrl: () => null,
      },
    );
    expect(discovery.tenants[0]?.envPath).toBe(join(dir, "widget", TENANT_ENV_FILE));
  });

  test("tenantForDir builds the same shape discovery does for a known dir", () => {
    const tenantDir = join(dir, "widget");
    const tenant = tenantForDir(tenantDir, "acme/widget");
    expect(tenant.id).toBe(tenantDir);
    expect(tenant.dir).toBe(tenantDir);
    expect(tenant.slug).toBe("acme/widget");
    expect(tenant.configPath).toBe(join(tenantDir, TENANT_CONFIG_FILE));
    expect(tenant.envPath).toBe(join(tenantDir, TENANT_ENV_FILE));
  });

  test("tenantForDir honours configDir so the .env is where the child reads it", () => {
    const tenantDir = join(dir, "widget");
    expect(tenantForDir(tenantDir, "acme/widget", ".phoebe").envPath).toBe(
      join(tenantDir, ".phoebe", TENANT_ENV_FILE),
    );
  });

  test("withTenantConfigDir relocates envPath only; '.' is a no-op", () => {
    const tenantDir = join(dir, "widget");
    const base: DiscoveredTenant = {
      id: tenantDir,
      slug: "acme/widget",
      dir: tenantDir,
      configPath: join(tenantDir, TENANT_CONFIG_FILE),
      envPath: join(tenantDir, TENANT_ENV_FILE),
    };
    expect(withTenantConfigDir(base, ".")).toBe(base);
    const moved = withTenantConfigDir(base, ".phoebe");
    expect(moved.envPath).toBe(join(tenantDir, ".phoebe", TENANT_ENV_FILE));
    expect(moved.configPath).toBe(base.configPath);
    expect(moved.dir).toBe(base.dir);
  });
});

describe("workspace explicit arm (#137)", () => {
  test("discovers declared dirs in declared order without slug sort", async () => {
    writeSlugConfig(join(dir, "zeta"), "acme/zeta");
    writeSlugConfig(join(dir, "alpha"), "acme/alpha");

    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["zeta", "alpha"] },
      {
        loadRepoSlug: (path) => (path.includes("zeta") ? "acme/zeta" : "acme/alpha"),
        readOriginUrl: () => null,
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/zeta", "acme/alpha"]);
    expect(discovery.declaredDirs).toEqual([join(dir, "zeta"), join(dir, "alpha")]);
    expect(discovery.holds).toEqual([]);
  });

  test("holds an absent declared dir with a specific reason", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["widget", "missing"] },
      {
        loadRepoSlug: () => "acme/widget",
        readOriginUrl: () => null,
        warn: (m) => warnings.push(m),
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/widget"]);
    expect(discovery.holds).toEqual([
      { dir: join(dir, "missing"), reason: DIRECTORY_ABSENT_HOLD_REASON, slug: null },
    ]);
    expect(warnings.some((w) => /missing/.test(w) && /directory absent/.test(w))).toBe(true);
  });

  test("holds a present dir with no phoebe.config.ts (not split from absent)", async () => {
    mkdirSync(join(dir, "empty"), { recursive: true });
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["widget", "empty"] },
      {
        loadRepoSlug: () => "acme/widget",
        readOriginUrl: () => null,
        warn: (m) => warnings.push(m),
      },
    );
    expect(discovery.holds).toEqual([
      {
        dir: join(dir, "empty"),
        reason: "no phoebe.config.ts at directory root",
        slug: null,
      },
    ]);
    expect(warnings.some((w) => /empty/.test(w) && /no phoebe\.config\.ts/.test(w))).toBe(true);
  });

  test("does not descend into a declared dir — it is the tenant or nothing", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    writeSlugConfig(join(dir, "widget", "nested"), "acme/nested");

    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["widget"] },
      {
        loadRepoSlug: (path) => (path.includes("/nested/") ? "acme/nested" : "acme/widget"),
        readOriginUrl: () => null,
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/widget"]);
  });

  test("duplicate repoSlug stays fatal on the explicit arm", async () => {
    writeSlugConfig(join(dir, "a"), "acme/same");
    writeSlugConfig(join(dir, "b"), "acme/same");

    await expect(
      discoverWorkspaceTenants(
        dir,
        { tenants: ["a", "b"] },
        {
          loadRepoSlug: () => "acme/same",
          readOriginUrl: () => null,
        },
      ),
    ).rejects.toBeInstanceOf(DuplicateTenantSlugError);
  });
});

describe("out-of-tree tenants (#143)", () => {
  test("holds an absent out-of-tree dir with a container-specific reason", async () => {
    const warnings: string[] = [];
    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["../missing-sibling"] },
      {
        loadRepoSlug: () => "acme/missing",
        readOriginUrl: () => null,
        warn: (m) => warnings.push(m),
        inContainer: () => true,
      },
    );
    const heldDir = resolveDeclaredTenantDir(dir, "../missing-sibling");
    expect(discovery.holds).toEqual([
      { dir: heldDir, reason: OUT_OF_TREE_CONTAINER_HOLD_REASON, slug: null },
    ]);
    expect(warnings.some((w) => w.includes(OUT_OF_TREE_CONTAINER_HOLD_REASON))).toBe(true);
  });

  test("keeps the generic absent reason for out-of-tree dirs on the host", async () => {
    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["../missing-sibling"] },
      {
        loadRepoSlug: () => "acme/missing",
        readOriginUrl: () => null,
        inContainer: () => false,
      },
    );
    expect(discovery.holds).toEqual([
      {
        dir: resolveDeclaredTenantDir(dir, "../missing-sibling"),
        reason: DIRECTORY_ABSENT_HOLD_REASON,
        slug: null,
      },
    ]);
  });

  test("keeps the generic absent reason for an in-tree `..`-prefixed dir in a container", async () => {
    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["..tenant"] },
      {
        loadRepoSlug: () => "acme/dotdot",
        readOriginUrl: () => null,
        inContainer: () => true,
      },
    );
    expect(discovery.holds).toEqual([
      {
        dir: resolveDeclaredTenantDir(dir, "..tenant"),
        reason: DIRECTORY_ABSENT_HOLD_REASON,
        slug: null,
      },
    ]);
  });

  test("boots an out-of-tree tenant silently when it resolves", async () => {
    const sibling = join(dir, "..", "outboard");
    writeSlugConfig(sibling, "acme/outboard");
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["../outboard"] },
      {
        loadRepoSlug: () => "acme/outboard",
        readOriginUrl: () => null,
        warn: (m) => warnings.push(m),
        inContainer: () => true,
      },
    );
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/outboard"]);
    expect(discovery.holds).toEqual([]);
    expect(warnings).toEqual([]);
    rmSync(sibling, { recursive: true, force: true });
  });

  test("a symlink-aliased duplicate lands on DuplicateTenantSlugError at discovery", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/same");
    symlinkSync(join(dir, "widget"), join(dir, "widget-link"));

    await expect(
      discoverWorkspaceTenants(
        dir,
        { tenants: ["widget", "widget-link"] },
        {
          loadRepoSlug: () => "acme/same",
          readOriginUrl: () => null,
        },
      ),
    ).rejects.toBeInstanceOf(DuplicateTenantSlugError);
  });

  for (const [label, inContainer] of [
    ["on-host", false],
    ["in-container", true],
  ] as const) {
    test(`${label}: discovery issues no mutating git operation under tenant.dir`, async () => {
      const tenantDir = join(dir, "widget");
      writeSlugConfig(tenantDir, "acme/widget");
      execFileSync("git", ["init"], { cwd: tenantDir, encoding: "utf8" });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widget.git"], {
        cwd: tenantDir,
        encoding: "utf8",
      });

      const gitCalls: string[][] = [];
      const recordingExec: typeof execFileSync = ((cmd, args, options) => {
        if (cmd === "git") gitCalls.push(args as string[]);
        return execFileSync(cmd, args as string[], options as object);
      }) as typeof execFileSync;

      await discoverWorkspaceTenants(
        dir,
        { tenants: ["widget"] },
        {
          loadRepoSlug: () => "acme/widget",
          readOriginUrl: (d) => readTenantOriginUrl(d, { execFile: recordingExec }),
          inContainer: () => inContainer,
        },
      );

      expect(gitCalls).toEqual([["-C", tenantDir, "config", "--get", "remote.origin.url"]]);
      const mutating = new Set([
        "add",
        "commit",
        "checkout",
        "clone",
        "fetch",
        "merge",
        "pull",
        "push",
        "rebase",
        "reset",
        "restore",
        "switch",
      ]);
      expect(gitCalls.flat().some((arg) => mutating.has(arg))).toBe(false);
    });
  }
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

  test("a declared dir that vanished stays held — running child is not removed (#137)", () => {
    const previous = new Map<string, string | null>([
      [join(dir, "widget"), "fp1"],
      [join(dir, "gadget"), "fp1"],
    ]);
    const diff = diffFleet(
      previous,
      [{ tenant: tenant(join(dir, "widget")), fingerprint: "fp1" }],
      new Set([join(dir, "gadget")]),
    );
    expect(diff.removed).toEqual([]);
  });
});

// The hot half of the explicit arm: one poll's discovery feeding the next
// poll's reconcile diff, which is where a wrong tenant identity shows up as
// churn. Discovery shape itself is pinned by "workspace explicit arm (#137)".
describe("explicit workspace tenants arm — reconcile identity (#139)", () => {
  test("absent declared dir is held, not removed from a running fleet", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    const widgetDir = join(dir, "widget");
    const missingDir = join(dir, "missing");

    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["widget", "missing"] },
      {
        loadRepoSlug: () => "acme/widget",
        readOriginUrl: () => null,
      },
    );
    expect(discovery.tenants.map((t) => t.id)).toEqual([widgetDir]);
    expect(discovery.holds).toEqual([
      { dir: missingDir, reason: DIRECTORY_ABSENT_HOLD_REASON, slug: null },
    ]);

    const previous = new Map<string, string | null>([
      [widgetDir, "fp1"],
      [missingDir, "fp1"],
    ]);
    const diff = diffFleet(
      previous,
      discovery.tenants.map((tenant) => ({ tenant, fingerprint: "fp1" })),
      new Set(discovery.holds.map((hold) => hold.dir)),
    );
    expect(diff.removed).toEqual([]);
  });

  test("rm -rf of a declared dir does not emit removed for a running child", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    const widgetDir = join(dir, "widget");
    const previous = new Map<string, string | null>([[widgetDir, "fp1"]]);

    rmSync(widgetDir, { recursive: true, force: true });

    const discovery = await discoverWorkspaceTenants(
      dir,
      { tenants: ["widget"] },
      {
        loadRepoSlug: () => "acme/widget",
        readOriginUrl: () => null,
      },
    );
    expect(discovery.tenants).toEqual([]);
    expect(discovery.holds.map((hold) => hold.dir)).toEqual([widgetDir]);

    const diff = diffFleet(previous, [], new Set(discovery.holds.map((hold) => hold.dir)));
    expect(diff.removed).toEqual([]);
  });

  test("tidying declared spelling is a no-op identity", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    const widgetDir = join(dir, "widget");

    const tidy = await discoverWorkspaceTenants(
      dir,
      { tenants: ["./widget"] },
      {
        loadRepoSlug: () => "acme/widget",
        readOriginUrl: () => null,
      },
    );
    const plain = await discoverWorkspaceTenants(
      dir,
      { tenants: ["widget"] },
      {
        loadRepoSlug: () => "acme/widget",
        readOriginUrl: () => null,
      },
    );
    expect(tidy.tenants[0]?.id).toBe(widgetDir);
    expect(plain.tenants[0]?.id).toBe(widgetDir);
  });

  test("reordering declared tenants does not diff against a running fleet", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    writeSlugConfig(join(dir, "gadget"), "acme/gadget");
    const widgetDir = join(dir, "widget");
    const gadgetDir = join(dir, "gadget");

    const first = await discoverWorkspaceTenants(
      dir,
      { tenants: ["widget", "gadget"] },
      {
        loadRepoSlug: (path) => (path.includes("widget") ? "acme/widget" : "acme/gadget"),
        readOriginUrl: () => null,
      },
    );
    const reordered = await discoverWorkspaceTenants(
      dir,
      { tenants: ["gadget", "widget"] },
      {
        loadRepoSlug: (path) => (path.includes("widget") ? "acme/widget" : "acme/gadget"),
        readOriginUrl: () => null,
      },
    );

    const previous = new Map<string, string | null>([
      [widgetDir, "fp1"],
      [gadgetDir, "fp1"],
    ]);
    const diff = diffFleet(
      previous,
      reordered.tenants.map((tenant) => ({ tenant, fingerprint: "fp1" })),
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(new Set(first.tenants.map((t) => t.id))).toEqual(
      new Set(reordered.tenants.map((t) => t.id)),
    );
  });
});
