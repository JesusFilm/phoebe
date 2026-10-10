// A host verb run in a tenant's directory lands on the config the tenant runs
// on (#663). The rule itself is tested with discovery (bootstrap/tenants.test.ts);
// this covers the wrapper's one job, which is to answer a path and never throw.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { followConfigPointer } from "./config-pointer.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phoebe-pointer-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(at: string, body: string): string {
  mkdirSync(at, { recursive: true });
  const path = join(at, "phoebe.config.ts");
  writeFileSync(path, body);
  return path;
}

describe("followConfigPointer", () => {
  test("a pointer answers the config in its asset dir, loaded off disk", async () => {
    const root = writeConfig(dir, `export default { configDir: ".phoebe" };\n`);
    const governing = writeConfig(
      join(dir, ".phoebe"),
      `export default { repoSlug: "acme/widget" };\n`,
    );

    expect(await followConfigPointer(root)).toBe(governing);
  });

  test("a whole config answers itself, even beside a second config in its asset dir", async () => {
    const root = writeConfig(
      dir,
      `export default { repoSlug: "acme/widget", configDir: ".phoebe" };\n`,
    );
    writeConfig(join(dir, ".phoebe"), `export default { repoSlug: "acme/other" };\n`);

    expect(await followConfigPointer(root)).toBe(root);
  });

  test("a config with no configDir answers itself", async () => {
    const root = writeConfig(dir, `export default { repoSlug: "acme/widget" };\n`);

    expect(await followConfigPointer(root)).toBe(root);
  });

  test("a pointer whose asset dir holds no config answers itself", async () => {
    const root = writeConfig(dir, `export default { configDir: ".phoebe" };\n`);

    expect(await followConfigPointer(root)).toBe(root);
  });

  test("a config that will not load answers itself rather than throwing", async () => {
    const root = join(dir, "phoebe.config.ts");
    const failing = async (): Promise<unknown> => {
      throw new Error("unexpected token");
    };

    expect(await followConfigPointer(root, failing)).toBe(root);
  });

  test("a malformed configDir answers itself rather than throwing", async () => {
    const root = join(dir, "phoebe.config.ts");

    expect(
      await followConfigPointer(
        root,
        async () => ({ configDir: "../elsewhere" }),
        () => true,
      ),
    ).toBe(root);
  });
});
