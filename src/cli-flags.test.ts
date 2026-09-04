// The one contract behind `--config`/`-c` and `--pipeline` (#460). Each
// subcommand parser has its own tests for the argv it accepts around these two;
// what is pinned here is the part they now share, including the strictness that
// used to be one parser's private habit: a `-`-prefixed word is never a value.

import { describe, expect, test } from "vite-plus/test";
import { matchConfigFlag, matchPipelineFlag } from "./cli-flags.ts";

describe("matchConfigFlag", () => {
  test("reads the value from the next word, for the long and short spellings", () => {
    expect(matchConfigFlag(["--config", "cfg.ts"], 0)).toEqual({ value: "cfg.ts", consumed: 2 });
    expect(matchConfigFlag(["-c", "cfg.ts"], 0)).toEqual({ value: "cfg.ts", consumed: 2 });
  });

  test("reads the value from `--config=<path>`", () => {
    expect(matchConfigFlag(["--config=cfg.ts"], 0)).toEqual({ value: "cfg.ts", consumed: 1 });
  });

  test("matches at the given index, not only the first word", () => {
    expect(matchConfigFlag(["--json", "--config", "cfg.ts"], 1)).toEqual({
      value: "cfg.ts",
      consumed: 2,
    });
  });

  test("returns undefined for a word that is not this flag", () => {
    expect(matchConfigFlag(["--json"], 0)).toBeUndefined();
    expect(matchConfigFlag(["--configure"], 0)).toBeUndefined();
    expect(matchConfigFlag([], 0)).toBeUndefined();
  });

  test("refuses a missing, flag-shaped, or empty value", () => {
    expect(() => matchConfigFlag(["--config"], 0)).toThrow(/requires a path argument/);
    expect(() => matchConfigFlag(["-c"], 0)).toThrow(/requires a path argument/);
    expect(() => matchConfigFlag(["--config", "--json"], 0)).toThrow(/requires a path argument/);
    expect(() => matchConfigFlag(["--config="], 0)).toThrow(/requires a path argument/);
  });
});

describe("matchPipelineFlag", () => {
  test("reads the value from the next word or from `--pipeline=<name>`", () => {
    expect(matchPipelineFlag(["--pipeline", "intake"], 0)).toEqual({
      value: "intake",
      consumed: 2,
    });
    expect(matchPipelineFlag(["--pipeline=intake"], 0)).toEqual({ value: "intake", consumed: 1 });
  });

  test("has no short spelling", () => {
    expect(matchPipelineFlag(["-p", "intake"], 0)).toBeUndefined();
  });

  test("refuses a missing, flag-shaped, or empty value", () => {
    expect(() => matchPipelineFlag(["--pipeline"], 0)).toThrow(/requires a pipeline name/);
    expect(() => matchPipelineFlag(["--pipeline", "--dry-run"], 0)).toThrow(
      /requires a pipeline name/,
    );
    expect(() => matchPipelineFlag(["--pipeline="], 0)).toThrow(/requires a pipeline name/);
  });
});
