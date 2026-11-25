import { describe, expect, test } from "vite-plus/test";
import { parseFindings } from "./findings.ts";

const known = new Set(["u1", "u2", "u3"]);

function draft(findings: unknown[]): string {
  return JSON.stringify({ findings });
}

const good = {
  category: "factory",
  target: "prompts/issues-prompt.md",
  title: "Issue runs time out installing dependencies",
  problem: "Three runs spent their budget in `pnpm install`.",
  fix: "Raise the run budget.",
  units: ["u1", "u2"],
};

describe("parseFindings", () => {
  test("reads a finding and builds its key", () => {
    const parsed = parseFindings(draft([good]), known);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.findings).toEqual([
      {
        category: "factory",
        target: "prompts/issues-prompt.md",
        key: "factory:prompts/issues-prompt.md",
        title: "Issue runs time out installing dependencies",
        problem: "Three runs spent their budget in `pnpm install`.",
        fix: "Raise the run budget.",
        units: ["u1", "u2"],
      },
    ]);
  });

  test("an empty list is a valid answer", () => {
    expect(parseFindings('{"findings": []}', known)).toEqual({ findings: [], dropped: [] });
  });

  test("drops a finding with a category outside the four, a bad target, or no known unit", () => {
    const parsed = parseFindings(
      draft([
        { ...good, category: "process" },
        { ...good, target: "two words" },
        { ...good, target: "x-->y" },
        { ...good, units: ["u9"] },
        { ...good, title: "  " },
        "nope",
        { ...good, category: "engine", target: "worktree-cleanup" },
      ]),
      known,
    );
    expect(parsed.findings.map((finding) => finding.key)).toEqual(["engine:worktree-cleanup"]);
    expect(parsed.dropped).toEqual([
      'finding 1: category "process" is not one of ticket, convention, factory, engine',
      'finding 2: target "two words" is not a path or slug',
      'finding 3: target "x-->y" is not a path or slug',
      "finding 4: names none of the flagged units",
      "finding 5: no title",
      "finding 6: not an object",
    ]);
  });

  test("two findings on one key become one, their units merged; unknown ids are dropped", () => {
    const parsed = parseFindings(
      draft([good, { ...good, title: "Again", units: ["u2", "u3", "u7"] }]),
      known,
    );
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.units).toEqual(["u1", "u2", "u3"]);
  });

  test("a draft that is not JSON, or has no findings array, throws", () => {
    expect(() => parseFindings("{", known)).toThrow("findings.json is not JSON");
    expect(() => parseFindings('{"items": []}', known)).toThrow("has no `findings` array");
  });
});
