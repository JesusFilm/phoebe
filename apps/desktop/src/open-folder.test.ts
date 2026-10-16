import { EventEmitter } from "node:events";
import { describe, expect, test } from "vite-plus/test";
import {
  openTerminal,
  terminalCommands,
  terminalSpawner,
  type SpawnedLike,
  type TerminalCommand,
} from "./open-folder.ts";

const B = "\\";
const WSL_DIR = `${B}${B}wsl.localhost${B}archlinux${B}home${B}mike${B}my app`;

describe("the terminal a folder opens in", () => {
  // `start` is a `cmd.exe` builtin, and `cmd.exe` parses its whole line
  // before `start` sees it: a folder called `foo&calc` on that line runs
  // `calc`. So the folder is the working directory the window inherits, and
  // the line carries nothing but the empty title `start` reads first.
  test("Windows starts a console window in the folder, with the folder off the line", () => {
    const [command] = terminalCommands("C:\\repos\\foo&calc", "win32");

    expect(command).toEqual({
      file: "cmd.exe",
      args: ["/c", "start", "", "cmd.exe"],
      cwd: "C:\\repos\\foo&calc",
    });
  });

  // The distro's folder has to be named to `wsl.exe --cd`, so it goes in
  // quotes, inside which `cmd.exe` leaves `&` alone; the distro goes bare,
  // because `wsl.exe` reads quotes on `-d` as part of the name.
  test("a WSL install opens a shell inside its distro at the quoted Linux path", () => {
    const [command] = terminalCommands(`${WSL_DIR}&calc`, "win32");

    expect(command).toEqual({
      file: "cmd.exe",
      args: ["/c", "start", '""', "wsl.exe", "-d", "archlinux", "--cd", '"/home/mike/my app&calc"'],
      verbatim: true,
    });
  });

  test("a WSL folder quotes cannot cover is refused, and so is a distro name that is not one", () => {
    expect(() => terminalCommands(`${WSL_DIR}${B}a"b`, "win32")).toThrow(/cannot be passed/);
    expect(() => terminalCommands(`${WSL_DIR}${B}%TEMP%`, "win32")).toThrow(/cannot be passed/);
    expect(() => terminalCommands(`${B}${B}wsl.localhost${B}arch linux${B}home`, "win32")).toThrow(
      /not a name a WSL distro can have/,
    );
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

/** A child that does what the script says, in order, after it is spawned. */
function fakeChild(script: (child: EventEmitter & { stderr: EventEmitter }) => void): SpawnedLike {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), unref: () => {} });
  queueMicrotask(() => script(child));
  return {
    once: (event, listener) => child.once(event, listener as (...args: unknown[]) => void),
    stderr: { on: (event, listener) => child.stderr.on(event, listener), destroy: () => {} },
    unref: child.unref,
  };
}

describe("telling a launcher that failed from a terminal that opened", () => {
  // The spawn event alone says only that the launcher started: `start` on
  // Windows exits at once whether or not the window it asked for came up.
  test("a launcher that exits with zero handed off", async () => {
    const spawner = terminalSpawner({
      graceMs: 50,
      spawn: () => fakeChild((child) => child.emit("exit", 0, null)),
    });

    await expect(spawner({ file: "cmd.exe", args: [] })).resolves.toBeUndefined();
  });

  test("a launcher that exits with anything else failed, and says what it said", async () => {
    const spawner = terminalSpawner({
      graceMs: 50,
      spawn: () =>
        fakeChild((child) => {
          child.stderr.emit("data", "There is no distribution with the supplied name.\n");
          child.emit("exit", 1, null);
        }),
    });

    await expect(spawner({ file: "cmd.exe", args: [] })).rejects.toThrow(
      "There is no distribution with the supplied name.",
    );
  });

  test("a child still up when the grace ends is the terminal itself", async () => {
    const spawner = terminalSpawner({ graceMs: 20, spawn: () => fakeChild(() => undefined) });

    await expect(spawner({ file: "xterm", args: [], cwd: "/x" })).resolves.toBeUndefined();
  });

  test("a child that cannot be spawned at all is a failure with the OS's reason", async () => {
    const spawner = terminalSpawner({
      graceMs: 50,
      spawn: () => fakeChild((child) => child.emit("error", new Error("spawn kitty ENOENT"))),
    });

    await expect(spawner({ file: "kitty", args: [] })).rejects.toThrow("ENOENT");
  });

  test("the command's folder and verbatim flag reach the spawn", async () => {
    const seen: unknown[] = [];
    const spawner = terminalSpawner({
      graceMs: 20,
      spawn: (file, args, options) => {
        seen.push([file, args, options]);
        return fakeChild((child) => child.emit("exit", 0, null));
      },
    });

    await spawner({ file: "cmd.exe", args: ["/c"], verbatim: true });
    await spawner({ file: "xterm", args: [], cwd: "/x" });

    expect(seen).toEqual([
      [
        "cmd.exe",
        ["/c"],
        {
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
          windowsVerbatimArguments: true,
        },
      ],
      ["xterm", [], { detached: true, stdio: ["ignore", "ignore", "pipe"], cwd: "/x" }],
    ]);
  });
});

describe("opening a terminal", () => {
  const present = { exists: () => true };

  test("stops at the first command that opens", async () => {
    const tried: string[] = [];
    const spawn = async (command: TerminalCommand): Promise<void> => {
      tried.push(command.file);
      if (command.file !== "konsole") throw new Error("ENOENT");
    };

    await openTerminal("/home/mike/one", { platform: "linux", env: {}, spawn, ...present });

    expect(tried).toEqual(["x-terminal-emulator", "gnome-terminal", "konsole"]);
  });

  test("refuses when nothing opened, naming what was tried", async () => {
    const spawn = async (): Promise<void> => {
      throw new Error("ENOENT");
    };

    await expect(
      openTerminal("/Users/mike/one", { platform: "darwin", env: {}, spawn, ...present }),
    ).rejects.toMatchObject({
      error: { code: "refused", message: "No terminal opened. Tried open: ENOENT." },
    });
  });

  test("refuses a folder this machine cannot see, before trying anything", async () => {
    let tried = 0;
    const spawn = async (): Promise<void> => {
      tried += 1;
    };

    await expect(
      openTerminal(WSL_DIR, { platform: "win32", env: {}, spawn, exists: () => false }),
    ).rejects.toMatchObject({
      error: { code: "refused", message: expect.stringContaining(WSL_DIR) },
    });
    expect(tried).toBe(0);
  });

  test("refuses outright where no terminal is known", async () => {
    await expect(
      openTerminal("/x", {
        platform: "freebsd",
        env: {},
        spawn: async () => undefined,
        ...present,
      }),
    ).rejects.toMatchObject({ error: { code: "refused" } });
  });
});
