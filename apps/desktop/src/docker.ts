// The Docker check (#527 §15, #522 §2).
//
// This module only looks: for the binary, for the daemon, for Compose's
// version. What the companion does about a missing one lives in bootstrap.ts,
// and it is not a download of someone else's installer. It is the machine's
// own package manager, run on a click, with the command shown first. #522 §2
// drew the line at "checked, never installed"; the setup page moved it to
// "never without asking, never from anywhere but the platform's own source".
//
// Three separate answers rather than one boolean, because they need three
// different sentences: no binary is "install Docker", a binary with no daemon is
// "start Docker Desktop", and a binary with no Compose plugin is neither.

import type { CompanionEnvironment } from "phoebe-agent/contracts";
import {
  defaultCommandRunner,
  dockerOnPath,
  type CommandRunner,
} from "../../../src/deployment-compose.ts";

/** How long a Docker probe may hang before it is treated as no answer. */
export const DOCKER_PROBE_TIMEOUT_MS = 5_000;

export type DockerDeps = {
  runner?: CommandRunner;
  /** `process.env.PATH`, for the binary check. */
  pathEnv?: string | undefined;
  /** How the binary check tests a path — `accessSync` on a real machine. */
  access?: (file: string, mode: number) => void;
  /** A slow probe is a no; the timeout is injectable so a test need not wait. */
  timeoutMs?: number;
};

/**
 * Probe Docker. Never throws: every failure here is a fact about the machine,
 * and the install tab renders it as one.
 */
export async function probeDocker(deps: DockerDeps = {}): Promise<CompanionEnvironment["docker"]> {
  const present =
    deps.access === undefined
      ? dockerOnPath(deps.pathEnv ?? process.env["PATH"])
      : dockerOnPath(deps.pathEnv ?? process.env["PATH"], deps.access);
  if (!present) return { present: false, composeVersion: null, daemonRunning: false };

  const runner = deps.runner ?? defaultCommandRunner;
  const timeoutMs = deps.timeoutMs ?? DOCKER_PROBE_TIMEOUT_MS;

  // Both at once: neither answer depends on the other, and the daemon probe is
  // the slow one — it is the round trip to a socket that may not be there.
  const [compose, daemon] = await Promise.all([
    probe(runner, ["compose", "version", "--short"], timeoutMs),
    probe(runner, ["version", "--format", "{{.Server.Version}}"], timeoutMs),
  ]);

  return { present: true, composeVersion: firstLine(compose), daemonRunning: daemon !== null };
}

/** One `docker …` probe. Null on a non-zero exit, a spawn failure, or a hang. */
async function probe(
  runner: CommandRunner,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    // A probe must not be the reason the window stays open at quit time.
    timer.unref?.();
  });
  const result = await Promise.race([runner({ file: "docker", args }).catch(() => null), timeout]);
  if (result === null || result.code !== 0) return null;
  return result.stdout;
}

/** The version Docker printed, or null when it printed nothing worth showing. */
function firstLine(text: string | null): string | null {
  const line = text?.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 0 ? line : null;
}
