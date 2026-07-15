import { describe, expect, test } from "vite-plus/test";
import { renderPrompt, substitutePromptArgs } from "./prompt.ts";

describe("substitutePromptArgs", () => {
  test("replaces {{KEY}} placeholders, with or without inner spaces", () => {
    const out = substitutePromptArgs("issue {{ISSUE_NUMBER}} / {{ ISSUE_NUMBER }}", {
      ISSUE_NUMBER: "7",
    });
    expect(out).toContain("issue 7 / 7");
  });

  test("throws on a placeholder with no value", () => {
    expect(() => substitutePromptArgs("{{MISSING}}", {})).toThrow(/MISSING/);
  });
});

describe("renderPrompt", () => {
  test("executes template shell blocks and splices trimmed stdout", () => {
    const executed: string[] = [];
    const out = renderPrompt("Context:\n\n!`gh issue view {{N}}`\n\nDone.", { N: "12" }, (cmd) => {
      executed.push(cmd);
      return "issue body\n";
    });
    expect(executed).toEqual(["gh issue view 12"]);
    expect(out).toBe("Context:\n\nissue body\n\nDone.");
  });

  test("shell patterns arriving via substituted values are data, not commands", () => {
    const executed: string[] = [];
    const out = renderPrompt("Body: {{BODY}}", { BODY: "try !`rm -rf /` ok" }, (cmd) => {
      executed.push(cmd);
      return "ran";
    });
    expect(executed).toEqual([]);
    expect(out).toBe("Body: try !`rm -rf /` ok");
  });
});
