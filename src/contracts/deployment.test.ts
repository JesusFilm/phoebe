// The deployment report type is types only, with one exception: the `schema`
// integer, which a reader compares against before trusting a file it did not
// write. A runtime value in contracts is written twice (index.ts for the type
// condition, index.mjs for Node's), so this holds the two copies together.

import { describe, expect, test } from "vite-plus/test";
import { DEPLOYMENT_SCHEMA } from "./deployment.ts";
import { DEPLOYMENT_SCHEMA as MIRRORED } from "./index.mjs";

describe("DEPLOYMENT_SCHEMA", () => {
  test("the .mjs mirror carries the same value the .ts declares", () => {
    expect(MIRRORED).toBe(DEPLOYMENT_SCHEMA);
  });

  test("it is an integer — a reader compares it, it does not parse it", () => {
    expect(Number.isInteger(DEPLOYMENT_SCHEMA)).toBe(true);
  });
});
