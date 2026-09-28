// Ages, in the coarse words the tabs print them in.

import { describe, expect, test } from "vite-plus/test";
import { age } from "./facts.ts";
import { ago, NOW } from "./test-fixture.ts";

describe("ages", () => {
  test("coarsen as they grow", () => {
    expect(age(ago(0), NOW)).toBe("0 s");
    expect(age(ago(59), NOW)).toBe("59 s");
    expect(age(ago(23 * 60), NOW)).toBe("23 min");
    expect(age(ago(6 * 3600), NOW)).toBe("6 h");
    expect(age(ago(47 * 3600), NOW)).toBe("47 h");
    expect(age(ago(2 * 86_400), NOW)).toBe("2 d");
  });

  test("a clock behind the writer's does not read as the future", () => {
    expect(age(new Date(NOW.getTime() + 5000).toISOString(), NOW)).toBe("0 s");
  });

  test("something that is not an instant says so", () => {
    expect(age("not a date", NOW)).toBe("unknown");
  });
});
