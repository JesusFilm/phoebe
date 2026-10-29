// Setting up this machine: the plan, and the one step at a time it runs.
//
// The plan is pure. Given the platform, what the Docker probe found and which
// commands are on the machine, `planBootstrap` says what the companion would
// run and what it cannot offer. That is the half worth testing on every
// platform from one, and nothing in it touches a process.
//
// The runner is the other half. One step at a time, through the machine's own
// shell, its lines kept the way a verb run's are (verb-runs.ts) so a window
// that reopens mid-install rejoins it. After a step ends the runner asks the
// Docker probe again, on a timer, until the daemon answers or two minutes
// pass, and hands every change to main to broadcast: Docker Desktop takes a
// while to bring its engine up, and the setup page should give way the moment
// it is, not the next time somebody opens the install tab.
//
// What runs is the platform's package manager or launcher and nothing the
// companion downloaded itself: winget and Docker Desktop on Windows, Homebrew
// and `open -a` on macOS, the distro's package manager under pkexec on Linux.
// Every command is shown in full before the click (contracts/bootstrap.ts).

import {
  MAX_BOOTSTRAP_LINES,
  type BootstrapBlocked,
  type BootstrapExit,
  type BootstrapLine,
  type BootstrapNeed,
  type BootstrapPlan,
  type BootstrapRun,
  type BootstrapStep,
  type BootstrapTool,
  type CompanionEnvironment,
} from "phoebe-agent/contracts";
import { BridgeRefusal } from "./channels.ts";

/** Where to send someone the companion cannot install Docker for. */
export const DOCKER_DOWNLOAD = "https://docs.docker.com/get-started/get-docker/";
export const DOCKER_ENGINE_INSTALL = "https://docs.docker.com/engine/install/";

/** How long the runner keeps asking Docker after a step, and how often. */
export const SETTLE_EVERY_MS = 3_000;
export const SETTLE_FOR_MS = 120_000;

/** What the plan is made from. */
export type Machine = {
  /** `process.platform`. */
  platform: string;
  docker: CompanionEnvironment["docker"];
  /** Is a command on PATH, or a file at an absolute path? */
  has: (commandOrPath: string) => boolean;
  /** `process.env`, for the places Windows keeps Program Files. */
  env: Record<string, string | undefined>;
};

/** Where Docker Desktop installs itself on Windows, from the environment. */
export function dockerDesktopExe(env: Record<string, string | undefined>): string {
  const programFiles = env["ProgramFiles"] ?? env["PROGRAMFILES"] ?? "C:\\Program Files";
  return `${programFiles}\\Docker\\Docker\\Docker Desktop.exe`;
}

/** Homebrew, wherever this Mac keeps it, or null. */
function brewOn(machine: Machine): string | null {
  for (const candidate of ["brew", "/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (machine.has(candidate)) return candidate;
  }
  return null;
}

/** The distro's package manager, by which one is on the machine. */
function linuxInstall(machine: Machine): string | null {
  const group = `usermod -aG docker "$(id -un "$PKEXEC_UID")"`;
  const enable = "systemctl enable --now docker";
  if (machine.has("apt-get")) {
    return `apt-get update && apt-get install -y docker.io docker-compose-v2 && ${enable} && ${group}`;
  }
  if (machine.has("dnf")) {
    return `dnf install -y moby-engine docker-compose && ${enable} && ${group}`;
  }
  if (machine.has("pacman")) {
    return `pacman -S --noconfirm docker docker-compose && ${enable} && ${group}`;
  }
  return null;
}

/** What this machine needs for Docker, and what the companion can do about it. */
export function planBootstrap(machine: Machine): BootstrapPlan {
  const steps: BootstrapStep[] = [];
  const blocked: BootstrapBlocked[] = [];
  const offer = (need: BootstrapNeed, command: string, elevates: boolean, note: string | null) =>
    steps.push({ tool: "docker", need, command, elevates, note });
  const refuse = (need: BootstrapNeed, reason: string, link: string) =>
    blocked.push({ tool: "docker", need, reason, link });

  if (machine.docker.present && machine.docker.daemonRunning) return { steps, blocked };
  const need: BootstrapNeed = machine.docker.present ? "start" : "install";

  switch (machine.platform) {
    case "win32": {
      if (need === "install") {
        if (machine.has("winget")) {
          offer(
            "install",
            "winget install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements",
            true,
            "Windows asks for permission. After the install, sign out and back in, then start Docker from here.",
          );
        } else {
          refuse("install", "winget is not on this machine", DOCKER_DOWNLOAD);
        }
      } else {
        const exe = dockerDesktopExe(machine.env);
        if (machine.has(exe)) {
          offer("start", `start "" "${exe}"`, false, null);
        } else {
          refuse("start", `Docker Desktop was not found at ${exe}`, DOCKER_DOWNLOAD);
        }
      }
      break;
    }
    case "darwin": {
      if (need === "install") {
        const brew = brewOn(machine);
        if (brew !== null) {
          offer(
            "install",
            `${brew} install --cask docker-desktop`,
            true,
            "macOS asks for your password for Docker's helper. Then start Docker from here.",
          );
        } else {
          refuse("install", "Homebrew is not on this machine", DOCKER_DOWNLOAD);
        }
      } else if (machine.has("/Applications/Docker.app")) {
        offer("start", "open -a Docker", false, null);
      } else {
        refuse("start", "Docker Desktop was not found in /Applications", DOCKER_DOWNLOAD);
      }
      break;
    }
    case "linux": {
      if (!machine.has("pkexec")) {
        refuse(
          need,
          "pkexec is not on this machine, so the companion cannot ask for root",
          DOCKER_ENGINE_INSTALL,
        );
        break;
      }
      if (need === "install") {
        const install = linuxInstall(machine);
        if (install !== null) {
          offer(
            "install",
            `pkexec sh -c '${install}'`,
            true,
            "Your desktop asks for your password. The install adds you to the docker group; sign out and back in before the companion can reach the daemon.",
          );
        } else {
          refuse(
            "install",
            "none of apt-get, dnf or pacman is on this machine",
            DOCKER_ENGINE_INSTALL,
          );
        }
      } else if (machine.has("systemctl")) {
        offer("start", "pkexec systemctl start docker", true, null);
      } else {
        refuse("start", "systemctl is not on this machine", DOCKER_ENGINE_INSTALL);
      }
      break;
    }
    default:
      refuse(need, `the companion knows no installer for ${machine.platform}`, DOCKER_DOWNLOAD);
  }
  return { steps, blocked };
}

/** The shape of a spawned shell the runner reads. `child_process` fits it. */
export type BootstrapChild = {
  stdout: { on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown };
  stderr: { on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown };
  on: {
    (event: "close", listener: (code: number | null) => void): unknown;
    (event: "error", listener: (reason: Error) => void): unknown;
  };
};

/** Run one shell line on this machine. Main's is `cmd.exe /c` or `sh -c`. */
export type BootstrapSpawner = (command: string) => BootstrapChild;

export type BootstrapDeps = {
  /** This machine, read fresh for every plan. */
  machine: () => Promise<Machine>;
  spawn: BootstrapSpawner;
  /** The Docker probe, asked again after a step until it answers. */
  probe: () => Promise<CompanionEnvironment["docker"]>;
  onLine: (line: BootstrapLine) => void;
  onExit: (exit: BootstrapExit) => void;
  /** Every change the probe reports after a step. Main broadcasts it. */
  onDocker: (docker: CompanionEnvironment["docker"]) => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export type Bootstrap = {
  plan: () => Promise<BootstrapPlan>;
  /** Start a step from the current plan. Refused when one is running or the plan no longer offers it. */
  run: (step: { tool: BootstrapTool; need: BootstrapNeed }) => Promise<BootstrapRun>;
  /** The step running now or the last one, or null when none has run. */
  current: () => BootstrapRun | null;
};

export function createBootstrap(deps: BootstrapDeps): Bootstrap {
  const now = deps.now ?? (() => new Date());
  const wait = deps.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let current: BootstrapRun | null = null;

  function append(
    run: BootstrapRun,
    stream: BootstrapLine["stream"],
    chunk: Buffer | string,
  ): void {
    for (const piece of chunk.toString().replace(/\r\n?/g, "\n").split("\n")) {
      if (piece.length === 0) continue;
      const line: BootstrapLine = { stream, line: piece };
      run.lines.push(line);
      if (run.lines.length > MAX_BOOTSTRAP_LINES) run.lines.shift();
      deps.onLine(line);
    }
  }

  /**
   * After a step: ask Docker again until it answers, or until the patience runs
   * out. What a `start` waits for is the daemon; what an `install` waits for is
   * the binary, since on every platform the daemon needs a start, or a sign-out,
   * after the install.
   */
  async function settle(need: BootstrapNeed): Promise<"answered" | "timed-out"> {
    let last: string | null = null;
    for (let waited = 0; waited <= SETTLE_FOR_MS; waited += SETTLE_EVERY_MS) {
      const docker = await deps.probe().catch(() => null);
      if (docker !== null) {
        const key = JSON.stringify(docker);
        if (key !== last) {
          last = key;
          deps.onDocker(docker);
        }
        if (need === "start" ? docker.daemonRunning : docker.present) return "answered";
      }
      await wait(SETTLE_EVERY_MS);
    }
    return "timed-out";
  }

  /**
   * The exit goes out twice: once when the command ends, and again with
   * `settled` when the wait after it does, so a window can stop saying
   * "starting" when Docker never answers, not only when it does.
   */
  function finish(run: BootstrapRun, code: number | null): void {
    if (run.exit !== undefined) return;
    run.exit = { tool: run.tool, need: run.need, code };
    deps.onExit(run.exit);
    void settle(run.need).then((settled) => {
      run.exit = { ...run.exit!, settled };
      deps.onExit(run.exit);
    });
  }

  return {
    plan: async () => planBootstrap(await deps.machine()),

    current: () => current,

    run: async (asked) => {
      if (current !== null && current.exit === undefined) {
        throw new BridgeRefusal({
          code: "busy",
          message: `${current.need} ${current.tool} is still running`,
          instruction: "Wait for it to finish.",
        });
      }
      const plan = planBootstrap(await deps.machine());
      const step = plan.steps.find(
        (candidate) => candidate.tool === asked.tool && candidate.need === asked.need,
      );
      if (step === undefined) {
        const why = plan.blocked.find(
          (candidate) => candidate.tool === asked.tool && candidate.need === asked.need,
        );
        throw new BridgeRefusal({
          code: "refused",
          message:
            why === undefined
              ? `there is nothing to ${asked.need} for ${asked.tool} on this machine`
              : why.reason,
          ...(why === undefined ? {} : { instruction: `See ${why.link}.` }),
        });
      }

      const run: BootstrapRun = {
        tool: step.tool,
        need: step.need,
        command: step.command,
        startedAt: now().toISOString(),
        lines: [],
      };
      current = run;
      let child: BootstrapChild;
      try {
        child = deps.spawn(step.command);
      } catch (error) {
        append(run, "stderr", error instanceof Error ? error.message : String(error));
        finish(run, null);
        return run;
      }
      child.stdout.on("data", (chunk) => append(run, "stdout", chunk));
      child.stderr.on("data", (chunk) => append(run, "stderr", chunk));
      child.on("error", (reason) => {
        append(run, "stderr", reason.message);
        finish(run, null);
      });
      child.on("close", (code) => finish(run, code));
      return run;
    },
  };
}

/**
 * Is a command on PATH, or a file at an absolute path? `access` is the probe
 * (`accessSync` on a real machine), injected so the planner's tests need no
 * filesystem.
 */
export function makeHas(
  platform: string,
  pathEnv: string | undefined,
  access: (file: string) => void,
): (commandOrPath: string) => boolean {
  const windows = platform === "win32";
  const exists = (file: string): boolean => {
    try {
      access(file);
      return true;
    } catch {
      return false;
    }
  };
  return (commandOrPath) => {
    const absolute = windows
      ? /^[a-zA-Z]:[\\/]/.test(commandOrPath)
      : commandOrPath.startsWith("/");
    if (absolute) return exists(commandOrPath);
    const separator = windows ? ";" : ":";
    const joiner = windows ? "\\" : "/";
    const suffixes = windows ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const dir of (pathEnv ?? "").split(separator)) {
      if (dir.length === 0) continue;
      for (const suffix of suffixes) {
        if (exists(`${dir}${joiner}${commandOrPath}${suffix}`)) return true;
      }
    }
    return false;
  };
}
