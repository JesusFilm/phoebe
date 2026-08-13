import { describe, expect, test } from "vite-plus/test";
import { resolveCredentialArm } from "./credential-arm.ts";

describe("resolveCredentialArm", () => {
  test("explicit GH_TOKEN yields pat", () => {
    expect(resolveCredentialArm({ GH_TOKEN: "ghs_token123" })).toBe("pat");
  });

  test("absent GH_TOKEN yields app", () => {
    expect(resolveCredentialArm({})).toBe("app");
  });

  test("empty-string GH_TOKEN yields app", () => {
    expect(resolveCredentialArm({ GH_TOKEN: "" })).toBe("app");
  });

  test("undefined GH_TOKEN yields app", () => {
    expect(resolveCredentialArm({ GH_TOKEN: undefined })).toBe("app");
  });

  test("App vars alongside GH_TOKEN still yield pat — token wins", () => {
    expect(resolveCredentialArm({ GH_TOKEN: "ghs_tok", PHOEBE_GH_APP_ID: "12345" })).toBe("pat");
  });

  test("App vars without GH_TOKEN yield app", () => {
    expect(
      resolveCredentialArm({ PHOEBE_GH_APP_ID: "12345", PHOEBE_GH_APP_PRIVATE_KEY: "base64" }),
    ).toBe("app");
  });
});
