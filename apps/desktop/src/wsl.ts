// A local install that lives inside a WSL distro.
//
// Windows shows a distro's filesystem at `\\wsl.localhost\<distro>\…` (older
// builds: `\\wsl$\<distro>\…`), and the folder picker hands such a path back
// like any other. Node reads and writes through it as it would any folder — the
// config, the Dockerfile pin, the `.env`, an `init` — so every fact this package
// derives from files needs nothing done to it.
//
// What does not carry across is Docker. Compose run from Windows resolves the
// deployment's bind mounts to the same UNC paths, which Docker Desktop cannot
// mount, and the operator's containers were started by the distro's own
// `docker` in the first place. So for a WSL install every `docker` the companion
// would spawn is spawned inside the distro instead —
// `wsl.exe -d <distro> --cd <dir> --exec docker …` — with each path argument
// translated to the one the distro knows it by. The three seams below are the
// three ways this package spawns anything, and each gets one wrapper.
//
// `--exec` rather than `--`: the command runs without the distro's shell, so an
// argument arrives as it was given and nothing is quoted twice.

import { defaultCommandRunner, type CommandRunner } from "../../../src/deployment-compose.ts";
import type { EventSpawner } from "./container-read.ts";
import type { StdinSpawner } from "./secret-write.ts";

/** Where inside WSL an install is: the distro, and the path the distro knows. */
export type WslLocation = {
  distro: string;
  /** The install's directory as the distro sees it — `/home/mike/development`. */
  dir: string;
};

/**
 * The two hosts Windows serves a distro's files under, either slash direction,
 * any case. The distro is the first segment after the host, the rest is the path.
 */
const WSL_ROOT = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i;

/** Is this folder inside a WSL distro? Null for every other kind of path. */
export function wslLocationOf(path: string): WslLocation | null {
  const match = WSL_ROOT.exec(path);
  if (match === null) return null;
  return { distro: match[1] as string, dir: linuxPathOf(match[2] ?? "") };
}

function linuxPathOf(rest: string): string {
  const segments = rest.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return `/${segments.join("/")}`;
}

/**
 * The Linux path of a Windows path under the same distro, or null when it is
 * somewhere else — another distro, or this machine's own filesystem — and so
 * has no name inside that distro.
 */
export function linuxPathIn(location: WslLocation, path: string): string | null {
  const parsed = wslLocationOf(path);
  if (parsed === null || parsed.distro.toLowerCase() !== location.distro.toLowerCase()) {
    return null;
  }
  return parsed.dir;
}

/**
 * The same command, run inside the distro. `cwd` becomes `--cd` when it is
 * under the distro, and every argument that names a path there is translated;
 * anything else — `compose`, `ps`, a service name, a flag — is passed through.
 */
export function wslCommand(
  location: WslLocation,
  spec: { file: string; args: readonly string[]; cwd?: string | undefined },
): { file: string; args: string[] } {
  const cwd = spec.cwd === undefined ? null : linuxPathIn(location, spec.cwd);
  return {
    file: "wsl.exe",
    args: [
      "-d",
      location.distro,
      ...(cwd === null ? [] : ["--cd", cwd]),
      "--exec",
      spec.file,
      ...spec.args.map((arg) => linuxPathIn(location, arg) ?? arg),
    ],
  };
}

/**
 * What `wsl.exe` itself says — a distro that does not exist, a WSL that is not
 * installed — comes out UTF-16 with a NUL between every character, while what
 * the Linux command prints comes through as it was. Dropping the NULs makes the
 * first kind readable without disturbing the second.
 */
export function withoutWslNoise(text: string): string {
  return text.replaceAll("\u0000", "");
}

/** Where Windows serves every distro's files. The picker opens here (#527 §12). */
export const WSL_PICKER_ROOT = "\\\\wsl.localhost\\";

/**
 * The distros on this machine, as `wsl.exe -l -q` names them, in its order.
 * Empty off Windows, on a Windows with no WSL, and when `wsl.exe` fails to
 * answer — every one of those is a machine with no distro to offer.
 */
export async function listWslDistros(
  deps: { runner?: CommandRunner; platform?: string } = {},
): Promise<string[]> {
  if ((deps.platform ?? process.platform) !== "win32") return [];
  const runner = deps.runner ?? defaultCommandRunner;
  let result;
  try {
    result = await runner({ file: "wsl.exe", args: ["-l", "-q"] });
  } catch {
    return [];
  }
  if (result.code !== 0) return [];
  return withoutWslNoise(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A runner whose every command runs inside the distro. */
export function wslRunner(location: WslLocation, runner: CommandRunner): CommandRunner {
  return async (spec) => {
    const result = await runner({ ...spec, ...wslCommand(location, spec) });
    return {
      ...result,
      stdout: withoutWslNoise(result.stdout),
      stderr: withoutWslNoise(result.stderr),
    };
  };
}

/** The events stream, subscribed to from inside the distro. */
export function wslEventSpawner(location: WslLocation, spawner: EventSpawner): EventSpawner {
  return (spec) => spawner({ ...spec, ...wslCommand(location, spec) });
}

/** The stdin-fed exec, run inside the distro. The value still travels on stdin. */
export function wslStdinSpawner(location: WslLocation, spawner: StdinSpawner): StdinSpawner {
  return (spec) => spawner({ ...spec, ...wslCommand(location, spec) });
}
