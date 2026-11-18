import { describe, expect, test } from "vite-plus/test";
import { resolveSkillUpdatesOptions, SKILL_UPDATES_OPTION_DEFAULTS } from "./options.ts";

const AT = "kinds.skill-updates";

describe("resolveSkillUpdatesOptions", () => {
  test("no block is the defaults", () => {
    expect(resolveSkillUpdatesOptions(undefined, AT)).toEqual({
      every: "1d",
      minAge: "3d",
      ignore: [],
      lockPath: "skills-lock.json",
      labels: [],
    });
    expect(resolveSkillUpdatesOptions({}, AT)).toEqual(SKILL_UPDATES_OPTION_DEFAULTS);
  });

  test("every option is read", () => {
    expect(
      resolveSkillUpdatesOptions(
        {
          every: "12h",
          minAge: "0d",
          ignore: ["ask-matt"],
          lockPath: "tools/skills-lock.json",
          labels: ["skills"],
        },
        AT,
      ),
    ).toEqual({
      every: "12h",
      minAge: "0d",
      ignore: ["ask-matt"],
      lockPath: "tools/skills-lock.json",
      labels: ["skills"],
    });
  });

  test("an unknown option fails, naming the block", () => {
    expect(() => resolveSkillUpdatesOptions({ skillsDir: "x" }, AT)).toThrow(
      /kinds\.skill-updates: unknown option `skillsDir`/,
    );
  });

  test.each([
    [{ every: "daily" }, /every/],
    [{ every: "0d" }, /every/],
    [{ minAge: 3 }, /minAge/],
    [{ ignore: "ask-matt" }, /ignore/],
    [{ labels: [""] }, /labels/],
    [{ lockPath: "../skills-lock.json" }, /lockPath/],
    [{ lockPath: "/etc/skills-lock.json" }, /lockPath/],
  ])("%j is refused", (block, problem) => {
    expect(() => resolveSkillUpdatesOptions(block, AT)).toThrow(problem);
  });
});
