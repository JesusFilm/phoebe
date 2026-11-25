import { describe, expect, test } from "vite-plus/test";
import { OBSERVER_OPTION_DEFAULTS, resolveObserverOptions } from "./options.ts";

const at = "pipelines.observe.kinds.observer";

describe("resolveObserverOptions", () => {
  test("no block, or an empty one, is the defaults: no schedule, 14d, issues, 3", () => {
    expect(resolveObserverOptions(undefined, at)).toEqual(OBSERVER_OPTION_DEFAULTS);
    expect(resolveObserverOptions({}, at)).toEqual({
      every: null,
      lookback: "14d",
      mode: "issues",
      maxProposals: 3,
    });
  });

  test("takes every field", () => {
    expect(
      resolveObserverOptions({ every: "7d", lookback: "30d", mode: "issues", maxProposals: 5 }, at),
    ).toEqual({ every: "7d", lookback: "30d", mode: "issues", maxProposals: 5 });
  });

  test("an unknown option fails, naming the path and the options there are", () => {
    expect(() => resolveObserverOptions({ evry: "7d" }, at)).toThrow(
      `${at}: unknown option \`evry\`. Expected one of: every, lookback, mode, maxProposals.`,
    );
  });

  test('`mode: "pr"` is refused with what to do instead', () => {
    expect(() => resolveObserverOptions({ mode: "pr" }, at)).toThrow(
      `${at}: \`mode: "pr"\` is not available yet`,
    );
    expect(() => resolveObserverOptions({ mode: "pr" }, at)).toThrow('Set `mode: "issues"`');
    expect(() => resolveObserverOptions({ mode: "both" }, at)).toThrow(
      '`mode` must be "issues" — got "both".',
    );
  });

  test("bad periods and counts fail", () => {
    expect(() => resolveObserverOptions({ every: "weekly" }, at)).toThrow("`every` must be");
    expect(() => resolveObserverOptions({ every: "0d" }, at)).toThrow("`every` must be");
    expect(() => resolveObserverOptions({ lookback: "2 weeks" }, at)).toThrow("`lookback` must be");
    expect(() => resolveObserverOptions({ lookback: "0h" }, at)).toThrow("`lookback` must be");
    expect(() => resolveObserverOptions({ maxProposals: 0 }, at)).toThrow(
      "`maxProposals` must be a positive integer",
    );
    expect(() => resolveObserverOptions({ maxProposals: 1.5 }, at)).toThrow("`maxProposals`");
  });

  test("a block that is not an object fails", () => {
    expect(() => resolveObserverOptions("7d", at)).toThrow("options must be an object");
  });
});
