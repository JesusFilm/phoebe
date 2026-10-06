// Which agent CLI an install's container carries, and moving it.
//
// The engine spawns a provider's CLI by bare name (`agent`, `claude`, `codex`),
// and the container has whichever version `container/Dockerfile` installed when
// the image was built. So there are three answers to "which version": what the
// Dockerfile pins, what the running container actually has, and what the vendor
// has published since. This reads all three and can move the first.
//
// Moving it is an edit to the Dockerfile and nothing more. The image is rebuilt
// by a `start --build`, which is a run the operator starts and watches like any
// other. An update that also rebuilt would take a deployment down as a side
// effect of pressing a button about a version number.
//
// Cursor's CLI is the awkward one. It is not on npm: the template downloads a
// versioned tarball and checks it against a sha256 per architecture, because
// the vendor publishes no checksums. Moving that pin means computing both
// digests, which means fetching both tarballs. That is what the template's own
// comment tells an operator to do by hand, done here.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  HarnessApplyOutcome,
  HarnessFacts,
  HarnessName,
  HarnessPin,
  HarnessReport,
  HarnessUpdate,
  HarnessUpdateOutcome,
} from "phoebe-agent/contracts";
import {
  defaultCommandRunner,
  resolveDeploymentCompose,
  runCompose,
  type CommandRunner,
} from "../../../src/deployment-compose.ts";
import { PHOEBE_SERVICE } from "./container-read.ts";
import { deploymentDirOf } from "./deployment-dir.ts";

/** Every harness, in the order a page lists them. */
export const HARNESS_NAMES: readonly HarnessName[] = ["cursor", "claude", "codex"];

/** What each is on disk: the command the engine spawns, and its npm package if it has one. */
export const HARNESSES: Record<
  HarnessName,
  { command: string; package: string | null; arg: string }
> = {
  cursor: { command: "agent", package: null, arg: "CURSOR_AGENT_VERSION" },
  claude: { command: "claude", package: "@anthropic-ai/claude-code", arg: "CLAUDE_CODE_VERSION" },
  codex: { command: "codex", package: "@openai/codex", arg: "CODEX_VERSION" },
};

/** The engine's own package: what the image installs to boot from. */
export const LAUNCHER_PACKAGE = "phoebe-agent";

const CURSOR_SHA_ARGS = { x64: "CURSOR_AGENT_SHA256_X64", arm64: "CURSOR_AGENT_SHA256_ARM64" };
const CURSOR_DOWNLOADS = "downloads.cursor.com";
const CURSOR_INSTALLER = "https://cursor.com/install";

/** A version as it may be written into a Dockerfile: no spaces, no shell. */
const SAFE_VERSION = /^[0-9][0-9A-Za-z.-]{0,63}$/;
/** An exact version, as opposed to a range or a tag. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

// ── reading a Dockerfile ───────────────────────────────────────────────────

const isComment = (line: string): boolean => /^\s*#/.test(line);

/** `ARG NAME=value` declarations on lines that are not comments. */
function argsOf(lines: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (const line of lines) {
    if (isComment(line)) continue;
    const match = /^ARG[ \t]+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trimEnd());
    if (match !== null) args.set(match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return args;
}

/** A package named on a line, with the version spec after its `@`, if any. */
function packageSpec(pkg: string): RegExp {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // Not the tail of a longer name or a path: `/data/<name>` is a directory.
  return new RegExp(`(?<![\\w/.-])${escaped}(?:@([^\\s"'\\\\;&|]+))?(?=[\\s"'\\\\;&|]|$)`, "g");
}

/** The ARG a spec such as `${NAME}` names, or null when it is not a variable. */
function variableOf(spec: string): string | null {
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(spec);
  return match === null ? null : match[1]!;
}

/** What a Dockerfile says about every harness. Comments are not instructions. */
export function readHarnessPins(content: string): Record<HarnessName, HarnessPin> {
  const lines = content.split(/\r?\n/);
  const live = lines.filter((line) => !isComment(line));
  const args = argsOf(lines);
  const pins = {} as Record<HarnessName, HarnessPin>;

  for (const harness of HARNESS_NAMES) {
    const { package: pkg } = HARNESSES[harness];
    if (pkg === null) {
      const version = args.get(HARNESSES.cursor.arg);
      if (version !== undefined && live.some((line) => line.includes(CURSOR_DOWNLOADS))) {
        pins[harness] = { kind: "pinned", version };
      } else if (live.some((line) => line.includes("cursor.com/install"))) {
        pins[harness] = { kind: "unpinned" };
      } else {
        pins[harness] = { kind: "absent" };
      }
      continue;
    }
    pins[harness] = packagePin(live, args, pkg);
  }
  return pins;
}

/** How one npm package is installed, by the first live line that names it. */
function packagePin(
  live: readonly string[],
  args: ReadonlyMap<string, string>,
  pkg: string,
): HarnessPin {
  for (const line of live) {
    const match = packageSpec(pkg).exec(line);
    if (match === null) continue;
    const spec = match[1];
    const variable = spec === undefined ? null : variableOf(spec);
    const version = variable === null ? spec : args.get(variable);
    return version !== undefined && EXACT_VERSION.test(version)
      ? { kind: "pinned", version }
      : { kind: "unpinned" };
  }
  return { kind: "absent" };
}

/**
 * What a Dockerfile says about the launcher. Absent is a real answer here: a
 * container that runs the engine from a mounted checkout installs none.
 */
export function readLauncherPin(content: string): HarnessPin {
  const lines = content.split(/\r?\n/);
  return packagePin(
    lines.filter((line) => !isComment(line)),
    argsOf(lines),
    LAUNCHER_PACKAGE,
  );
}

/** Whether moving Cursor's pin in this Dockerfile needs the two digests. */
export function needsCursorDigests(content: string): boolean {
  const args = argsOf(content.split(/\r?\n/));
  return args.has(CURSOR_SHA_ARGS.x64) || args.has(CURSOR_SHA_ARGS.arm64);
}

export type PinRewrite =
  | { ok: true; content: string; from: string | null }
  | { ok: false; why: string; instruction: string | null };

/** Replace the value of every live `ARG name=` declaration. */
function setArg(lines: string[], name: string, value: string): boolean {
  let moved = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isComment(line)) continue;
    if (new RegExp(`^ARG[ \\t]+${name}=`).test(line)) {
      lines[index] = `ARG ${name}=${value}`;
      moved = true;
    }
  }
  return moved;
}

/**
 * Where a new global install goes. After the last one already there, which is
 * where the image is root and has not set HOME to the unprivileged user's yet:
 * an npm run as root after that leaves a root-owned cache in that user's home.
 * A Dockerfile with none gets it just ahead of the drop to that user, above the
 * comment that introduces the USER line rather than between the two.
 */
function insertionPoint(lines: readonly string[]): { index: number; after: boolean } | null {
  let last = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!isComment(lines[index]!) && /\bnpm\s+(install|i)\s+(-g|--global)\b/.test(lines[index]!)) {
      last = index;
    }
  }
  if (last !== -1) {
    // Past the instruction's continuation lines, if it has any.
    while (last < lines.length - 1 && /\\\s*$/.test(lines[last]!)) last += 1;
    return { index: last + 1, after: true };
  }
  const user = lines.findIndex(
    (line) => /^USER[ \t]+/.test(line) && !/^USER[ \t]+(root|0)\b/.test(line),
  );
  if (user === -1) return null;
  let at = user;
  while (at > 0 && isComment(lines[at - 1]!)) at -= 1;
  return { index: at, after: false };
}

/**
 * The Dockerfile with one harness pinned to `version`.
 *
 * An npm harness is rewritten where it is installed: the ARG its spec names, or
 * the spec itself, and a bare package name gains one. One the Dockerfile does
 * not install at all is added beside the global installs already there
 * ({@link insertionPoint}). Cursor's three ARGs move
 * together, and without its block there is nothing here to add: that block is
 * forty lines of the template, not a line.
 */
export function rewriteHarnessPin(
  content: string,
  harness: HarnessName,
  version: string,
  digests?: { x64: string; arm64: string },
): PinRewrite {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const before = readHarnessPins(content)[harness];
  const from = before.kind === "pinned" ? before.version : null;
  const { package: pkg, arg } = HARNESSES[harness];

  if (pkg === null) {
    if (!setArg(lines, arg, version)) {
      return {
        ok: false,
        why: `this Dockerfile has no ${arg} to move`,
        instruction:
          "Copy the Cursor agent block from a freshly scaffolded container/Dockerfile, then pin it here.",
      };
    }
    if (needsCursorDigests(content)) {
      if (digests === undefined) {
        return { ok: false, why: "the tarball digests were not computed", instruction: null };
      }
      setArg(lines, CURSOR_SHA_ARGS.x64, digests.x64);
      setArg(lines, CURSOR_SHA_ARGS.arm64, digests.arm64);
    }
    return { ok: true, content: lines.join(newline), from };
  }

  if (before.kind === "absent") {
    const install = [
      `# The CLI the "${harness}" provider spawns. Pinned, so a rebuild gets the same one.`,
      `ARG ${arg}=${version}`,
      `RUN npm install -g "${pkg}@\${${arg}}"`,
    ];
    const at = insertionPoint(lines);
    if (at === null) {
      return {
        ok: false,
        why: "this Dockerfile has no global npm install or USER line to put the install beside",
        instruction: `Add these two lines where the image still runs as root: ${install.slice(1).join(" / ")}`,
      };
    }
    lines.splice(at.index, 0, ...(at.after ? ["", ...install] : [...install, ""]));
    return { ok: true, content: lines.join(newline), from };
  }

  // Where it is installed: through an ARG, or by a spec on the line itself.
  let variable: string | null = null;
  for (const line of lines) {
    if (isComment(line)) continue;
    const match = packageSpec(pkg).exec(line);
    if (match === null) continue;
    variable = match[1] === undefined ? null : variableOf(match[1]);
    break;
  }
  if (variable !== null && setArg(lines, variable, version)) {
    return { ok: true, content: lines.join(newline), from };
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (isComment(lines[index]!)) continue;
    lines[index] = lines[index]!.replace(packageSpec(pkg), `${pkg}@${version}`);
  }
  return { ok: true, content: lines.join(newline), from };
}

// ── comparing versions ─────────────────────────────────────────────────────

/** The first three numbers of a version: `2.1.228`, and `2026.07.23-e383d2b` alike. */
function numbersOf(version: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Is `current` older than `latest`? Null when either cannot be read. */
export function isBehind(current: string | null, latest: string | null): boolean | null {
  if (current === null || latest === null) return null;
  if (current === latest) return false;
  const a = numbersOf(current);
  const b = numbersOf(latest);
  if (a === null || b === null) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]!;
  }
  // The same numbers and a different build: not the latest, whichever it is.
  return true;
}

// ── asking the container ───────────────────────────────────────────────────

/**
 * One line per volume mount point under `/data` that whoever runs this cannot
 * write: `unwritable|<path>`. The engine's checkout, its clones and its stores
 * all live there, so one such line is a container that cannot start.
 */
const UNWRITABLE_SCRIPT =
  'for d in /data/*; do if [ -d "$d" ] && [ ! -w "$d" ]; then printf "unwritable|%s\\n" "$d"; fi; done';

/** The same question asked of a one-off container, for an install that is not running. */
export const UNWRITABLE_ARGV: readonly string[] = [
  "run",
  "--rm",
  "-T",
  "--no-deps",
  "--entrypoint",
  "sh",
  PHOEBE_SERVICE,
  "-c",
  UNWRITABLE_SCRIPT,
];

/**
 * Give everything under `/data` to the user in `$1`, as root, in a one-off
 * container with the install's own volumes mounted. What the docs give as the
 * one-time step after the move to an unprivileged image (docs/upgrading.md).
 */
export function chownArgv(user: string): readonly string[] {
  return [
    "run",
    "--rm",
    "-T",
    "--no-deps",
    "--user",
    "root",
    "--entrypoint",
    "sh",
    PHOEBE_SERVICE,
    "-c",
    // The user's own group, or the same number when the image has no such name.
    'u="$1"; g=$(id -g "$u" 2>/dev/null || echo "$u"); chown -R "$u:$g" /data && echo done',
    "sh",
    user,
  ];
}

/**
 * One line per command, `<command>|<what --version printed>`, blank after the
 * bar when the container does not have it. `timeout` because a CLI that waits
 * on a network before printing its version should not hold the page.
 */
const VERSIONS_SCRIPT =
  'for c in agent claude codex; do if command -v "$c" >/dev/null 2>&1; then ' +
  'printf "%s|%s\\n" "$c" "$(timeout 20 "$c" --version 2>/dev/null | head -n 1)"; ' +
  'else printf "%s|\\n" "$c"; fi; done; ' +
  // The launcher has no flag to ask; its installed package.json says.
  `printf "${LAUNCHER_PACKAGE}|%s\\n" "$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' ` +
  `"$(npm root -g 2>/dev/null)/${LAUNCHER_PACKAGE}/package.json" 2>/dev/null | head -n 1)"; ` +
  // Who this exec is, which is who the engine and every agent under it are.
  `printf "uid|%s\\n" "$(id -u)"; ${UNWRITABLE_SCRIPT}`;

export const VERSIONS_ARGV: readonly string[] = [
  "exec",
  "-T",
  PHOEBE_SERVICE,
  "sh",
  "-c",
  VERSIONS_SCRIPT,
];

/** What the script printed, by harness. A line with no version in it is null. */
export function parseVersions(stdout: string): Record<HarnessName, string | null> {
  const versions: Record<HarnessName, string | null> = { cursor: null, claude: null, codex: null };
  for (const line of stdout.split("\n")) {
    const [command, said] = line.trim().split("|");
    const harness = HARNESS_NAMES.find((name) => HARNESSES[name].command === command);
    if (harness === undefined || said === undefined) continue;
    versions[harness] = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(said)?.[0] ?? null;
  }
  return versions;
}

/** The uid the container runs as, off the same output, or null when it did not say. */
export function parseUid(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    const [name, said] = line.trim().split("|");
    if (name === "uid" && said !== undefined && /^\d+$/.test(said)) return Number(said);
  }
  return null;
}

/** The mount points the probe could not write, off its output. */
export function parseUnwritable(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    const [name, said] = line.trim().split("|");
    if (name === "unwritable" && said !== undefined && said.startsWith("/")) paths.push(said);
  }
  return paths;
}

/** The user a Dockerfile's last live `USER` names, without its group; null when it has none. */
export function dockerfileUser(content: string): string | null {
  let last: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (isComment(line)) continue;
    const match = /^USER[ \t]+(\S+)/.exec(line);
    if (match !== null) last = match[1]!.split(":")[0] ?? null;
  }
  return last;
}

/** Whether a `USER` value, a Dockerfile's or an image's, is root. No user at all is root. */
export function isRootUser(user: string): boolean {
  const name = user.trim().split(":")[0] ?? "";
  return name === "" || name === "root" || name === "0";
}

/**
 * Whether a Dockerfile ends on a non-root `USER`. The last live one decides,
 * as it does for the image: a `USER root` for an install step followed by a
 * drop is a drop, and a Dockerfile with none runs as root.
 */
export function dockerfileDropsPrivileges(content: string): boolean {
  const user = dockerfileUser(content);
  return user !== null && !isRootUser(user);
}

/** The launcher's version off the same output, or null when the container installs none. */
export function parseLauncherVersion(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const [name, said] = line.trim().split("|");
    if (name === LAUNCHER_PACKAGE && said !== undefined) {
      return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(said)?.[0] ?? null;
    }
  }
  return null;
}

// ── putting a pinned version into a running container ─────────────────────

/** Where swapped-in npm harnesses live, one folder per version, beside the image's own. */
const SWAP_ROOT = "/opt/phoebe-harness";

/**
 * Install one npm harness beside the one the container has, then switch the
 * command to it. `$1` is the command, `$2` the package, `$3` the version.
 *
 * Beside, not over: an `npm install -g` over the top rewrites files a unit in
 * flight may still be reading. A folder per version leaves the old tree whole,
 * and `mv -T` of a symlink is one rename, so every spawn resolves to a complete
 * install: the old one before the switch, the new one after. The last line is
 * what the command answers after it, which is the proof the caller reads.
 */
const APPLY_NPM = [
  "set -eu",
  'h="$1"; pkg="$2"; v="$3"',
  `d="${SWAP_ROOT}/$h-$v"`,
  'if [ ! -e "$d/bin/$h" ]; then',
  '  rm -rf "$d.tmp"',
  '  npm install -g --prefix "$d.tmp" "$pkg@$v" >/tmp/phoebe-harness.log 2>&1 ' +
    "|| { tail -n 3 /tmp/phoebe-harness.log >&2; exit 1; }",
  `  mkdir -p ${SWAP_ROOT}; mv "$d.tmp" "$d"`,
  "fi",
  'ln -sfn "$d/bin/$h" "/usr/local/bin/$h.new"',
  'mv -Tf "/usr/local/bin/$h.new" "/usr/local/bin/$h"',
  '"$h" --version 2>/dev/null | head -n 1',
].join("\n");

/**
 * The same for Cursor, which is a tarball rather than a package: fetched for
 * the container's own architecture, checked against the digest the Dockerfile
 * pins when it pins one (`$2` x64, `$3` arm64), unpacked beside the old one
 * with the template's `chmod 0711` on its bundled node, and both command names
 * switched. `$1` is the version.
 */
const APPLY_CURSOR = [
  "set -eu",
  'v="$1"',
  'case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in',
  '  amd64|x86_64) a=x64; s="$2" ;;',
  '  arm64|aarch64) a=arm64; s="$3" ;;',
  '  *) echo "cursor-agent publishes no build for this architecture" >&2; exit 1 ;;',
  "esac",
  'd="/opt/cursor-agent-$v"',
  'if [ ! -x "$d/cursor-agent" ]; then',
  "  t=$(mktemp)",
  `  curl -fsSL -o "$t" "https://${CURSOR_DOWNLOADS}/lab/$v/linux/$a/agent-cli-package.tar.gz"`,
  '  if [ -n "$s" ]; then echo "$s  $t" | sha256sum -c - >/dev/null; fi',
  '  rm -rf "$d.tmp"; mkdir -p "$d.tmp"',
  '  tar --strip-components=1 -xzf "$t" -C "$d.tmp"',
  '  chmod 0711 "$d.tmp/node"; rm -f "$t"; mv "$d.tmp" "$d"',
  "fi",
  "for n in agent cursor-agent; do",
  '  ln -sfn "$d/cursor-agent" "/usr/local/bin/$n.new"',
  '  mv -Tf "/usr/local/bin/$n.new" "/usr/local/bin/$n"',
  "done",
  "agent --version 2>/dev/null | head -n 1",
].join("\n");

/**
 * The exec that puts `version` of one harness into the running container. As
 * root, because `/usr/local/bin` and `/opt` are root's in the image; the engine
 * child that runs the result is still the unprivileged user.
 */
export function applyArgv(
  harness: HarnessName,
  version: string,
  digests: { x64: string; arm64: string } = { x64: "", arm64: "" },
): readonly string[] {
  const { command, package: pkg } = HARNESSES[harness];
  const exec = ["exec", "-T", "-u", "root", PHOEBE_SERVICE, "sh", "-c"];
  return pkg === null
    ? [...exec, APPLY_CURSOR, "sh", version, digests.x64, digests.arm64]
    : [...exec, APPLY_NPM, "sh", command, pkg, version];
}

/** The two digests a Dockerfile pins for Cursor, empty where it pins none. */
export function cursorDigestsOf(content: string): { x64: string; arm64: string } {
  const args = argsOf(content.split(/\r?\n/));
  return {
    x64: args.get(CURSOR_SHA_ARGS.x64) ?? "",
    arm64: args.get(CURSOR_SHA_ARGS.arm64) ?? "",
  };
}

// ── looking a version up ───────────────────────────────────────────────────

/** GET a URL as text. Throws on anything but a 2xx. */
export type TextFetcher = (url: string) => Promise<string>;
/** The sha256 of what a URL serves, as hex. */
export type Digester = (url: string) => Promise<string>;

export const defaultFetchText: TextFetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
};

export const defaultDigest: Digester = async (url) => {
  // Two of these are about 165 MB between them; five minutes is a slow line.
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || response.body === null) throw new Error(`${url} answered ${response.status}`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
};

/** The newest published version of one harness, or null when it cannot be had. */
export async function latestVersion(
  harness: HarnessName,
  fetchText: TextFetcher = defaultFetchText,
): Promise<string | null> {
  const { package: pkg } = HARNESSES[harness];
  try {
    if (pkg !== null) {
      const body = JSON.parse(await fetchText(`https://registry.npmjs.org/${pkg}/latest`)) as {
        version?: unknown;
      };
      return typeof body.version === "string" && SAFE_VERSION.test(body.version)
        ? body.version
        : null;
    }
    // Cursor has no `latest` to ask. Its installer names the build it would
    // fetch, so the installer is read, and never run.
    const script = await fetchText(CURSOR_INSTALLER);
    return /downloads\.cursor\.com\/lab\/([0-9][0-9A-Za-z.-]*)\//.exec(script)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The newest published launcher, or null when the registry cannot be had. */
export async function latestLauncherVersion(
  fetchText: TextFetcher = defaultFetchText,
): Promise<string | null> {
  try {
    const body = JSON.parse(
      await fetchText(`https://registry.npmjs.org/${LAUNCHER_PACKAGE}/latest`),
    ) as { version?: unknown };
    return typeof body.version === "string" && SAFE_VERSION.test(body.version)
      ? body.version
      : null;
  } catch {
    return null;
  }
}

/** Runs `npm` and returns what it printed: the seam `upgrade` asks the registry through. */
export type NpmLike = (args: readonly string[], opts?: { timeout?: number }) => string;

/**
 * An `npm` for `upgrade` that answers the one question it asks of the registry
 * (`npm view <launcher> version`) with a version already looked up, and hands
 * everything else to the real one.
 *
 * `upgrade` shells out to `npm` for the latest launcher, and the companion's
 * process often has none to run: a packaged app's PATH is not a terminal's, and
 * on Windows `npm` is a `.cmd` that a plain exec does not find. The registry
 * answers the same question over HTTPS. Null means it could not be reached, and
 * that is thrown, which is how `upgrade` already reads a failed `npm view`.
 */
export function registryNpm(latest: string | null, fallback: NpmLike): NpmLike {
  return (args, opts) => {
    if (args[0] === "view" && args[1] === LAUNCHER_PACKAGE && args[2] === "version") {
      if (latest === null) throw new Error("the npm registry could not be reached");
      return latest;
    }
    return fallback(args, opts);
  };
}

/** Where Cursor serves one architecture's tarball of one version. */
export function cursorTarball(version: string, arch: "x64" | "arm64"): string {
  return `https://${CURSOR_DOWNLOADS}/lab/${version}/linux/${arch}/agent-cli-package.tar.gz`;
}

// ── the two calls the bridge makes ─────────────────────────────────────────

export type HarnessDeps = {
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
  write?: (file: string, content: string) => void;
  /** Runs `docker` where the install's containers are: this machine, or its distro. */
  runnerFor?: (installDir: string) => CommandRunner;
  fetchText?: TextFetcher;
  digest?: Digester;
  now?: () => Date;
};

/** The Dockerfile of the install at `dir`, whether or not it is there. */
export function dockerfileOf(dir: string, exists: (file: string) => boolean = existsSync): string {
  return path.join(deploymentDirOf(dir, exists).dir, "container", "Dockerfile");
}

/**
 * The check and the update, sharing what has been looked up.
 *
 * `latest` is remembered between checks, for as long as the companion runs. A
 * check that asks nothing of the network still shows the last answer, so the
 * page that opens after an update does not forget what "latest" was.
 */
export function createHarness(deps: HarnessDeps = {}) {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((file: string) => readFileSync(file, "utf8"));
  const write =
    deps.write ?? ((file: string, content: string) => writeFileSync(file, content, "utf8"));
  const runnerFor = deps.runnerFor ?? (() => defaultCommandRunner);
  const fetchText = deps.fetchText ?? defaultFetchText;
  const digest = deps.digest ?? defaultDigest;
  const now = deps.now ?? (() => new Date());

  const latest = new Map<HarnessName, string>();
  let latestLauncher: string | null = null;
  let latestAt: string | null = null;

  function dockerfileText(dir: string): { file: string; content: string | null } {
    const file = dockerfileOf(dir, exists);
    try {
      return { file, content: exists(file) ? read(file) : null };
    } catch {
      return { file, content: null };
    }
  }

  async function runningVersions(dir: string): Promise<
    | (Record<HarnessName, string | null> & {
        launcher: string | null;
        uid: number | null;
        unwritable: string[];
      })
    | null
  > {
    const deployment = resolveDeploymentCompose(deploymentDirOf(dir, exists).dir, exists);
    if ("kind" in deployment) return null;
    try {
      const result = await runCompose({
        deployment,
        args: VERSIONS_ARGV,
        runner: runnerFor(dir),
      });
      return result.code === 0
        ? {
            ...parseVersions(result.stdout),
            launcher: parseLauncherVersion(result.stdout),
            uid: parseUid(result.stdout),
            unwritable: parseUnwritable(result.stdout),
          }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the image a stopped install would start from runs as root: the
   * image its compose file names, as Docker holds it. Null when there is no
   * such image yet, or Docker could not be asked.
   */
  async function imageRunsAsRoot(dir: string): Promise<boolean | null> {
    const deployment = resolveDeploymentCompose(deploymentDirOf(dir, exists).dir, exists);
    if ("kind" in deployment) return null;
    const runner = runnerFor(dir);
    try {
      const named = await runCompose({ deployment, args: ["config", "--images"], runner });
      const image = named.code === 0 ? named.stdout.trim().split("\n")[0]?.trim() : undefined;
      if (image === undefined || image === "") return null;
      const inspected = await runner({
        file: "docker",
        args: ["image", "inspect", "--format", "{{.Config.User}}|", image],
      });
      // The bar is what tells an image with no user from an answer that never came.
      if (inspected.code !== 0 || !inspected.stdout.includes("|")) return null;
      return isRootUser(inspected.stdout.trim().split("|")[0] ?? "");
    } catch {
      return null;
    }
  }

  /**
   * A stopped install: who its image would run as, and, when that is not root
   * and the install has been started before, what a one-off container of it
   * cannot write. Never started is never asked: a one-off container would
   * create the volumes, and a read does not make things.
   */
  async function stoppedContainer(
    dir: string,
  ): Promise<{ root: boolean | null; unwritable: string[] }> {
    const root = await imageRunsAsRoot(dir);
    if (root !== false) return { root, unwritable: [] };
    const deployment = resolveDeploymentCompose(deploymentDirOf(dir, exists).dir, exists);
    if ("kind" in deployment) return { root, unwritable: [] };
    const runner = runnerFor(dir);
    try {
      const made = await runCompose({ deployment, args: ["ps", "-aq", PHOEBE_SERVICE], runner });
      if (made.code !== 0 || made.stdout.trim() === "") return { root, unwritable: [] };
      const probed = await runCompose({ deployment, args: UNWRITABLE_ARGV, runner });
      return { root, unwritable: probed.code === 0 ? parseUnwritable(probed.stdout) : [] };
    } catch {
      return { root, unwritable: [] };
    }
  }

  return {
    /**
     * Give the install's volumes to the user its Dockerfile runs the container
     * as ({@link chownArgv}). Only for a Dockerfile that names one: with no
     * `USER` the container is root and already owns them.
     */
    async ownVolumes(dir: string): Promise<{ fixed: boolean; detail: string }> {
      const { content } = dockerfileText(dir);
      const user = content === null ? null : dockerfileUser(content);
      if (user === null || isRootUser(user) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)) {
        return {
          fixed: false,
          detail: "The Dockerfile names no unprivileged user to give the volumes to.",
        };
      }
      const deployment = resolveDeploymentCompose(deploymentDirOf(dir, exists).dir, exists);
      if ("kind" in deployment) return { fixed: false, detail: "This install has no container." };
      try {
        const result = await runCompose({
          deployment,
          args: chownArgv(user),
          runner: runnerFor(dir),
        });
        return result.code === 0 && result.stdout.includes("done")
          ? {
              fixed: true,
              detail: `Everything under /data now belongs to ${user}, the user the container runs as. Nothing in the volumes was removed.`,
            }
          : {
              fixed: false,
              detail:
                (result.stderr || result.stdout).trim().split("\n").pop() ||
                "The volumes could not be handed over.",
            };
      } catch (error) {
        return { fixed: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },

    /**
     * Every harness on one install. The network is asked only when `lookUp` is
     * set: opening a page reads a file and asks a container, and nothing leaves
     * the machine until somebody presses the button that says so.
     */
    async check(opts: { dir: string; running: boolean; lookUp: boolean }): Promise<HarnessReport> {
      const { file, content } = dockerfileText(opts.dir);
      const pins = content === null ? null : readHarnessPins(content);
      const [inContainer, stopped] = await Promise.all([
        opts.running ? runningVersions(opts.dir) : Promise.resolve(null),
        // A stopped install has no container to ask, so its image is asked.
        opts.running || content === null ? Promise.resolve(null) : stoppedContainer(opts.dir),
        opts.lookUp
          ? Promise.all([
              ...HARNESS_NAMES.map(async (harness) => {
                const found = await latestVersion(harness, fetchText);
                if (found !== null) latest.set(harness, found);
              }),
              latestLauncherVersion(fetchText).then((found) => {
                if (found !== null) latestLauncher = found;
              }),
            ]).then(() => {
              latestAt = now().toISOString();
            })
          : Promise.resolve(),
      ]);

      const harnesses = HARNESS_NAMES.map((harness): HarnessFacts => {
        const pin: HarnessPin = pins?.[harness] ?? { kind: "absent" };
        const running = inContainer?.[harness] ?? null;
        const newest = latest.get(harness) ?? null;
        const current =
          pin.kind === "pinned" ? pin.version : pin.kind === "unpinned" ? running : null;
        return { harness, pin, running, latest: newest, behind: isBehind(current, newest) };
      });
      const launcherPin: HarnessPin =
        content === null ? { kind: "absent" } : readLauncherPin(content);
      const launcherRunning = inContainer?.launcher ?? null;
      return {
        dockerfile: content === null ? null : file,
        harnesses,
        launcher: {
          pin: launcherPin,
          running: launcherRunning,
          latest: latestLauncher,
          behind: isBehind(
            launcherPin.kind === "pinned"
              ? launcherPin.version
              : launcherPin.kind === "unpinned"
                ? launcherRunning
                : null,
            latestLauncher,
          ),
        },
        user: {
          root:
            inContainer !== null && inContainer.uid !== null
              ? inContainer.uid === 0
              : (stopped?.root ?? null),
          dockerfileDrops: content !== null && dockerfileDropsPrivileges(content),
          unwritable: inContainer?.unwritable ?? stopped?.unwritable ?? [],
        },
        containerAsked: inContainer !== null,
        latestAt,
      };
    },

    /**
     * Put the version the Dockerfile pins into the install's running container
     * ({@link APPLY_NPM}). The pin is the source: this never installs a version
     * the file does not name, so a container and the next build of its image
     * agree.
     */
    async apply(dir: string, harness: HarnessName): Promise<HarnessApplyOutcome> {
      const refused = (why: string): HarnessApplyOutcome => ({ kind: "refused", harness, why });
      if (!HARNESS_NAMES.includes(harness)) return refused(`${String(harness)} is not a harness`);
      const { file, content } = dockerfileText(dir);
      if (content === null) return refused(`there is no Dockerfile at ${file}`);
      const pin = readHarnessPins(content)[harness];
      if (pin.kind !== "pinned" || !SAFE_VERSION.test(pin.version)) {
        return refused("the Dockerfile pins no version of it to put there");
      }
      const deployment = resolveDeploymentCompose(deploymentDirOf(dir, exists).dir, exists);
      if ("kind" in deployment) return refused("this install has no container");
      let result;
      try {
        result = await runCompose({
          deployment,
          args: applyArgv(harness, pin.version, cursorDigestsOf(content)),
          runner: runnerFor(dir),
        });
      } catch (error) {
        return refused(error instanceof Error ? error.message : String(error));
      }
      if (result.code !== 0) {
        const said = (result.stderr || result.stdout).trim().split("\n").pop() ?? "";
        return refused(said === "" ? "the container refused the install" : said);
      }
      // What the command answers now is the proof, not the exit code alone.
      const now = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(result.stdout)?.[0] ?? null;
      return now === pin.version
        ? { kind: "applied", harness, version: pin.version }
        : refused(
            `the container's ${HARNESSES[harness].command} answers ${now ?? "nothing"} after the switch`,
          );
    },

    /** Pin one harness in the install's Dockerfile. Never rebuilds anything. */
    async update(dir: string, update: HarnessUpdate): Promise<HarnessUpdateOutcome> {
      const { harness, version } = update;
      const refused = (why: string, instruction: string | null = null): HarnessUpdateOutcome => ({
        kind: "refused",
        harness,
        why,
        instruction,
      });
      if (!HARNESS_NAMES.includes(harness)) return refused(`${String(harness)} is not a harness`);
      // The version is written into a Dockerfile, so it is a version or nothing.
      if (!SAFE_VERSION.test(version)) return refused(`"${version}" is not a version`);

      const { file, content } = dockerfileText(dir);
      if (content === null) return refused(`there is no Dockerfile at ${file}`);
      const before = readHarnessPins(content)[harness];
      if (before.kind === "pinned" && before.version === version) {
        return { kind: "unchanged", harness, version };
      }

      let digests: { x64: string; arm64: string } | undefined;
      if (harness === "cursor" && needsCursorDigests(content)) {
        try {
          const [x64, arm64] = await Promise.all([
            digest(cursorTarball(version, "x64")),
            digest(cursorTarball(version, "arm64")),
          ]);
          digests = { x64, arm64 };
        } catch (error) {
          return refused(
            `the tarballs for ${version} could not be fetched to pin their digests: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }

      const rewritten = rewriteHarnessPin(content, harness, version, digests);
      if (!rewritten.ok) return refused(rewritten.why, rewritten.instruction);
      try {
        write(file, rewritten.content);
      } catch (error) {
        return refused(
          `${file} could not be written: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { kind: "moved", harness, from: rewritten.from, to: version, file };
    },
  };
}
