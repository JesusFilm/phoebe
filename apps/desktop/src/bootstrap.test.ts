// Setting up this machine: the plan per platform, and the runner's rules.

import type { BootstrapExit, BootstrapLine, CompanionEnvironment } from "phoebe-agent/contracts";
import { describe, expect, test } from "vite-plus/test";
import {
  createBootstrap,
  DOCKER_DOWNLOAD,
  DOCKER_ENGINE_INSTALL,
  dockerDesktopExe,
  makeHas,
  planBootstrap,
  SETTLE_EVERY_MS,
  type BootstrapChild,
  type Machine,
} from "./bootstrap.ts";

const MISSING: CompanionEnvironment["docker"] = {
  present: false,
  composeVersion: null,
  daemonRunning: false,
};
const DOWN: CompanionEnvironment["docker"] = {
  present: true,
  composeVersion: "v2.29.7",
  daemonRunning: false,
};
const RUNNING: CompanionEnvironment["docker"] = {
  present: true,
  composeVersion: "v2.29.7",
  daemonRunning: true,
};

/** A machine with the named commands and files, and nothing else. */
function machine(
  platform: string,
  docker: CompanionEnvironment["docker"],
  has: readonly string[] = [],
): Machine {
  return {
    platform,
    docker,
    has: (candidate) => has.includes(candidate),
    env: { ProgramFiles: "C:\\Program Files" },
  };
}

describe("the plan", () => {
  test("a running Docker needs nothing", () => {
    expect(planBootstrap(machine("linux", RUNNING, ["pkexec"]))).toEqual({
      steps: [],
      blocked: [],
    });
  });

  test("Windows installs Docker Desktop through winget, with the OS asking", () => {
    const plan = planBootstrap(machine("win32", MISSING, ["winget"]));

    expect(plan.blocked).toEqual([]);
    expect(plan.steps).toMatchObject([{ tool: "docker", need: "install", elevates: true }]);
    expect(plan.steps[0]!.command).toBe(
      "winget install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements",
    );
    expect(plan.steps[0]!.note).toContain("sign out and back in");
  });

  test("Windows without winget is sent to Docker's download page", () => {
    const plan = planBootstrap(machine("win32", MISSING));

    expect(plan.steps).toEqual([]);
    expect(plan.blocked).toEqual([
      {
        tool: "docker",
        need: "install",
        reason: "winget is not on this machine",
        link: DOCKER_DOWNLOAD,
      },
    ]);
  });

  test("Windows starts the Docker Desktop it finds under Program Files", () => {
    const exe = dockerDesktopExe({ ProgramFiles: "C:\\Program Files" });
    expect(exe).toBe("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe");

    const plan = planBootstrap(machine("win32", DOWN, [exe]));
    expect(plan.steps).toMatchObject([
      { need: "start", command: `start "" "${exe}"`, elevates: false },
    ]);

    const elsewhere = planBootstrap(machine("win32", DOWN));
    expect(elsewhere.steps).toEqual([]);
    expect(elsewhere.blocked[0]!.reason).toContain("was not found at");
  });

  test("macOS installs through Homebrew wherever it is, and starts with open -a", () => {
    expect(planBootstrap(machine("darwin", MISSING, ["brew"])).steps[0]!.command).toBe(
      "brew install --cask docker-desktop",
    );
    expect(
      planBootstrap(machine("darwin", MISSING, ["/opt/homebrew/bin/brew"])).steps[0]!.command,
    ).toBe("/opt/homebrew/bin/brew install --cask docker-desktop");
    expect(planBootstrap(machine("darwin", MISSING)).blocked[0]).toMatchObject({
      reason: "Homebrew is not on this machine",
      link: DOCKER_DOWNLOAD,
    });

    expect(
      planBootstrap(machine("darwin", DOWN, ["/Applications/Docker.app"])).steps[0],
    ).toMatchObject({
      need: "start",
      command: "open -a Docker",
      elevates: false,
    });
    expect(planBootstrap(machine("darwin", DOWN)).blocked[0]!.reason).toContain("/Applications");
  });

  test("Linux goes through pkexec and the distro's package manager", () => {
    const apt = planBootstrap(machine("linux", MISSING, ["pkexec", "apt-get"]));
    expect(apt.steps[0]!.command).toBe(
      `pkexec sh -c 'apt-get update && apt-get install -y docker.io docker-compose-v2 && systemctl enable --now docker && usermod -aG docker "$(id -un "$PKEXEC_UID")"'`,
    );
    expect(apt.steps[0]!.elevates).toBe(true);
    expect(apt.steps[0]!.note).toContain("docker group");

    expect(planBootstrap(machine("linux", MISSING, ["pkexec", "dnf"])).steps[0]!.command).toContain(
      "dnf install -y moby-engine docker-compose",
    );
    expect(
      planBootstrap(machine("linux", MISSING, ["pkexec", "pacman"])).steps[0]!.command,
    ).toContain("pacman -S --noconfirm docker docker-compose");
    expect(planBootstrap(machine("linux", MISSING, ["pkexec"])).blocked[0]).toMatchObject({
      reason: "none of apt-get, dnf or pacman is on this machine",
      link: DOCKER_ENGINE_INSTALL,
    });
  });

  test("Linux without pkexec cannot ask for root, whichever step it is", () => {
    expect(planBootstrap(machine("linux", MISSING, ["apt-get"])).blocked[0]).toMatchObject({
      need: "install",
      reason: "pkexec is not on this machine, so the companion cannot ask for root",
    });
    expect(planBootstrap(machine("linux", DOWN, ["systemctl"])).blocked[0]!.need).toBe("start");
  });

  test("Linux starts the daemon with systemctl under pkexec", () => {
    expect(planBootstrap(machine("linux", DOWN, ["pkexec", "systemctl"])).steps[0]).toMatchObject({
      need: "start",
      command: "pkexec systemctl start docker",
      elevates: true,
    });
  });

  test("an unknown platform is blocked rather than guessed at", () => {
    expect(planBootstrap(machine("freebsd", MISSING)).blocked[0]!.reason).toContain("freebsd");
  });
});

describe("what is on the machine", () => {
  test("a command is looked for along PATH, with Windows's suffixes", () => {
    const files = new Set([
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
      "/usr/bin/pkexec",
      "/Applications/Docker.app",
    ]);
    const access = (file: string) => {
      if (!files.has(file)) throw new Error("ENOENT");
    };

    const windows = makeHas(
      "win32",
      "C:\\Windows;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps",
      access,
    );
    expect(windows("winget")).toBe(true);
    expect(windows("brew")).toBe(false);
    expect(windows("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe")).toBe(false);

    const unix = makeHas("linux", "/usr/local/bin:/usr/bin", access);
    expect(unix("pkexec")).toBe(true);
    expect(unix("apt-get")).toBe(false);
    expect(unix("/Applications/Docker.app")).toBe(true);
  });
});

/** A shell a test can feed output to and close. */
function fakeShell() {
  const commands: string[] = [];
  let out: ((chunk: Buffer | string) => void) | undefined;
  let err: ((chunk: Buffer | string) => void) | undefined;
  let close: ((code: number | null) => void) | undefined;
  const spawn = (command: string): BootstrapChild => {
    commands.push(command);
    return {
      stdout: { on: (_event, listener) => (out = listener) },
      stderr: { on: (_event, listener) => (err = listener) },
      on: ((event: string, listener: unknown) => {
        if (event === "close") close = listener as (code: number | null) => void;
      }) as BootstrapChild["on"],
    };
  };
  return {
    spawn,
    commands,
    print: (text: string) => out?.(text),
    complain: (text: string) => err?.(text),
    end: (code: number | null) => close?.(code),
  };
}

function runner(facts: Machine, probes: CompanionEnvironment["docker"][] = [RUNNING]) {
  const shell = fakeShell();
  const lines: BootstrapLine[] = [];
  const exits: BootstrapExit[] = [];
  const seen: CompanionEnvironment["docker"][] = [];
  const waits: number[] = [];
  let probed = 0;
  const bootstrap = createBootstrap({
    machine: () => Promise.resolve(facts),
    spawn: shell.spawn,
    probe: () => Promise.resolve(probes[Math.min(probed++, probes.length - 1)]!),
    onLine: (line) => lines.push(line),
    onExit: (exit) => exits.push(exit),
    onDocker: (docker) => seen.push(docker),
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    now: () => new Date("2026-10-22T12:00:00Z"),
  });
  return { bootstrap, shell, lines, exits, seen, waits };
}

/** Let the settle loop run through its awaits. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("running a step", () => {
  test("runs the planned command and streams its lines, one per event", async () => {
    const { bootstrap, shell, lines, exits } = runner(
      machine("darwin", DOWN, ["/Applications/Docker.app"]),
    );

    const run = await bootstrap.run({ tool: "docker", need: "start" });
    expect(shell.commands).toEqual(["open -a Docker"]);
    expect(run).toMatchObject({
      tool: "docker",
      need: "start",
      command: "open -a Docker",
      lines: [],
    });
    expect(run.startedAt).toBe("2026-10-22T12:00:00.000Z");

    shell.print("one\r\ntwo\n");
    shell.complain("careful");
    shell.end(0);

    expect(lines).toEqual([
      { stream: "stdout", line: "one" },
      { stream: "stdout", line: "two" },
      { stream: "stderr", line: "careful" },
    ]);
    expect(exits).toEqual([{ tool: "docker", need: "start", code: 0 }]);
    expect(bootstrap.current()).toMatchObject({ exit: { code: 0 }, lines });
  });

  test("a step the plan does not offer is refused with the plan's reason", async () => {
    const { bootstrap, shell } = runner(machine("win32", MISSING));

    await expect(bootstrap.run({ tool: "docker", need: "install" })).rejects.toMatchObject({
      error: {
        code: "refused",
        message: "winget is not on this machine",
        instruction: `See ${DOCKER_DOWNLOAD}.`,
      },
    });
    await expect(bootstrap.run({ tool: "docker", need: "start" })).rejects.toMatchObject({
      error: { code: "refused", message: "there is nothing to start for docker on this machine" },
    });
    expect(shell.commands).toEqual([]);
  });

  test("one step at a time", async () => {
    const { bootstrap, shell } = runner(machine("linux", DOWN, ["pkexec", "systemctl"]));
    await bootstrap.run({ tool: "docker", need: "start" });

    await expect(bootstrap.run({ tool: "docker", need: "start" })).rejects.toMatchObject({
      error: { code: "busy" },
    });
    shell.end(0);
    await tick();
    await expect(bootstrap.run({ tool: "docker", need: "start" })).resolves.toMatchObject({
      need: "start",
    });
  });

  test("after a start, asks Docker again until the daemon answers, and reports each change", async () => {
    const { bootstrap, shell, seen, waits } = runner(
      machine("linux", DOWN, ["pkexec", "systemctl"]),
      [DOWN, DOWN, RUNNING],
    );
    await bootstrap.run({ tool: "docker", need: "start" });
    shell.end(0);
    for (let i = 0; i < 8; i++) await tick();

    expect(seen).toEqual([DOWN, RUNNING]);
    expect(waits).toEqual([SETTLE_EVERY_MS, SETTLE_EVERY_MS]);
  });

  test("after an install, the binary being there is enough, since the daemon needs a start of its own", async () => {
    const { bootstrap, shell, seen } = runner(machine("win32", MISSING, ["winget"]), [
      MISSING,
      DOWN,
    ]);
    await bootstrap.run({ tool: "docker", need: "install" });
    shell.end(0);
    for (let i = 0; i < 6; i++) await tick();

    expect(seen).toEqual([MISSING, DOWN]);
  });

  test("a shell that fails to spawn is a run that ended with its message", async () => {
    const lines: BootstrapLine[] = [];
    const exits: BootstrapExit[] = [];
    const bootstrap = createBootstrap({
      machine: () => Promise.resolve(machine("darwin", DOWN, ["/Applications/Docker.app"])),
      spawn: () => {
        throw new Error("spawn open ENOENT");
      },
      probe: () => Promise.resolve(DOWN),
      onLine: (line) => lines.push(line),
      onExit: (exit) => exits.push(exit),
      onDocker: () => undefined,
      wait: () => Promise.resolve(),
    });

    const run = await bootstrap.run({ tool: "docker", need: "start" });
    expect(run.exit).toEqual({ tool: "docker", need: "start", code: null });
    expect(lines).toEqual([{ stream: "stderr", line: "spawn open ENOENT" }]);
    expect(exits).toHaveLength(1);
  });
});
