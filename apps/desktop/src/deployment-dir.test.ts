import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { deploymentDirOf } from "./deployment-dir.ts";

const DIR = "/repos/phoebe";

function folder(...files: string[]): (file: string) => boolean {
  const present = new Set(files.map((file) => path.join(DIR, file)));
  return (file) => present.has(file);
}

describe("where an install's deployment is", () => {
  test("a compose file at the root is the stock layout, and the root is the deployment", () => {
    expect(deploymentDirOf(DIR, folder(path.join("container", "compose.yml")))).toEqual({
      dir: DIR,
      nested: null,
    });
  });

  test("a repo that is a workspace child at the root and solo in .phoebe/ is driven from .phoebe/", () => {
    const exists = folder(
      "phoebe.config.ts",
      path.join(".phoebe", "phoebe.config.ts"),
      path.join(".phoebe", "container", "compose.yml"),
    );

    expect(deploymentDirOf(DIR, exists)).toEqual({
      dir: path.join(DIR, ".phoebe"),
      nested: ".phoebe",
    });
  });

  test("the root wins when both carry a compose file", () => {
    const exists = folder(
      path.join("container", "compose.yml"),
      path.join(".phoebe", "container", "compose.yml"),
    );

    expect(deploymentDirOf(DIR, exists).nested).toBeNull();
  });

  test("a folder with neither is its own root, so init has somewhere to scaffold", () => {
    expect(deploymentDirOf(DIR, folder("phoebe.config.ts"))).toEqual({ dir: DIR, nested: null });
    expect(deploymentDirOf(DIR, () => false)).toEqual({ dir: DIR, nested: null });
  });
});
