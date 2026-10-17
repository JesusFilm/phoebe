// The deployment id (map #690): minted once, stable across boots, new after
// the file is removed.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  DEPLOYMENT_ID_RE,
  deploymentIdPath,
  mintDeploymentId,
  readOrMintDeploymentId,
} from "./deployment-id.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-dep-id-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mintDeploymentId", () => {
  test("is dep_ and 26 Crockford characters, no I, L, O or U", () => {
    for (let i = 0; i < 50; i++) {
      const id = mintDeploymentId();
      expect(id).toMatch(DEPLOYMENT_ID_RE);
      expect(id).not.toMatch(/[ILOU]/);
    }
  });

  test("uses every byte the source hands it", () => {
    const id = mintDeploymentId((n) => Buffer.alloc(n, 0));
    expect(id).toBe(`dep_${"0".repeat(26)}`);
  });
});

describe("readOrMintDeploymentId", () => {
  test("mints once and reads the same id back", () => {
    const base = tmp();
    const first = readOrMintDeploymentId(base);
    expect(first).toMatch(DEPLOYMENT_ID_RE);
    expect(readFileSync(deploymentIdPath(base), "utf8")).toBe(`${first}\n`);
    expect(readOrMintDeploymentId(base)).toBe(first);
  });

  test("a removed file is a new deployment", () => {
    const base = tmp();
    const first = readOrMintDeploymentId(base);
    rmSync(deploymentIdPath(base));
    expect(readOrMintDeploymentId(base)).not.toBe(first);
  });

  test("a file that holds something else is replaced rather than trusted", () => {
    const base = tmp();
    mkdirSync(join(base, "state"), { recursive: true });
    writeFileSync(deploymentIdPath(base), "garbage\n");
    expect(readOrMintDeploymentId(base)).toMatch(DEPLOYMENT_ID_RE);
  });
});
