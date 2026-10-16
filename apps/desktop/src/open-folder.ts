// Open an install's folder, or a terminal in it, on this machine.
//
// The rail's right-click offers both (context-menu.ts). The folder is the OS's
// own file manager on the path, which Electron's `shell.openPath` does on every
// platform, a WSL install's `\\wsl.localhost\…` path included: Explorer serves
// that host like any other share. The terminal has no such one call, so each
// platform gets its own command, and a WSL install's is a shell inside the
// distro at the folder's Linux path, as every `docker` the companion spawns for
// one runs there (wsl.ts).
//
// Linux has no one terminal: `$TERMINAL` is the convention where an operator
// set one, `x-terminal-emulator` the Debian family's alternative, and the rest
// are the common ones, tried in turn until one spawns.

import { spawn } from "node:child_process";
import { BridgeRefusal } from "./channels.ts";
import { wslLocationOf } from "./wsl.ts";

/**
 * One way of opening a terminal: a command, and the folder it starts in. The
 * arguments are bare: Node quotes each for the OS, and nothing here goes
 * through a shell, so a folder with a space or a quote in its name arrives
 * whole.
 */
export type TerminalCommand = {
  file: string;
  args: readonly string[];
  /** The folder the terminal starts in, where the command does not say so itself. */
  cwd?: string;
};

/**
 * The ways of opening a terminal at `dir` on `platform`, first choice first.
 * Empty where no terminal is known to open.
 */
export function terminalCommands(
  dir: string,
  platform: string,
  env: Readonly<Record<string, string | undefined>> = {},
): TerminalCommand[] {
  switch (platform) {
    case "win32": {
      // `start` opens a new console window, which Windows 11 draws in the
      // operator's default terminal. The empty title is `start`'s own syntax:
      // it reads its first quoted argument as the title, and Node quotes an
      // empty string as `""`, so the path after it is not taken for one.
      // `cmd.exe` cannot sit in a UNC folder, so a WSL install gets a shell
      // in its distro instead, at the path the distro knows.
      const wsl = wslLocationOf(dir);
      if (wsl !== null) {
        return [
          {
            file: "cmd.exe",
            args: ["/c", "start", "", "wsl.exe", "-d", wsl.distro, "--cd", wsl.dir],
          },
        ];
      }
      return [{ file: "cmd.exe", args: ["/c", "start", "", "/d", dir, "cmd.exe"] }];
    }
    case "darwin":
      return [{ file: "open", args: ["-a", "Terminal", dir] }];
    case "linux": {
      const preferred = env.TERMINAL?.trim();
      const files = [
        ...(preferred === undefined || preferred === "" ? [] : [preferred]),
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "xterm",
      ];
      return files.map((file) => ({ file, args: [], cwd: dir }));
    }
    default:
      return [];
  }
}

/**
 * Spawn one command, detached, resolving once it has started. The default
 * leaves the terminal to outlive the companion; a test hands in its own.
 */
export type TerminalSpawner = (command: TerminalCommand) => Promise<void>;

export const defaultTerminalSpawner: TerminalSpawner = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args], {
      detached: true,
      stdio: "ignore",
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

/**
 * Open a terminal at `dir`, trying each command in turn until one spawns.
 * Refuses when none did, saying what was tried.
 */
export async function openTerminal(
  dir: string,
  deps: {
    platform?: string;
    env?: Readonly<Record<string, string | undefined>>;
    spawn?: TerminalSpawner;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const commands = terminalCommands(dir, platform, deps.env ?? process.env);
  if (commands.length === 0) {
    throw new BridgeRefusal({
      code: "refused",
      message: `No terminal is known to open on ${platform}.`,
    });
  }
  const run = deps.spawn ?? defaultTerminalSpawner;
  const failures: string[] = [];
  for (const command of commands) {
    try {
      await run(command);
      return;
    } catch (error) {
      failures.push(`${command.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new BridgeRefusal({
    code: "refused",
    message: `No terminal opened. Tried ${failures.join("; ")}.`,
    instruction: "Set $TERMINAL to the terminal to open, or install x-terminal-emulator.",
  });
}
