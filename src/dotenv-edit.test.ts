// The writer holds one rule above every other: the rest of the file is the
// operator's, and it comes back unchanged.

import { describe, expect, test } from "vite-plus/test";
import { parseDotenv } from "../bootstrap/engine-child-env.ts";
import { setDotenvValue } from "./dotenv-edit.ts";

describe("setting a key that is already there", () => {
  test("rewrites the value and nothing else on the line", () => {
    const before = "# secrets\nGH_TOKEN=ghp_old\nPHOEBE_RELAY_TOKEN=first\n\n# end\n";

    const after = setDotenvValue(before, "PHOEBE_RELAY_TOKEN", "second");

    expect(after).toBe("# secrets\nGH_TOKEN=ghp_old\nPHOEBE_RELAY_TOKEN=second\n\n# end\n");
  });

  test("keeps an `export ` prefix and the indentation in front of it", () => {
    const after = setDotenvValue("  export GH_TOKEN=old\n", "GH_TOKEN", "new");

    expect(after).toBe("  export GH_TOKEN=new\n");
  });

  test("rewrites the last assignment, because that is the one that is read", () => {
    const after = setDotenvValue("KEY=one\nKEY=two\n", "KEY", "three");

    expect(after).toBe("KEY=one\nKEY=three\n");
    expect(parseDotenv(after)["KEY"]).toBe("three");
  });

  test("leaves a commented-out assignment commented out", () => {
    const after = setDotenvValue("#KEY=old\n", "KEY", "new");

    expect(after).toBe("#KEY=old\nKEY=new\n");
  });

  test("does not match a key that merely starts the same way", () => {
    const after = setDotenvValue("PHOEBE_RELAY_TOKEN_OLD=keep\n", "PHOEBE_RELAY_TOKEN", "new");

    expect(after).toBe("PHOEBE_RELAY_TOKEN_OLD=keep\nPHOEBE_RELAY_TOKEN=new\n");
  });
});

describe("appending a key that is not there", () => {
  test("goes on the end, one newline behind it", () => {
    expect(setDotenvValue("GH_TOKEN=x\n", "PHOEBE_RELAY_TOKEN", "t")).toBe(
      "GH_TOKEN=x\nPHOEBE_RELAY_TOKEN=t\n",
    );
  });

  test("an empty file becomes one line, not a blank one and then a line", () => {
    expect(setDotenvValue("", "PHOEBE_RELAY_TOKEN", "t")).toBe("PHOEBE_RELAY_TOKEN=t\n");
  });

  test("a file with no trailing newline gets exactly one", () => {
    expect(setDotenvValue("GH_TOKEN=x", "K", "v")).toBe("GH_TOKEN=x\nK=v\n");
  });
});

describe("quoting", () => {
  test("a pairing token is base64url, so it is written bare", () => {
    const token = "aB3-_xyz0123456789";

    expect(setDotenvValue("", "PHOEBE_RELAY_TOKEN", token)).toBe(`PHOEBE_RELAY_TOKEN=${token}\n`);
  });

  test("a value Compose would read short is quoted, and reads back whole", () => {
    const written = setDotenvValue("", "K", "two words # not a comment");

    expect(written).toBe('K="two words # not a comment"\n');
    expect(parseDotenv(written)["K"]).toBe("two words # not a comment");
  });

  test("a quote inside the value is escaped rather than ending it", () => {
    expect(setDotenvValue("", "K", 'say "hi"')).toBe('K="say \\"hi\\""\n');
  });
});
