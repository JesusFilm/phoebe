// Which files a tenant runs on, read off the config's text (#663). The rule is
// the bootstrapper's and is tested with discovery (bootstrap/tenants.test.ts);
// this covers the companion's half, which is reading the rule's two inputs out
// of source it never loads.

import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { tenantFilesOf } from "./tenant-files.ts";

const TENANT = path.join("/w", "widget");
const ROOT = path.join(TENANT, "phoebe.config.ts");
const NESTED = path.join(TENANT, ".phoebe", "phoebe.config.ts");

/** A disk holding exactly these files. */
function disk(files: Record<string, string>) {
  return {
    exists: (file: string) => Object.hasOwn(files, file),
    read: (file: string) => {
      if (!Object.hasOwn(files, file)) throw new Error(`ENOENT ${file}`);
      return files[file] as string;
    },
  };
}

describe("the files a tenant runs on", () => {
  test("a whole config at the root, with its .env beside it", () => {
    const files = tenantFilesOf(
      TENANT,
      disk({ [ROOT]: `export default { repoSlug: "acme/widget" };\n` }),
    );

    expect(files).toEqual({
      rootConfigPath: ROOT,
      configPath: ROOT,
      envPath: path.join(TENANT, ".env"),
    });
  });

  test("a configDir moves the .env and leaves a whole config governing", () => {
    const files = tenantFilesOf(
      TENANT,
      disk({
        [ROOT]: `export default { repoSlug: "acme/widget", configDir: ".phoebe" };\n`,
        // A second whole config for a standalone deployment, as a folder had
        // before pointers. The root still declares its slug, so it governs.
        [NESTED]: `export default { repoSlug: "acme/widget" };\n`,
      }),
    );

    expect(files.configPath).toBe(ROOT);
    expect(files.envPath).toBe(path.join(TENANT, ".phoebe", ".env"));
  });

  test("a pointer hands over to the config in its asset directory", () => {
    const files = tenantFilesOf(
      TENANT,
      disk({
        [ROOT]: `export default { configDir: ".phoebe" };\n`,
        [NESTED]: `export default { repoSlug: "acme/widget" };\n`,
      }),
    );

    expect(files).toEqual({
      rootConfigPath: ROOT,
      configPath: NESTED,
      envPath: path.join(TENANT, ".phoebe", ".env"),
    });
  });

  test("a pointer at a directory with no config still answers the root", () => {
    const files = tenantFilesOf(
      TENANT,
      disk({ [ROOT]: `export default { configDir: ".phoebe" };\n` }),
    );

    expect(files.configPath).toBe(ROOT);
  });

  test("a repoSlug the root computes counts as declared", () => {
    const files = tenantFilesOf(
      TENANT,
      disk({
        [ROOT]: `const slug = process.env.SLUG;\nexport default { repoSlug: slug, configDir: ".phoebe" };\n`,
        [NESTED]: `export default { repoSlug: "acme/widget" };\n`,
      }),
    );

    expect(files.configPath).toBe(ROOT);
  });

  test("a configDir the bootstrapper would refuse is not followed", () => {
    const outside = path.join("/w", "elsewhere", "phoebe.config.ts");
    const files = tenantFilesOf(
      TENANT,
      disk({
        [ROOT]: `export default { configDir: "../elsewhere" };\n`,
        [outside]: `export default { repoSlug: "acme/other" };\n`,
      }),
    );

    expect(files.configPath).toBe(ROOT);
    expect(files.envPath).toBe(path.join(TENANT, ".env"));
  });

  test("a folder with no config, or one that cannot be read, answers its own root", () => {
    expect(tenantFilesOf(TENANT, disk({}))).toEqual({
      rootConfigPath: ROOT,
      configPath: ROOT,
      envPath: path.join(TENANT, ".env"),
    });
    const unreadable = {
      exists: () => true,
      read: () => {
        throw new Error("EACCES");
      },
    };
    expect(tenantFilesOf(TENANT, unreadable).configPath).toBe(ROOT);
  });
});
