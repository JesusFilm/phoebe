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
// On Windows a new console window is `start`'s to open, and `start` is a
// `cmd.exe` builtin: whatever is on its line, `cmd.exe` parses first, and a
// folder called `foo&calc` would run `calc`. So the folder never goes on that
// line. A folder on this machine is the working directory the window inherits;
// a folder inside a distro has to be named to `wsl.exe --cd`, so it goes in
// quotes, which `cmd.exe` honours, and a path holding a character that quotes
// do not cover is refused rather than passed.
//
// Linux has no one terminal: `$TERMINAL` is the convention where an operator
// set one, `x-terminal-emulator` the Debian family's alternative, and the rest
// are the common ones, tried in turn until one stays up.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { BridgeRefusal } from "./channels.ts";
import { wslLocationOf } from "./wsl.ts";

/**
 * One way of opening a terminal: a command, and the folder it starts in.
 *
 * The arguments are bare and Node quotes each for the OS, except on the one
 * line marked `verbatim`, which is handed to `cmd.exe` as written because its
 * quoting is `cmd.exe`'s to read, not Node's (see {@link terminalCommands}).
 */
export type TerminalCommand = {
  file: string;
  args: readonly string[];
  /** The folder the terminal starts in, where the command does not say so itself. */
  cwd?: string;
  /** Pass the arguments as written, quoted here for `cmd.exe`. Windows only. */
  verbatim?: true;
};

/** What a WSL distro may be called: letters, digits, dot, dash, underscore. */
const DISTRO_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * What a quoted Linux path cannot carry onto a `cmd.exe` line: the quote that
 * would end it, the percent sign `cmd.exe` expands even inside quotes, and a
 * control character.
 */
const UNQUOTABLE = /["%\p{Cc}]/u;

/**
 * The ways of opening a terminal at `dir` on `platform`, first choice first.
 * Empty where no terminal is known to open. Refuses a WSL folder whose name
 * cannot be put on a `cmd.exe` line safely.
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
      // empty string as `""`, so what follows is not taken for one.
      const wsl = wslLocationOf(dir);
      if (wsl === null) {
        // The window inherits the working directory, so the folder is never
        // on the line `cmd.exe` parses.
        return [{ file: "cmd.exe", args: ["/c", "start", "", "cmd.exe"], cwd: dir }];
      }
      // `cmd.exe` cannot sit in a UNC folder, so the shell opens inside the
      // distro at the path the distro knows. `wsl.exe` reads quotes on `-d`
      // as part of the name, so the distro goes bare and is checked instead;
      // the path goes quoted, as `--cd` accepts.
      if (!DISTRO_NAME.test(wsl.distro)) {
        throw new BridgeRefusal({
          code: "refused",
          message: `${wsl.distro} is not a name a WSL distro can have, so no shell was opened.`,
        });
      }
      if (UNQUOTABLE.test(wsl.dir)) {
        throw new BridgeRefusal({
          code: "refused",
          message: `${wsl.dir} holds a quote, a percent sign or a control character, which cannot be passed to wsl.exe safely, so no shell was opened.`,
          instruction: "Open a terminal yourself and cd into the folder.",
        });
      }
      return [
        {
          file: "cmd.exe",
          args: ["/c", "start", '""', "wsl.exe", "-d", wsl.distro, "--cd", `"${wsl.dir}"`],
          verbatim: true,
        },
      ];
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

/** Spawn one command, resolving once it is known to have opened a terminal. */
export type TerminalSpawner = (command: TerminalCommand) => Promise<void>;

/** As much of a child process as {@link terminalSpawner} reads, so a test can hand in its own. */
export type SpawnedLike = {
  once: (event: "error" | "exit", listener: (...args: never[]) => void) => unknown;
  stderr: {
    on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
    destroy: () => void;
  } | null;
  unref: () => void;
};

/** The spawn call {@link terminalSpawner} makes, with the options it needs. */
export type SpawnLike = (
  file: string,
  args: readonly string[],
  options: {
    detached: true;
    stdio: ["ignore", "ignore", "pipe"];
    cwd?: string;
    windowsVerbatimArguments?: true;
  },
) => SpawnedLike;

/**
 * A spawner that tells a launcher that failed from a terminal that opened.
 *
 * The `spawn` event alone says only that the launcher started, and `start` on
 * Windows and `open` on macOS start and hand off in a moment. So the answer is
 * read off what the child does next: exits with zero within the grace and it
 * handed off; exits with anything else and it failed, with what it said on
 * stderr as the reason; still up when the grace ends and it is the terminal
 * itself. The child is detached either way, so a terminal outlives the
 * companion.
 */
export function terminalSpawner(
  deps: { spawn?: SpawnLike; graceMs?: number } = {},
): TerminalSpawner {
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const graceMs = deps.graceMs ?? 1500;
  return (command) =>
    new Promise((resolve, reject) => {
      const child = spawn(command.file, [...command.args], {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        ...(command.verbatim === undefined ? {} : { windowsVerbatimArguments: true }),
      });
      let said = "";
      child.stderr?.on("data", (chunk) => {
        said += String(chunk);
      });
      let settled = false;
      const settle = (outcome: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stderr?.destroy();
        child.unref();
        if (outcome === null) resolve();
        else reject(outcome);
      };
      const timer = setTimeout(() => settle(null), graceMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      child.once("error", (error: Error) => settle(error));
      child.once("exit", (code: number | null, signal: string | null) => {
        if (code === 0) settle(null);
        else {
          const why = said.trim() === "" ? `exited with ${code ?? signal}` : said.trim();
          settle(new Error(why));
        }
      });
    });
}

/**
 * Open a terminal at `dir`, trying each command in turn until one opens.
 * Refuses when the folder is not there, when none is known for this
 * platform, and when every one failed, saying what was tried.
 */
export async function openTerminal(
  dir: string,
  deps: {
    platform?: string;
    env?: Readonly<Record<string, string | undefined>>;
    spawn?: TerminalSpawner;
    exists?: (path: string) => boolean;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  // A folder that is gone, or a distro that is not running, fails here with
  // its name rather than in a window that closes before it can be read.
  if (!exists(dir)) {
    throw new BridgeRefusal({
      code: "refused",
      message: `${dir} is not a folder this machine can see right now, so no terminal was opened.`,
    });
  }
  const commands = terminalCommands(dir, platform, deps.env ?? process.env);
  if (commands.length === 0) {
    throw new BridgeRefusal({
      code: "refused",
      message: `No terminal is known to open on ${platform}.`,
    });
  }
  const run = deps.spawn ?? terminalSpawner();
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
