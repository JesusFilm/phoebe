// Reading the Dropped section of a dependencies PR body back out.

import { describe, expect, test } from "vite-plus/test";
import { parseDropped } from "./dropped.ts";

describe("parseDropped", () => {
  test("reads each entry under the heading, scoped names included, skipping the output", () => {
    const body = [
      "Closes #12",
      "",
      "- `not-me@1.0.0`: above the section",
      "",
      "## Dropped",
      "",
      "- `vite@8.0.0`: the config API changed",
      "",
      "<details><summary>vite@8.0.0 failing output</summary>",
      "",
      "```text",
      "- `inside-fence@9.9.9`: not an entry",
      "```",
      "",
      "</details>",
      "",
      "- `@types/node@26.1.0`: type errors in src/",
      "",
      "## Notes",
      "",
      "- `after@2.0.0`: below the section",
    ].join("\n");
    expect(parseDropped(body)).toEqual([
      { package: "vite", version: "8.0.0", tooNew: false, needsOverride: false },
      { package: "@types/node", version: "26.1.0", tooNew: false, needsOverride: false },
    ]);
  });

  test("a bump tagged `(too new)` after its code span is marked as such (#862)", () => {
    const body = [
      "## Dropped",
      "",
      "- `electron@45.3.2` (too new): published today; pnpm's minimumReleaseAge refuses it",
      "- `@scope/pkg@2.0.0` (Too New): the same",
      "- `jsdom@31.0.1`: the tests fail (too new for our setup)",
    ].join("\n");
    expect(parseDropped(body)).toEqual([
      { package: "electron", version: "45.3.2", tooNew: true, needsOverride: false },
      { package: "@scope/pkg", version: "2.0.0", tooNew: true, needsOverride: false },
      { package: "jsdom", version: "31.0.1", tooNew: false, needsOverride: false },
    ]);
  });

  test("no heading, no entries", () => {
    expect(parseDropped("Closes #12\n\n- `vite@8.0.0`: fine")).toEqual([]);
  });

  test("a row tagged `(needs override)` is marked, and is not too new", () => {
    const body = [
      "## Dropped",
      "",
      "- `tar@7.5.4` (needs override): `expo` 54.0.1 asks for `tar` `^6.2.1`",
      "- `@scope/pkg@2.0.0` (Needs Override)",
      "- `lodash@4.17.21`: the gate failed",
    ].join("\n");
    expect(parseDropped(body)).toEqual([
      { package: "tar", version: "7.5.4", tooNew: false, needsOverride: true },
      { package: "@scope/pkg", version: "2.0.0", tooNew: false, needsOverride: true },
      { package: "lodash", version: "4.17.21", tooNew: false, needsOverride: false },
    ]);
  });

  test("a reason that quotes a scoped package does not reach into the entry", () => {
    const body = [
      "## Dropped",
      "",
      "- `@graphql-tools/utils@12.0.2` (needs override): `@graphql-tools/merge` 9.1.6 asks for `@graphql-tools/utils` `^10.11.0`",
      "- `tar@7.5.4`: `@scope/parent` pins it",
    ].join("\n");
    expect(parseDropped(body)).toEqual([
      { package: "@graphql-tools/utils", version: "12.0.2", tooNew: false, needsOverride: true },
      { package: "tar", version: "7.5.4", tooNew: false, needsOverride: false },
    ]);
  });
});
