import { describe, expect, test } from "vite-plus/test";
import { validateWorkOrder } from "./types.ts";

describe("validateWorkOrder", () => {
  test("accepts known kinds", () => {
    expect(validateWorkOrder(["conflicts", "checks", "reviews", "issues"])).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
    ]);
    expect(validateWorkOrder(["conflicts", "issues"])).toEqual(["conflicts", "issues"]);
    expect(validateWorkOrder(["issues"])).toEqual(["issues"]);
  });

  test("accepts research", () => {
    expect(validateWorkOrder(["conflicts", "checks", "reviews", "issues", "research"])).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
      "research",
    ]);
    expect(validateWorkOrder(["research"])).toEqual(["research"]);
  });

  test("throws on empty order", () => {
    expect(() => validateWorkOrder([])).toThrow(/must not be empty/);
  });

  test("throws on unknown kind", () => {
    expect(() => validateWorkOrder(["conflicts", "bogus"])).toThrow(/Unknown work kind/);
  });
});
