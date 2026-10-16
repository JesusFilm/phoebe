import { describe, expect, test } from "vite-plus/test";
import { openTerminal, terminalCommands, type TerminalCommand } from "./open-folder.ts";

const B = "\\";
const WSL_DIR = `${B}${B}wsl.localhost${B}archlinux${B}home${B}mike${B}my app`;

describe("the terminal a folder opens in", () => {
  // The arguments are bare and go through no shell: `start` reads its first
  // quoted argument as the window's title, and Node quotes an empty string
  // as `""`, which is the empty title that keeps the path from being read
  // as one. A hand-quoted title through `shell: true` was read as a program
  // to run, and the folder never opened.
  test("Windows starts a console window in the folder, through no shell", () => {
    const [command] = terminalCommands("C:\\repos\\my app", "win32");

    expect(command).toEqual({
      file: "cmd.exe",
      args: ["/c", "start", "", "/d", "C:\\repos\\my app", "cmd.exe"],
    });
  });

  test("a WSL install opens a shell inside its distro at the Linux path", () => {
    const [command] = terminalCommands(WSL_DIR, "win32");

    expect(command).toEqual({
      file: "cmd.exe",
      args: ["/c", "start", "", "wsl.exe", "-d", "archlinux", "--cd", "/home/mike/my app"],
    });
  });

  test("macOS hands the folder to Terminal", () => {
    expect(terminalCommands("/Users/mike/repos/one", "darwin")).toEqual([
      { file: "open", args: ["-a", "Terminal", "/Users/mike/repos/one"] },
    ]);
  });

  test("Linux tries $TERMINAL first, then the common ones, each started in the folder", () => {
    const commands = terminalCommands("/home/mike/one", "linux", { TERMINAL: "kitty" });

    expect(commands.map((command) => command.file)).toEqual([
      "kitty",
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
      "xfce4-terminal",
      "xterm",
    ]);
    expect(new Set(commands.map((command) => command.cwd))).toEqual(new Set(["/home/mike/one"]));
    expect(terminalCommands("/home/mike/one", "linux", { TERMINAL: "  " })[0]?.file).toBe(
      "x-terminal-emulator",
    );
  });

  test("a platform with no known terminal has nothing to try", () => {
    expect(terminalCommands("/x", "freebsd")).toEqual([]);
  });
});

describe("opening a terminal", () => {
  test("stops at the first command that spawns", async () => {
    const tried: string[] = [];
    const spawn = async (command: TerminalCommand): Promise<void> => {
      tried.push(command.file);
      if (command.file !== "konsole") throw new Error("ENOENT");
    };

    await openTerminal("/home/mike/one", { platform: "linux", env: {}, spawn });

    expect(tried).toEqual(["x-terminal-emulator", "gnome-terminal", "konsole"]);
  });

  test("refuses when nothing spawned, naming what was tried", async () => {
    const spawn = async (): Promise<void> => {
      throw new Error("ENOENT");
    };

    await expect(
      openTerminal("/Users/mike/one", { platform: "darwin", env: {}, spawn }),
    ).rejects.toMatchObject({
      error: { code: "refused", message: "No terminal opened. Tried open: ENOENT." },
    });
  });

  test("refuses outright where no terminal is known", async () => {
    await expect(
      openTerminal("/x", { platform: "freebsd", env: {}, spawn: async () => undefined }),
    ).rejects.toMatchObject({ error: { code: "refused" } });
  });
});
