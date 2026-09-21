// The secrets inventory the report carries (#550): which keys get a line, where
// each one says its value came from, and the reason a key that cannot be set
// carries instead of a button.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { SecretListing, TenantSecrets } from "./contracts/secrets.ts";
import { secretInventory, tenantSecrets, type InventoryTenant } from "./secret-inventory.ts";
import { setSecret } from "./secret-store.ts";

const TENANT_CONFIG = `const config = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "pnpm install",
  checkCommand: "pnpm check",
  testCommand: "pnpm test",
  providerEnv: { claude: "ANTHROPIC_API_KEY" },
};
export default config;
`;

let root: string;
let dataBase: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "phoebe-secret-inventory-"));
  dataBase = join(root, "data");
  mkdirSync(join(dataBase, "acme", "widget", "state"), { recursive: true });
  writeFileSync(join(root, "phoebe.config.ts"), TENANT_CONFIG);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const stateDir = (): string => join(dataBase, "acme", "widget", "state");

const tenant = (overrides: Partial<InventoryTenant> = {}): InventoryTenant => ({
  configPath: join(root, "phoebe.config.ts"),
  path: root,
  slug: "acme/widget",
  ...overrides,
});

const deps = (processEnv: NodeJS.ProcessEnv = {}) => ({ dataBase, processEnv });

const keyed = (section: TenantSecrets, key: string): SecretListing | undefined =>
  section.keys.find((listing) => listing.key === key);

describe("one tenant's keys", () => {
  test("a key the store holds says so, with who set it and when", async () => {
    setSecret({
      stateDir: stateDir(),
      key: "ANTHROPIC_API_KEY",
      value: "sk-live",
      by: "ada@example.test",
      at: "2026-09-18T09:00:00.000Z",
    });

    const section = await tenantSecrets(tenant(), deps());

    expect(keyed(section, "ANTHROPIC_API_KEY")).toEqual({
      key: "ANTHROPIC_API_KEY",
      present: true,
      source: "store",
      setAt: "2026-09-18T09:00:00.000Z",
      by: "ada@example.test",
    });
  });

  test("and never the value, nor a piece of one", async () => {
    // The whole promise of write-only, as one assertion: no value, no last four,
    // no hash, no length. The store's plaintext is on the volume and this is the
    // object that leaves the container.
    setSecret({ stateDir: stateDir(), key: "ANTHROPIC_API_KEY", value: "sk-live-abcd1234" });

    const section = await tenantSecrets(tenant(), deps());

    const serialised = JSON.stringify(section);
    expect(serialised).not.toContain("sk-live");
    expect(serialised).not.toContain("1234");
  });

  test("a key only the tenant's .env holds is present, from the file", async () => {
    writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=from-the-file\n");

    const section = await tenantSecrets(tenant(), deps());

    expect(keyed(section, "ANTHROPIC_API_KEY")).toEqual({
      key: "ANTHROPIC_API_KEY",
      present: true,
      source: "tenantEnv",
    });
  });

  test("the store over a file is flagged shadowed, not silently won", async () => {
    writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=from-the-file\n");
    setSecret({ stateDir: stateDir(), key: "ANTHROPIC_API_KEY", value: "from-the-store" });

    const section = await tenantSecrets(tenant(), deps());

    expect(keyed(section, "ANTHROPIC_API_KEY")).toMatchObject({
      source: "store",
      shadowed: true,
    });
  });

  test("a key nothing holds is missing, which is a fact and not an error", async () => {
    const section = await tenantSecrets(tenant(), deps());
    expect(keyed(section, "ANTHROPIC_API_KEY")).toEqual({
      key: "ANTHROPIC_API_KEY",
      present: false,
      source: "missing",
    });
  });

  test("GH_TOKEN is settable at tenant scope, so it carries no reason", async () => {
    const section = await tenantSecrets(tenant(), deps());
    expect(keyed(section, "GH_TOKEN")?.unsettable).toBeUndefined();
  });
});

describe("the keys a console may not set", () => {
  test("the App credentials are listed, with why, rather than hidden", async () => {
    // Hiding them would leave an operator searching the page for a key they can
    // see is in use. The reason is the sentence `phoebe secret set` refuses
    // with, so the page and the shell agree.
    const section = await tenantSecrets(
      tenant(),
      deps({ GH_APP_ID: "123456", GH_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----" }),
    );

    const appId = keyed(section, "GH_APP_ID");
    expect(appId?.present).toBe(true);
    expect(appId?.source).toBe("process");
    expect(appId?.unsettable).toMatch(/deployment-scope credential/);
    expect(keyed(section, "GH_APP_PRIVATE_KEY")?.unsettable).toMatch(/recreate the container/);
  });

  test("an App credential nobody set is still listed, as missing", async () => {
    const section = await tenantSecrets(tenant(), deps());
    expect(keyed(section, "GH_APP_ID")).toMatchObject({ present: false, source: "missing" });
  });

  test("a stale store entry no kind declares any more carries the fallback", async () => {
    // It is still the value a child would hold, so it gets a line — and it is
    // off the catalogue, so a console cannot rotate it. The refusal names the
    // two ways out: declare it in a work kind, or edit the `.env`.
    setSecret({ stateDir: stateDir(), key: "RETIRED_KIND_TOKEN", value: "left-behind" });

    const section = await tenantSecrets(tenant(), deps());

    expect(keyed(section, "RETIRED_KIND_TOKEN")).toMatchObject({
      present: true,
      source: "store",
    });
    expect(keyed(section, "RETIRED_KIND_TOKEN")?.unsettable).toMatch(/not a key this tenant reads/);
  });
});

describe("a tenant whose secrets are unknown", () => {
  test("a held tenant reports the hold and no keys", async () => {
    const section = await tenantSecrets(tenant({ heldReason: "origin has no remote" }), deps());
    expect(section).toEqual({
      tenant: "acme/widget",
      path: root,
      error: "origin has no remote",
      keys: [],
    });
  });

  test("a config that will not load is one error line, not a throw", async () => {
    writeFileSync(join(root, "phoebe.config.ts"), "export default {{{");
    const section = await tenantSecrets(tenant(), deps());
    expect(section.error).not.toBeNull();
    expect(section.keys).toEqual([]);
  });

  test("a tenant with no repoSlug has nowhere to keep a store", async () => {
    writeFileSync(join(root, "phoebe.config.ts"), TENANT_CONFIG.replace(/repoSlug:.*\n/, ""));
    const section = await tenantSecrets(tenant({ slug: null }), deps());
    expect(section.error).toMatch(/declares no `repoSlug`/);
  });

  test("a store that will not parse says so rather than reading as empty", async () => {
    writeFileSync(join(stateDir(), "secrets.json"), "{ not json");
    const section = await tenantSecrets(tenant(), deps());
    expect(section.error).toMatch(/not valid JSON/);
    expect(section.keys).toEqual([]);
  });
});

describe("the section", () => {
  test("one entry per tenant, in the order they were handed over", async () => {
    const other = join(root, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "phoebe.config.ts"),
      TENANT_CONFIG.replace("acme/widget", "acme/gadget"),
    );
    mkdirSync(join(dataBase, "acme", "gadget", "state"), { recursive: true });

    const section = await secretInventory(
      [tenant(), { configPath: join(other, "phoebe.config.ts"), path: other, slug: "acme/gadget" }],
      deps(),
    );

    expect(section.tenants.map((entry) => entry.tenant)).toEqual(["acme/widget", "acme/gadget"]);
  });

  test("one tenant's failure does not take the fleet's inventory with it", async () => {
    const broken = join(root, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "phoebe.config.ts"), "export default {{{");

    const section = await secretInventory(
      [{ configPath: join(broken, "phoebe.config.ts"), path: broken, slug: null }, tenant()],
      deps(),
    );

    expect(section.tenants[0]?.error).not.toBeNull();
    expect(section.tenants[1]?.error).toBeNull();
  });

  test("keys come back sorted, so a rerun is not a diff", async () => {
    const section = await tenantSecrets(tenant(), deps());
    const keys = section.keys.map((listing) => listing.key);
    expect(keys).toEqual([...keys].sort());
  });
});
