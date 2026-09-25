// Where this deployment runs, as far as a process can tell from inside it.
//
// The bootstrapper almost always runs in a Linux container, so `process.platform`
// says `linux` on a Windows laptop and a Mac alike. The kernel string is what
// gives the host away: Docker Desktop on Windows and a distro's own daemon both
// run on a WSL2 kernel, Docker Desktop on a Mac runs on a LinuxKit one, and a
// kernel that is neither is a Linux host. The answer is a hint for a console's
// rail, never a fact anything gates on.

import { readFileSync } from "node:fs";
import { release } from "node:os";
import type { HostPlatform } from "../src/contracts/deployment.ts";

/** What the reading looks at, injectable for tests. */
export type HostProbe = {
  /** `process.platform` */
  platform: string;
  /** `os.release()` and `/proc/version`, joined: the kernel's own words about itself. */
  kernel: string;
};

/** Read the host off one probe. Pure. */
export function hostPlatformOf(probe: HostProbe): HostPlatform {
  if (probe.platform === "darwin") return "macos";
  if (probe.platform === "win32") return "windows";
  const kernel = probe.kernel.toLowerCase();
  if (kernel.includes("microsoft")) return "wsl";
  if (kernel.includes("linuxkit")) return "macos";
  return "linux";
}

/** Read the host off this process. Never throws: a missing `/proc/version` is a plain Linux. */
export function readHostPlatform(): HostPlatform {
  let version = "";
  try {
    version = readFileSync("/proc/version", "utf8");
  } catch {
    version = "";
  }
  return hostPlatformOf({ platform: process.platform, kernel: `${release()} ${version}` });
}
