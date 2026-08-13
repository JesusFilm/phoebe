import { describe, expect, test } from "vite-plus/test";
import { resolveCredentialArm } from "./credential-arm.ts";

describe("resolveCredentialArm", () => {
  test("pat arm when GH_APP_ID is absent", () => {
    expect(resolveCredentialArm({})).toBe("pat");
    expect(resolveCredentialArm({ GH_TOKEN: "ghp_abc" })).toBe("pat");
  });

  test("pat arm when GH_APP_ID is empty or blank", () => {
    expect(resolveCredentialArm({ GH_APP_ID: "" })).toBe("pat");
    expect(resolveCredentialArm({ GH_APP_ID: "   " })).toBe("pat");
  });

  test("app arm when GH_APP_ID is set", () => {
    expect(resolveCredentialArm({ GH_APP_ID: "123456" })).toBe("app");
    expect(resolveCredentialArm({ GH_APP_ID: "123456", GH_TOKEN: "ghp_abc" })).toBe("app");
  });
});
