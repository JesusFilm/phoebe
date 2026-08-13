import { describe, expect, test } from "vite-plus/test";
import { detectAppCredentials, GH_APP_ENV_PREFIX } from "./gh-app.ts";

describe("GH_APP_ENV_PREFIX", () => {
  test("is the shared prefix used by all App env vars", () => {
    expect(GH_APP_ENV_PREFIX).toBe("PHOEBE_GH_APP_");
    expect(`${GH_APP_ENV_PREFIX}ID`).toBe("PHOEBE_GH_APP_ID");
    expect(`${GH_APP_ENV_PREFIX}PRIVATE_KEY`).toBe("PHOEBE_GH_APP_PRIVATE_KEY");
  });
});

describe("detectAppCredentials", () => {
  test("returns credentials when both vars are present", () => {
    const creds = detectAppCredentials({
      PHOEBE_GH_APP_ID: "123456",
      PHOEBE_GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\n...",
    });
    expect(creds).toEqual({
      appId: "123456",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\n...",
    });
  });

  test("returns null when PHOEBE_GH_APP_ID is absent", () => {
    expect(detectAppCredentials({ PHOEBE_GH_APP_PRIVATE_KEY: "some-key" })).toBeNull();
  });

  test("returns null when PHOEBE_GH_APP_PRIVATE_KEY is absent", () => {
    expect(detectAppCredentials({ PHOEBE_GH_APP_ID: "123" })).toBeNull();
  });

  test("returns null when both vars are absent", () => {
    expect(detectAppCredentials({})).toBeNull();
    expect(detectAppCredentials({ GH_TOKEN: "ghs_xyz" })).toBeNull();
  });

  test("returns null when a var is present but empty", () => {
    expect(
      detectAppCredentials({ PHOEBE_GH_APP_ID: "", PHOEBE_GH_APP_PRIVATE_KEY: "key" }),
    ).toBeNull();
    expect(
      detectAppCredentials({ PHOEBE_GH_APP_ID: "123", PHOEBE_GH_APP_PRIVATE_KEY: "" }),
    ).toBeNull();
  });
});
