import { describe, expect, test } from "vite-plus/test";
import { loginMismatchWarning } from "./login-identity.ts";

describe("loginMismatchWarning", () => {
  test("warns naming both identities when the marker author differs from the resolved login (#149)", () => {
    const warning = loginMismatchWarning("phoebe-bot", {
      authorLogin: "phoebe-user",
      createdAt: "2026-08-01T00:00:00Z",
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain("phoebe-bot");
    expect(warning).toContain("phoebe-user");
    expect(warning).toContain("2026-08-01T00:00:00Z");
  });

  test("stays silent when the marker author matches the resolved login", () => {
    expect(
      loginMismatchWarning("phoebe-bot", {
        authorLogin: "phoebe-bot",
        createdAt: "2026-08-01T00:00:00Z",
      }),
    ).toBeNull();
  });

  test("stays silent when no marker has ever been posted", () => {
    expect(loginMismatchWarning("phoebe-bot", null)).toBeNull();
  });
});
