import { describe, expect, test } from "vite-plus/test";
import { resolveBenchOptions } from "./options.ts";

const AT = "kinds.bench";

describe("resolveBenchOptions", () => {
  test("fills the defaults around a suite", () => {
    expect(resolveBenchOptions({ suite: "bench/suite.json" }, AT, {})).toEqual({
      suite: "bench/suite.json",
      maxFixtures: 10,
      repeat: 1,
      judge: null,
    });
  });

  test("takes every option the file sets", () => {
    const judge = { provider: "claude", model: "claude-opus-5-5" };
    expect(
      resolveBenchOptions({ suite: "s.json", maxFixtures: 4, repeat: 2, judge }, AT, {}),
    ).toEqual({ suite: "s.json", maxFixtures: 4, repeat: 2, judge });
  });

  test("refuses a bad value with the path it came from", () => {
    expect(() => resolveBenchOptions({ suite: "s", maxFixtures: 0 }, AT, {})).toThrow(
      "kinds.bench: `maxFixtures` must be a positive integer",
    );
    expect(() => resolveBenchOptions({ suite: "s", repeat: 1.5 }, AT, {})).toThrow(
      "`repeat` must be a positive integer",
    );
    expect(() =>
      resolveBenchOptions({ suite: "s", judge: { provider: "claude" } }, AT, {}),
    ).toThrow("the judge needs both a provider and a model");
    expect(() => resolveBenchOptions("bench/suite.json", AT, {})).toThrow("must be an object");
  });

  test("a half judge in the file is completed by the env name", () => {
    expect(
      resolveBenchOptions({ suite: "s", judge: { provider: "claude" } }, AT, {
        PHOEBE_BENCH_JUDGE_MODEL: "claude-opus-5-5",
      }).judge,
    ).toEqual({ provider: "claude", model: "claude-opus-5-5" });
    expect(() =>
      resolveBenchOptions({ suite: "s", judge: { provider: "claude", extra: 1 } }, AT, {
        PHOEBE_BENCH_JUDGE_MODEL: "m",
      }),
    ).toThrow("extra");
  });

  test("the env names beat the file", () => {
    const env = {
      PHOEBE_BENCH_SUITE: "bench/other.json",
      PHOEBE_BENCH_MAX_FIXTURES: "3",
      PHOEBE_BENCH_REPEAT: "2",
      PHOEBE_BENCH_JUDGE_MODEL: "claude-sonnet-5-5",
    };
    expect(
      resolveBenchOptions(
        { suite: "bench/suite.json", judge: { provider: "claude", model: "claude-opus-5-5" } },
        AT,
        env,
      ),
    ).toEqual({
      suite: "bench/other.json",
      maxFixtures: 3,
      repeat: 2,
      judge: { provider: "claude", model: "claude-sonnet-5-5" },
    });
    // The suite may come from env alone.
    expect(resolveBenchOptions({}, AT, { PHOEBE_BENCH_SUITE: "s.json" }).suite).toBe("s.json");
  });

  test("an env value that does not parse names the variable", () => {
    expect(() => resolveBenchOptions({ suite: "s" }, AT, { PHOEBE_BENCH_REPEAT: "twice" })).toThrow(
      "PHOEBE_BENCH_REPEAT must be a positive integer",
    );
    expect(() =>
      resolveBenchOptions({ suite: "s" }, AT, {
        PHOEBE_BENCH_JUDGE_PROVIDER: "gemini",
        PHOEBE_BENCH_JUDGE_MODEL: "m",
      }),
    ).toThrow("PHOEBE_BENCH_JUDGE_PROVIDER must be one of claude, cursor, codex");
  });

  test("a judge needs both leaves, from either channel", () => {
    expect(() =>
      resolveBenchOptions({ suite: "s" }, AT, { PHOEBE_BENCH_JUDGE_PROVIDER: "claude" }),
    ).toThrow("the judge needs both a provider and a model, and only a provider is set");
    expect(
      resolveBenchOptions({ suite: "s" }, AT, {
        PHOEBE_BENCH_JUDGE_PROVIDER: "codex",
        PHOEBE_BENCH_JUDGE_MODEL: "gpt-5.5",
      }).judge,
    ).toEqual({ provider: "codex", model: "gpt-5.5" });
  });
});
