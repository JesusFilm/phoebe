// The icon for where something runs: the host's own mark, as T3 Code's project
// list draws one per project.
//
// Two of the marks are Simple Icons' (CC0): Tux for a Linux host, and for a
// deployment inside WSL too, because the kernel it runs on is Linux whichever
// window it is looked at from; the apple for a Mac. Simple Icons carries no
// Windows mark any more, so that one is drawn here: four panes, which is all
// the Windows 11 mark is.

import { Cloud, Monitor } from "lucide-react";
import { siApple, siLinux } from "simple-icons";
import type { HostPlatform } from "phoebe-agent/contracts";

/** The host as the companion's `process.platform` names it. */
export function hostOfProcessPlatform(platform: string): HostPlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

/** The word for a host, for a title or a screen reader. */
export function hostTitle(host: HostPlatform | null, distro?: string): string {
  switch (host) {
    case "windows":
      return "Windows";
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "wsl":
      return distro === undefined ? "Linux, under WSL" : `Linux, in the ${distro} WSL distro`;
    case null:
      return "Host not reported yet";
  }
}

const PATHS: Record<Exclude<HostPlatform, "windows">, string> = {
  linux: siLinux.path,
  wsl: siLinux.path,
  macos: siApple.path,
};

/**
 * One host's mark, `size` pixels square. An unknown host, which is a report
 * from a bootstrapper older than the field, falls back to a cloud when reached
 * through the relay and a monitor when it is this machine.
 */
export function HostIcon({
  host,
  size = 12,
  fallback = "relay",
}: {
  host: HostPlatform | null;
  size?: number;
  fallback?: "relay" | "local";
}) {
  if (host === null) {
    const Fallback = fallback === "relay" ? Cloud : Monitor;
    return <Fallback size={size} aria-hidden="true" />;
  }
  if (host === "windows") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        data-host="windows"
        aria-hidden="true"
      >
        <rect x="2" y="2" width="9.5" height="9.5" />
        <rect x="12.5" y="2" width="9.5" height="9.5" />
        <rect x="2" y="12.5" width="9.5" height="9.5" />
        <rect x="12.5" y="12.5" width="9.5" height="9.5" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      data-host={host}
      aria-hidden="true"
    >
      <path d={PATHS[host]} />
    </svg>
  );
}
