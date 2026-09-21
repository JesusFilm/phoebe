// The tenant secret store (#504), against a real state directory: the mode on
// disk, the strict/tolerant split between the write path and the delivery
// paths, the derived settable set, and the clear that leaves no tombstone.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  appendSecretEdit,
  clearSecret,
  lastEditFor,
  offCatalogueRefusal,
  readSecretEdits,
  readSecretStore,
  SECRET_FILE_MODE,
  secretEditsPath,
  secretStorePath,
  setSecret,
  settableSecretKeys,
  tenantSecrets,
  tenantStateDir,
  unsettableReason,
  writeSecretStore,
} from "./secret-store.ts";

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "phoebe-secret-store-"));
  stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the store on disk", () => {
  test("a written store round-trips and lands at 0600", () => {
    writeSecretStore(stateDir, { ANTHROPIC_API_KEY: "sk-live" });
    expect(readSecretStore(stateDir)).toEqual({ ANTHROPIC_API_KEY: "sk-live" });
    expect(statSync(secretStorePath(stateDir)).mode & 0o777).toBe(SECRET_FILE_MODE);
  });

  test("a rewrite keeps the mode, so a rotation cannot widen the file", () => {
    writeSecretStore(stateDir, { ANTHROPIC_API_KEY: "sk-one" });
    chmodSync(secretStorePath(stateDir), 0o644);
    writeSecretStore(stateDir, { ANTHROPIC_API_KEY: "sk-two" });
    expect(statSync(secretStorePath(stateDir)).mode & 0o777).toBe(SECRET_FILE_MODE);
  });

  test("no store is an empty store, not an error", () => {
    expect(readSecretStore(join(root, "nowhere"))).toEqual({});
    expect(tenantSecrets(join(root, "nowhere"))).toEqual({});
  });

  test("a blank value is no value, matching every other env tier", () => {
    writeSecretStore(stateDir, { GH_TOKEN: "", ANTHROPIC_API_KEY: "sk-live" });
    expect(readSecretStore(stateDir)).toEqual({ ANTHROPIC_API_KEY: "sk-live" });
  });

  test("the write path refuses to clobber a store it cannot parse", () => {
    writeFileSync(secretStorePath(stateDir), "{ this is not json");
    expect(() => readSecretStore(stateDir)).toThrow(/not valid JSON/);
    writeFileSync(secretStorePath(stateDir), JSON.stringify({ schema: 1 }));
    expect(() => readSecretStore(stateDir)).toThrow(/values/);
  });

  test("a delivery path reads a broken store as no store at all", () => {
    writeFileSync(secretStorePath(stateDir), "{ this is not json");
    expect(tenantSecrets(stateDir)).toEqual({});
  });

  test("a tenant with no slug has no store to read", () => {
    expect(tenantStateDir(null, "/data/repos")).toBeNull();
    expect(tenantStateDir("  ", "/data/repos")).toBeNull();
    expect(tenantSecrets(null)).toEqual({});
  });

  test("the store sits under the tenant's own derived state dir", () => {
    expect(tenantStateDir("acme/widget", "/data/repos")).toBe("/data/repos/acme/widget/state");
  });
});

describe("setting and clearing", () => {
  test("a set writes the value and records an edit that never holds it", () => {
    const edit = setSecret({ stateDir, key: "ANTHROPIC_API_KEY", value: "sk-live" });
    expect(readSecretStore(stateDir)).toEqual({ ANTHROPIC_API_KEY: "sk-live" });
    const edits = readSecretEdits(stateDir);
    expect(edits).toEqual([edit]);
    expect(Object.keys(edits[0]!).sort()).toEqual(["at", "by", "id", "key"]);
    expect(readFileSync(secretEditsPath(stateDir), "utf8")).not.toContain("sk-live");
    expect(statSync(secretEditsPath(stateDir)).mode & 0o777).toBe(SECRET_FILE_MODE);
  });

  test("a local set is stamped `local`; the relay arm passes a person", () => {
    expect(setSecret({ stateDir, key: "GH_TOKEN", value: "ghp_one" }).by).toBe("local");
    expect(setSecret({ stateDir, key: "GH_TOKEN", value: "ghp_two", by: "a@b.test" }).by).toBe(
      "a@b.test",
    );
  });

  test("a rotation leaves one entry and two ledger lines", () => {
    setSecret({ stateDir, key: "GH_TOKEN", value: "ghp_one", at: "2026-01-01T00:00:00.000Z" });
    setSecret({ stateDir, key: "GH_TOKEN", value: "ghp_two", at: "2026-02-01T00:00:00.000Z" });
    expect(readSecretStore(stateDir)).toEqual({ GH_TOKEN: "ghp_two" });
    const edits = readSecretEdits(stateDir);
    expect(edits).toHaveLength(2);
    expect(lastEditFor(edits, "GH_TOKEN")?.at).toBe("2026-02-01T00:00:00.000Z");
  });

  test("a clear removes the entry and leaves no tombstone behind", () => {
    setSecret({ stateDir, key: "GH_TOKEN", value: "ghp_one" });
    setSecret({ stateDir, key: "ANTHROPIC_API_KEY", value: "sk-live" });
    const { cleared } = clearSecret({ stateDir, key: "GH_TOKEN" });
    expect(cleared).toBe(true);
    const store = readSecretStore(stateDir);
    expect(store).toEqual({ ANTHROPIC_API_KEY: "sk-live" });
    expect("GH_TOKEN" in store).toBe(false);
    expect(readFileSync(secretStorePath(stateDir), "utf8")).not.toContain("GH_TOKEN");
  });

  test("clearing a key the store never held is a no-op, not a failure", () => {
    const { cleared, edit } = clearSecret({ stateDir, key: "GH_TOKEN" });
    expect(cleared).toBe(false);
    expect(edit).toBeUndefined();
    expect(readSecretEdits(stateDir)).toEqual([]);
  });

  test("a malformed ledger is no history, never a failed write", () => {
    writeFileSync(secretEditsPath(stateDir), "not json");
    expect(readSecretEdits(stateDir)).toEqual([]);
    appendSecretEdit(stateDir, { id: "1", key: "GH_TOKEN", at: "2026-01-01", by: "local" });
    expect(readSecretEdits(stateDir)).toHaveLength(1);
  });
});

describe("what may be set", () => {
  test("the settable set is derived from the tenant, never listed", () => {
    expect(
      settableSecretKeys({
        declaredEnv: ["LINEAR_API_KEY", "SENTRY_DSN"],
        providerEnv: { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY" },
      }),
    ).toEqual(["ANTHROPIC_API_KEY", "GH_TOKEN", "LINEAR_API_KEY", "OPENAI_API_KEY", "SENTRY_DSN"]);
  });

  test("a custom kind's key is settable the day the kind declares it", () => {
    expect(settableSecretKeys({ declaredEnv: ["ACME_TOKEN"], providerEnv: {} })).toContain(
      "ACME_TOKEN",
    );
  });

  test("the App credentials are never settable, whatever a kind declares", () => {
    expect(
      settableSecretKeys({
        declaredEnv: ["GH_APP_ID", "GH_APP_PRIVATE_KEY"],
        providerEnv: {},
      }),
    ).toEqual(["GH_TOKEN"]);
    expect(unsettableReason("GH_APP_PRIVATE_KEY")).toMatch(/deployment-scope/);
  });

  test("a tenant's own GH_TOKEN is settable — it is the agent's, not the clone's", () => {
    expect(unsettableReason("GH_TOKEN")).toBeNull();
  });

  test("settings and git identity are somebody else's channel", () => {
    expect(unsettableReason("PHOEBE_MODEL")).toMatch(/setting, not a secret/);
    expect(unsettableReason("GIT_AUTHOR_EMAIL")).toMatch(/gitIdentity/);
    expect(settableSecretKeys({ declaredEnv: ["PHOEBE_MODEL"], providerEnv: {} })).toEqual([
      "GH_TOKEN",
    ]);
  });

  test("an off-catalogue key is refused with the fallback, not just refused", () => {
    const refusal = offCatalogueRefusal("STRIPE_KEY", ["GH_TOKEN", "ANTHROPIC_API_KEY"]);
    expect(refusal).toContain("GH_TOKEN, ANTHROPIC_API_KEY");
    expect(refusal).toMatch(/requiredEnv|\.env/);
  });
});
