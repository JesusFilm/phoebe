// The mint drop's facts (map #690): what the doctor check reads off it.

import { describe, expect, test } from "vite-plus/test";
import { inspectMintDrop, MINT_DROP_DIR } from "./mint-drop.ts";

describe("inspectMintDrop", () => {
  test("a root-owned directory is the healthy answer", () => {
    expect(inspectMintDrop(() => ({ isDirectory: () => true, uid: 0 }))).toEqual({
      path: MINT_DROP_DIR,
      exists: true,
      isDirectory: true,
      ownedByRoot: true,
    });
  });

  test("missing, a file, or the wrong owner are each visible", () => {
    expect(
      inspectMintDrop(() => {
        throw new Error("ENOENT");
      }),
    ).toMatchObject({ exists: false });
    expect(inspectMintDrop(() => ({ isDirectory: () => false, uid: 0 }))).toMatchObject({
      isDirectory: false,
    });
    expect(inspectMintDrop(() => ({ isDirectory: () => true, uid: 10001 }))).toMatchObject({
      ownedByRoot: false,
    });
  });
});
