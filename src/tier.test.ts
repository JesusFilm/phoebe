import { describe, expect, test } from "vite-plus/test";
import { classifyTier, PHOEBE_TIER_LABEL_PREFIX, TIER_BUNDLES } from "./tier.ts";

describe("classifyTier", () => {
  test("no phoebe:tier:* label present -> undefined", () => {
    expect(classifyTier(["ready-for-agent", "priority:bug"])).toBeUndefined();
    expect(classifyTier([])).toBeUndefined();
  });

  test("each valid label value classifies to its tier", () => {
    expect(classifyTier([`${PHOEBE_TIER_LABEL_PREFIX}basic`])).toBe("basic");
    expect(classifyTier([`${PHOEBE_TIER_LABEL_PREFIX}mid`])).toBe("mid");
    expect(classifyTier([`${PHOEBE_TIER_LABEL_PREFIX}strong`])).toBe("strong");
  });

  test("a malformed/unrecognized value falls back to undefined rather than throwing", () => {
    expect(classifyTier([`${PHOEBE_TIER_LABEL_PREFIX}bogus`])).toBeUndefined();
  });

  test("classifies among other labels regardless of position", () => {
    expect(
      classifyTier(["ready-for-agent", `${PHOEBE_TIER_LABEL_PREFIX}strong`, "priority:bug"]),
    ).toBe("strong");
  });
});

describe("TIER_BUNDLES", () => {
  test("strong is the only tier resolving to opus", () => {
    expect(TIER_BUNDLES.strong.model).toBe("opus");
    expect(TIER_BUNDLES.basic.model).toBe("sonnet");
    expect(TIER_BUNDLES.mid.model).toBe("sonnet");
  });

  test("mid matches the tenant default effort (high); basic is cheaper (low)", () => {
    expect(TIER_BUNDLES.mid.effort).toBe("high");
    expect(TIER_BUNDLES.basic.effort).toBe("low");
    expect(TIER_BUNDLES.strong.effort).toBe("high");
  });
});
