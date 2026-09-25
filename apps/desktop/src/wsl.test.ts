import { describe, expect, test } from "vite-plus/test";
import type { CommandRunner } from "../../../src/deployment-compose.ts";
import type { EventSpawner } from "./container-read.ts";
import type { StdinSpawner } from "./secret-write.ts";
import {
  linuxPathIn,
  listWslDistros,
  withoutWslNoise,
  wslCommand,
  wslEventSpawner,
  wslLocationOf,
  wslRunner,
  wslStdinSpawner,
} from "./wsl.ts";

const B = "\\";
const ROOT = `${B}${B}wsl.localhost${B}archlinux`;
const DIR = `${ROOT}${B}home${B}mike${B}development`;
const LOCATION = { distro: "archlinux", dir: "/home/mike/development" };

describe("which folders are inside a distro", () => {
  test("the wsl.localhost host, with the distro and the Linux path read off it", () => {
    expect(wslLocationOf(DIR)).toEqual(LOCATION);
  });

  test("the older wsl$ host is the same folder", () => {
    expect(wslLocationOf(`${B}${B}wsl$${B}archlinux${B}home${B}mike${B}development`)).toEqual(
      LOCATION,
    );
  });

  test("case and slash direction are Windows's to vary", () => {
    expect(wslLocationOf("//WSL.LOCALHOST/Ubuntu-24.04/srv/phoebe/")).toEqual({
      distro: "Ubuntu-24.04",
      dir: "/srv/phoebe",
    });
  });

  test("the distro's root is a folder too", () => {
    expect(wslLocationOf(ROOT)).toEqual({ distro: "archlinux", dir: "/" });
    expect(wslLocationOf(`${ROOT}${B}`)).toEqual({ distro: "archlinux", dir: "/" });
  });

  test("a folder on this machine's own filesystem is not one", () => {
    expect(wslLocationOf(`C:${B}repos${B}phoebe`)).toBeNull();
    expect(wslLocationOf("/home/mike/development")).toBeNull();
    expect(wslLocationOf(`${B}${B}fileserver${B}share${B}phoebe`)).toBeNull();
    expect(wslLocationOf(`${B}${B}wsl.localhost`)).toBeNull();
  });
});

describe("naming a path inside the distro", () => {
  test("a path under the same distro is the Linux path", () => {
    expect(linuxPathIn(LOCATION, `${DIR}${B}container${B}compose.yml`)).toBe(
      "/home/mike/development/container/compose.yml",
    );
  });

  test("the distro's name is matched without regard to case", () => {
    expect(linuxPathIn(LOCATION, `${B}${B}wsl.localhost${B}ArchLinux${B}tmp`)).toBe("/tmp");
  });

  test("another distro, or this machine, has no name inside it", () => {
    expect(linuxPathIn(LOCATION, `${B}${B}wsl.localhost${B}ubuntu${B}tmp`)).toBeNull();
    expect(linuxPathIn(LOCATION, `C:${B}tmp`)).toBeNull();
    expect(linuxPathIn(LOCATION, "ps")).toBeNull();
  });
});

describe("the command that runs inside the distro", () => {
  test("wsl.exe, the distro, the cwd, then the command with its paths translated", () => {
    const command = wslCommand(LOCATION, {
      file: "docker",
      args: [
        "compose",
        "-f",
        `${DIR}${B}container${B}compose.yml`,
        "--env-file",
        `${DIR}${B}.env`,
        "ps",
        "-a",
        "--format",
        "json",
      ],
      cwd: `${DIR}${B}container`,
    });

    expect(command).toEqual({
      file: "wsl.exe",
      args: [
        "-d",
        "archlinux",
        "--cd",
        "/home/mike/development/container",
        "--exec",
        "docker",
        "compose",
        "-f",
        "/home/mike/development/container/compose.yml",
        "--env-file",
        "/home/mike/development/.env",
        "ps",
        "-a",
        "--format",
        "json",
      ],
    });
  });

  test("no cwd, or one outside the distro, means no --cd", () => {
    expect(wslCommand(LOCATION, { file: "docker", args: ["version"] }).args).toEqual([
      "-d",
      "archlinux",
      "--exec",
      "docker",
      "version",
    ]);
    expect(
      wslCommand(LOCATION, { file: "docker", args: ["version"], cwd: `C:${B}Users${B}mike` }).args,
    ).not.toContain("--cd");
  });
});

describe("what wsl.exe itself says", () => {
  test("its UTF-16 messages lose their NULs; the command's own output is untouched", () => {
    expect(withoutWslNoise("T\u0000h\u0000e\u0000r\u0000e\u0000")).toBe("There");
    expect(withoutWslNoise('{"Name":"phoebe"}\n')).toBe('{"Name":"phoebe"}\n');
  });
});

describe("which distros this machine has", () => {
  /** `wsl.exe -l -q` as it really prints: UTF-16, so a NUL after every character. */
  function wslList(code: number, ...names: string[]): CommandRunner {
    const text = names.map((name) => `${name}\r\n`).join("");
    const noisy = text
      .split("")
      .map((char) => `${char}\u0000`)
      .join("");
    return () => Promise.resolve({ code, stdout: noisy, stderr: "" });
  }

  test("the names wsl.exe lists, readable, in its order", async () => {
    const distros = await listWslDistros({
      platform: "win32",
      runner: wslList(0, "archlinux", "docker-desktop"),
    });

    expect(distros).toEqual(["archlinux", "docker-desktop"]);
  });

  test("off Windows there are none, and wsl.exe is not even asked", async () => {
    let asked = false;
    const distros = await listWslDistros({
      platform: "linux",
      runner: () => {
        asked = true;
        return Promise.resolve({ code: 0, stdout: "archlinux\n", stderr: "" });
      },
    });

    expect(distros).toEqual([]);
    expect(asked).toBe(false);
  });

  test("a wsl.exe that fails or is missing means no distro to offer", async () => {
    expect(await listWslDistros({ platform: "win32", runner: wslList(1) })).toEqual([]);
    expect(
      await listWslDistros({
        platform: "win32",
        runner: () => Promise.reject(new Error("ENOENT")),
      }),
    ).toEqual([]);
  });
});

describe("the three seams", () => {
  test("a runner's commands run inside the distro and come back readable", async () => {
    const seen: { file: string; args: readonly string[]; cwd?: string | undefined }[] = [];
    const runner: CommandRunner = (spec) => {
      seen.push(spec);
      return Promise.resolve({ code: 1, stdout: "", stderr: "N\u0000o\u0000 distro" });
    };

    const result = await wslRunner(
      LOCATION,
      runner,
    )({
      file: "docker",
      args: ["compose", "version"],
      cwd: `${DIR}${B}container`,
      inheritStdio: true,
    });

    expect(seen[0]?.file).toBe("wsl.exe");
    expect(seen[0]?.args).toEqual([
      "-d",
      "archlinux",
      "--cd",
      "/home/mike/development/container",
      "--exec",
      "docker",
      "compose",
      "version",
    ]);
    expect((seen[0] as { inheritStdio?: boolean }).inheritStdio).toBe(true);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "No distro" });
  });

  test("the events stream is subscribed to from inside the distro", () => {
    const seen: { file: string; args: readonly string[] }[] = [];
    const spawner: EventSpawner = (spec) => {
      seen.push(spec);
      return { stdout: null, on: () => undefined, kill: () => undefined };
    };

    wslEventSpawner(
      LOCATION,
      spawner,
    )({
      file: "docker",
      args: ["compose", "-f", `${DIR}${B}container${B}compose.yml`, "events", "--json"],
      cwd: `${DIR}${B}container`,
    });

    expect(seen[0]?.file).toBe("wsl.exe");
    expect(seen[0]?.args).toContain("/home/mike/development/container/compose.yml");
    expect(seen[0]?.args).toContain("--exec");
  });

  test("the stdin-fed exec runs inside the distro and the value still rides on stdin", async () => {
    const seen: { file: string; args: readonly string[]; input: string }[] = [];
    const spawner: StdinSpawner = (spec) => {
      seen.push(spec);
      return Promise.resolve({ code: 0 });
    };

    await wslStdinSpawner(
      LOCATION,
      spawner,
    )({
      file: "docker",
      args: ["compose", "exec", "-T", "phoebe", "phoebe", "secret", "set", "GH_TOKEN"],
      cwd: `${DIR}${B}container`,
      input: "ghp_secret",
      onLine: () => undefined,
    });

    expect(seen[0]?.file).toBe("wsl.exe");
    expect(seen[0]?.args.slice(0, 5)).toEqual([
      "-d",
      "archlinux",
      "--cd",
      "/home/mike/development/container",
      "--exec",
    ]);
    expect(seen[0]?.input).toBe("ghp_secret");
  });
});
