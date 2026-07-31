// Discovery tests (#58/#63): flat vs nested selection by `repos/` presence, and
// the nested scan over `repos/<owner>/<repo>/`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  diffFleet,
  discoverTenants,
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
});
