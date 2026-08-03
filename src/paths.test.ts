// Contract tests for per-tenant path derivation (#58/#62): paths are a pure
// function of the repo slug and the deployment data base, so a tenant's on-disk
// layout can never drift from its authoritative slug.

import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_DATA_BASE, derivePaths, resolveDataBase } from "./paths.ts";

describe("derivePaths", () => {
  test("nests repo/worktrees/state under <base>/<owner>/<repo>", () => {
    expect(derivePaths("acme/widget")).toEqual({
      repoDir: "/data/repos/acme/widget/repo",
      worktreesDir: "/data/repos/acme/widget/worktrees",
      stateDir: "/data/repos/acme/widget/state",
    });
  });

  test("defaults the base to /data/repos", () => {
    expect(derivePaths("acme/widget").repoDir.startsWith(`${DEFAULT_DATA_BASE}/`)).toBe(true);
  });

  test("honors an explicit data base", () => {
    expect(derivePaths("acme/widget", "/srv/phoebe")).toEqual({
      repoDir: "/srv/phoebe/acme/widget/repo",
      worktreesDir: "/srv/phoebe/acme/widget/worktrees",
      stateDir: "/srv/phoebe/acme/widget/state",
    });
  });

  test("two tenants never share a subtree", () => {
    const a = derivePaths("acme/widget");
    const b = derivePaths("acme/gadget");
    expect(a.repoDir).not.toBe(b.repoDir);
    expect(a.stateDir).not.toBe(b.stateDir);
  });
});

describe("resolveDataBase", () => {
  test("defaults to /data/repos when PHOEBE_DATA_DIR is unset", () => {
    expect(resolveDataBase({})).toBe(DEFAULT_DATA_BASE);
  });

  test("PHOEBE_DATA_DIR overrides the base for host/dev", () => {
    expect(resolveDataBase({ PHOEBE_DATA_DIR: "/tmp/phoebe" })).toBe("/tmp/phoebe");
  });

  test("an empty PHOEBE_DATA_DIR is ignored, not treated as a base", () => {
    expect(resolveDataBase({ PHOEBE_DATA_DIR: "" })).toBe(DEFAULT_DATA_BASE);
  });
});
