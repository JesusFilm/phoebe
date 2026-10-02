// Work-unit execution is gated to the Phoebe container. Selection logic and
// --dry-run stay host-runnable for fast iteration; anything that mutates a
// clone, launches an agent CLI, or pushes runs only where the container
// marker exists (created by the Dockerfile).

import { existsSync, readFileSync } from "node:fs";

export const CONTAINER_MARKER_PATH = "/.phoebe-container";

export function isInsideContainer(exists: (path: string) => boolean = existsSync): boolean {
  return exists(CONTAINER_MARKER_PATH);
}

/**
 * PID 1's command line, spaces for the NUL separators, or the empty string when
 * it cannot be read. The container's main process is `phoebe boot`, so this is
 * the one question a process inside the container can ask about the
 * bootstrapper without a pidfile: doctor's `supervisor` check quotes it,
 * `phoebe status` turns it into the header that says the report is not moving.
 */
export function pidOneCmdline(read: (path: string) => string = readProcFile): string {
  try {
    return read("/proc/1/cmdline").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function readProcFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** Is `phoebe boot` the process holding this container open? */
export function bootIsMainProcess(cmdline: string = pidOneCmdline()): boolean {
  return cmdline.includes("boot");
}

export type ExecutionDecision = "execute" | "dry-run" | "refuse";

/** Pure decision: may this process execute the selected work unit? */
export function executionDecision(opts: {
  dryRun: boolean;
  inContainer: boolean;
}): ExecutionDecision {
  if (opts.dryRun) return "dry-run";
  return opts.inContainer ? "execute" : "refuse";
}

/** Untagged: the engine prints it through its own tagged channel (#418). */
export const EXECUTION_REFUSED_MESSAGE =
  "Refusing to execute a work unit outside the Phoebe container. " +
  "Use --dry-run to preview selection on the host, or start the container loop.";
