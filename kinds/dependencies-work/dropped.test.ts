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
      { package: "vite", version: "8.0.0", tooNew: false },
      { package: "@types/node", version: "26.1.0", tooNew: false },
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
      { package: "electron", version: "45.3.2", tooNew: true },
      { package: "@scope/pkg", version: "2.0.0", tooNew: true },
      { package: "jsdom", version: "31.0.1", tooNew: false },
    ]);
  });

  test("no heading, no entries", () => {
    expect(parseDropped("Closes #12\n\n- `vite@8.0.0`: fine")).toEqual([]);
  });
});
