import { describe, expect, test } from "vite-plus/test";
import { hostPlatformOf, readHostPlatform } from "./host-platform.ts";

describe("where a deployment runs, read off the kernel", () => {
  test("a WSL2 kernel is wsl, whichever daemon owns it", () => {
    expect(
      hostPlatformOf({ platform: "linux", kernel: "5.15.153.1-microsoft-standard-WSL2" }),
    ).toBe("wsl");
    expect(
      hostPlatformOf({
        platform: "linux",
        kernel: "Linux version 6.6.87.2-microsoft-standard-WSL2 (root@...) #1 SMP",
      }),
    ).toBe("wsl");
  });

  test("a LinuxKit kernel is Docker Desktop on a Mac", () => {
    expect(hostPlatformOf({ platform: "linux", kernel: "6.10.14-linuxkit" })).toBe("macos");
  });

  test("any other Linux kernel is a Linux host", () => {
    expect(hostPlatformOf({ platform: "linux", kernel: "6.12.1-arch1-1" })).toBe("linux");
    expect(hostPlatformOf({ platform: "linux", kernel: "" })).toBe("linux");
  });

  test("a bootstrapper on the host itself says which host", () => {
    expect(hostPlatformOf({ platform: "darwin", kernel: "24.0.0" })).toBe("macos");
    expect(hostPlatformOf({ platform: "win32", kernel: "10.0.26100" })).toBe("windows");
  });

  test("the live read answers one of the four", () => {
    expect(["windows", "macos", "linux", "wsl"]).toContain(readHostPlatform());
  });
});
