import { describe, expect, test } from "vite-plus/test";
import { resolveCredentialArm } from "./credential-arm.ts";

const APP_ID = { GH_APP_ID: "123456" };

describe("resolveCredentialArm", () => {
  test("pat arm when an explicit GH_TOKEN is present", () => {
    expect(resolveCredentialArm({ GH_TOKEN: "ghp_abc" })).toBe("pat");
  });

  test("an explicit token wins over a deployment App key (#156)", () => {
    expect(resolveCredentialArm({ GH_TOKEN: "ghp_abc" }, APP_ID)).toBe("pat");
  });

  test("app arm when there is no token and the deployment holds an App key", () => {
    expect(resolveCredentialArm({}, APP_ID)).toBe("app");
    expect(resolveCredentialArm({ GH_TOKEN: "" }, APP_ID)).toBe("app");
    expect(resolveCredentialArm({ GH_TOKEN: undefined }, APP_ID)).toBe("app");
  });

  test("a blank token is not explicit — it falls through to the App key", () => {
    expect(resolveCredentialArm({ GH_TOKEN: "   " }, APP_ID)).toBe("app");
    expect(resolveCredentialArm({ GH_TOKEN: "   " })).toBe("pat");
  });

  test("pat arm when nothing can mint — a missing token is a real shortfall", () => {
    expect(resolveCredentialArm({})).toBe("pat");
    expect(resolveCredentialArm({}, {})).toBe("pat");
  });

  test("an empty or blank App id does not select the app arm", () => {
    expect(resolveCredentialArm({}, { GH_APP_ID: "" })).toBe("pat");
    expect(resolveCredentialArm({}, { GH_APP_ID: "   " })).toBe("pat");
  });

  test("solo: one env serves as both tenant and deployment env", () => {
    expect(resolveCredentialArm({ ...APP_ID })).toBe("app");
    expect(resolveCredentialArm({ ...APP_ID, GH_TOKEN: "ghp_abc" })).toBe("pat");
  });
});
