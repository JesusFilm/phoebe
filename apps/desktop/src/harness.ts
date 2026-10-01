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
  return new RegExp(`${escaped}(?:@([^\\s"'\\\\;&|]+))?(?=[\\s"'\\\\;&|]|$)`, "g");
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
    let found: HarnessPin = { kind: "absent" };
    for (const line of live) {
      const match = packageSpec(pkg).exec(line);
      if (match === null) continue;
      const spec = match[1];
      const variable = spec === undefined ? null : variableOf(spec);
      const version = variable === null ? spec : args.get(variable);
      found =
        version !== undefined && EXACT_VERSION.test(version)
          ? { kind: "pinned", version }
          : { kind: "unpinned" };
      break;
    }
    pins[harness] = found;
  }
  return pins;
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
 * One line per command, `<command>|<what --version printed>`, blank after the
 * bar when the container does not have it. `timeout` because a CLI that waits
 * on a network before printing its version should not hold the page.
 */
const VERSIONS_SCRIPT =
  'for c in agent claude codex; do if command -v "$c" >/dev/null 2>&1; then ' +
  'printf "%s|%s\\n" "$c" "$(timeout 20 "$c" --version 2>/dev/null | head -n 1)"; ' +
  'else printf "%s|\\n" "$c"; fi; done';

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
  let latestAt: string | null = null;

  function dockerfileText(dir: string): { file: string; content: string | null } {
    const file = dockerfileOf(dir, exists);
    try {
      return { file, content: exists(file) ? read(file) : null };
    } catch {
      return { file, content: null };
    }
  }

  async function runningVersions(dir: string): Promise<Record<HarnessName, string | null> | null> {
    const deployment = resolveDeploymentCompose(deploymentDirOf(dir, exists).dir, exists);
    if ("kind" in deployment) return null;
    try {
      const result = await runCompose({
        deployment,
        args: VERSIONS_ARGV,
        runner: runnerFor(dir),
      });
      return result.code === 0 ? parseVersions(result.stdout) : null;
    } catch {
      return null;
    }
  }

  return {
    /**
     * Every harness on one install. The network is asked only when `lookUp` is
     * set: opening a page reads a file and asks a container, and nothing leaves
     * the machine until somebody presses the button that says so.
     */
    async check(opts: { dir: string; running: boolean; lookUp: boolean }): Promise<HarnessReport> {
      const { file, content } = dockerfileText(opts.dir);
      const pins = content === null ? null : readHarnessPins(content);
      const [inContainer] = await Promise.all([
        opts.running ? runningVersions(opts.dir) : Promise.resolve(null),
        opts.lookUp
          ? Promise.all(
              HARNESS_NAMES.map(async (harness) => {
                const found = await latestVersion(harness, fetchText);
                if (found !== null) latest.set(harness, found);
              }),
            ).then(() => {
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
      return {
        dockerfile: content === null ? null : file,
        harnesses,
        containerAsked: inContainer !== null,
        latestAt,
      };
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
