import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { workspaceBlockOf, workspaceChildren } from "./workspace-children.ts";

const ROOT = "/repos/workspace";

/** A workspace on disk: which folders hold which subfolders, and which carry a config. */
function disk(tree: Record<string, string[]>, configs: Record<string, string>) {
  const join = (...parts: string[]) => path.join(ROOT, ...parts);
  const files = new Map(
    Object.entries(configs).map(([dir, source]) => [join(dir, "phoebe.config.ts"), source]),
  );
  return {
    listDirs: (dir: string) => tree[path.relative(ROOT, dir) || "."] ?? [],
    exists: (file: string) => files.has(file),
    read: (file: string) => {
      const source = files.get(file);
      if (source === undefined) throw new Error(`no ${file}`);
      return source;
    },
    join,
  };
}

const child = (slug: string) =>
  `const config = {\n  repoSlug: "${slug}",\n};\nexport default config;\n`;

describe("reading the workspace block off the source", () => {
  test("an empty block walks to the default depth", () => {
    expect(workspaceBlockOf("const config = { engine: { ref: 'main' }, workspace: {} };")).toEqual({
      depth: 1,
    });
  });

  test("a depth is honoured", () => {
    expect(workspaceBlockOf("workspace: { depth: 2 },")).toEqual({ depth: 2 });
  });

  test("a declared fleet is the fleet, in its order", () => {
    expect(workspaceBlockOf(`workspace: { tenants: ["service-a", 'service-b'] },`)).toEqual({
      tenants: ["service-a", "service-b"],
    });
  });

  test("no block, no workspace", () => {
    expect(workspaceBlockOf('const config = { repoSlug: "acme/solo" };')).toBeNull();
    expect(workspaceBlockOf(null)).toBeNull();
  });
});

describe("the children under a workspace", () => {
  test("are the folders carrying a config, with their slugs, sorted by slug", () => {
    const d = disk(
      { ".": ["zeta", "alpha", ".git", "node_modules"] },
      { zeta: child("acme/zeta"), alpha: child("acme/alpha") },
    );

    expect(workspaceChildren(ROOT, { depth: 1 }, d)).toEqual([
      { dir: d.join("alpha"), name: "alpha", slug: "acme/alpha" },
      { dir: d.join("zeta"), name: "zeta", slug: "acme/zeta" },
    ]);
  });

  test("dotfolders, node_modules and .git are never walked", () => {
    const d = disk(
      { ".": [".phoebe", "node_modules", ".git", "app"] },
      { ".phoebe": child("acme/hidden"), node_modules: child("acme/nm"), app: child("acme/app") },
    );

    expect(workspaceChildren(ROOT, { depth: 1 }, d).map((c) => c.name)).toEqual(["app"]);
  });

  test("a folder with no config is walked into, to the depth, and no further", () => {
    const d = disk(
      { ".": ["group"], group: ["deep"], "group/deep": ["deeper"] },
      { "group/deep": child("acme/deep"), "group/deep/deeper": child("acme/deeper") },
    );

    expect(workspaceChildren(ROOT, { depth: 1 }, d)).toEqual([]);
    expect(workspaceChildren(ROOT, { depth: 2 }, d).map((c) => c.slug)).toEqual(["acme/deep"]);
  });

  test("a declared fleet is read as declared, skipping a folder with nothing there", () => {
    const d = disk({ ".": ["a", "b"] }, { a: child("acme/a") });

    expect(workspaceChildren(ROOT, { tenants: ["a", "b"] }, d)).toEqual([
      { dir: d.join("a"), name: "a", slug: "acme/a" },
    ]);
  });

  test("a child whose config names no slug is listed by its folder", () => {
    const d = disk({ ".": ["odd"] }, { odd: "const config = {};\nexport default config;\n" });

    expect(workspaceChildren(ROOT, { depth: 1 }, d)).toEqual([
      { dir: d.join("odd"), name: "odd", slug: null },
    ]);
  });
});
