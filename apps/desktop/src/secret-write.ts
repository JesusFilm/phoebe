// The **two local secret writers**, and the rule that picks between them
// (#527 §8, #526, map #497).
//
// A local install has two places a secret can go, and which one is not a choice
// the operator makes — it is a reading of what is there to write to.
//
// **Running**: the container is up, so the value goes where a secret belongs on
// a deployment that has one — the tenant secret store on the data volume,
// written by `phoebe secret set` inside the container (#504). That volume is a
// named Docker volume; nothing on the host can reach it, and nothing here
// tries.
//
// **Stopped, or freshly initialised**: there is no container, so the only place
// left is the deployment `.env` beside `phoebe.config.ts`. This is the file the
// operator would have opened in an editor, and it is where `GH_TOKEN` is typed
// for the first time — before which no container can start at all.
//
// **The value never appears in an argument.** The container writer pipes it on
// the child's stdin, because a value in `docker compose exec …` argv lands in
// `/proc/<pid>/cmdline` on the host, which is exactly the leak #504 moved the
// CLI's own value onto stdin to avoid. The host writer never logs the line it
// wrote. Nothing in this module puts a value in a returned object, an error
// message or a line the run prints.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InstallState, SecretSetOutcome, SecretWriter, VerbIo } from "phoebe-agent/contracts";
import {
  buildComposeArgv,
  DEPLOYMENT_ENV_REL_PATH,
  type DeploymentCompose,
} from "../../../src/deployment-compose.ts";

/** The service the engine runs as, in the scaffolded compose file. */
const PHOEBE_SERVICE = "phoebe";

/** Mode `0600`: a file holding a token is the operator's to read and nobody else's. */
const ENV_FILE_MODE = 0o600;

/**
 * Which writer this install's state calls for.
 *
 * Read off the state rather than asked, and derived nowhere else: a running
 * install has a store to write to, and anything else has a file.
 */
export function secretWriterFor(state: InstallState): SecretWriter {
  return state === "running" ? "container" : "host-env";
}

/** Something that can be spawned with a pipe on stdin. The seam the test drives. */
export type StdinSpawner = (spec: {
  file: string;
  args: readonly string[];
  cwd: string;
  /** Written to the child's stdin and then closed. Never logged. */
  input: string;
  onLine: (stream: "stdout" | "stderr", line: string) => void;
}) => Promise<{ code: number }>;

/**
 * Run `phoebe secret set <KEY>` inside the install's container, with the value
 * on stdin.
 *
 * `-T` because there is no TTY behind a window, and `phoebe secret set` refuses
 * a TTY on stdin outright — the refusal is how it stops a value being typed
 * where a shell history can keep it.
 *
 * `--no-doctor` because the companion's doctor is its own verb run with its own
 * typed outcome (#527 §2). Folding one into the other would give a single run
 * two things to have decided, and the install tab has a button for the second.
 */
export async function setSecretInContainer(opts: {
  deployment: DeploymentCompose;
  key: string;
  value: string;
  tenant?: string;
  io: VerbIo;
  spawner?: StdinSpawner;
}): Promise<void> {
  const spawner = opts.spawner ?? defaultStdinSpawner;
  const argv = buildComposeArgv({
    composeFile: opts.deployment.composeFile,
    envFile: opts.deployment.envFile,
    args: [
      "exec",
      "-T",
      PHOEBE_SERVICE,
      "phoebe",
      "secret",
      "set",
      opts.key,
      ...(opts.tenant === undefined ? [] : ["--tenant", opts.tenant]),
      "--no-doctor",
    ],
  });

  const result = await spawner({
    file: "docker",
    args: argv,
    cwd: opts.deployment.containerDir,
    input: opts.value,
    onLine: (stream, line) => (stream === "stdout" ? opts.io.stdout(line) : opts.io.stderr(line)),
  });
  if (result.code !== 0) {
    throw new Error(
      `\`phoebe secret set ${opts.key}\` exited ${result.code} in the container. ` +
        `The store was not written; the lines above are what it said.`,
    );
  }
}

/** Where a host-side write lands, for an install rooted at `dir`. */
export function hostEnvPathFor(dir: string): string {
  return path.join(dir, DEPLOYMENT_ENV_REL_PATH);
}

/**
 * The `.env` text with `key` set to `value` — the existing line replaced where
 * it stands, or a new one appended.
 *
 * In place rather than rewritten, because this file is the operator's: its
 * comments, its order and the keys Compose interpolates from it all survive an
 * edit made from the window, exactly as they survive one made in an editor.
 *
 * A value with a newline in it is refused rather than mangled. A `.env` line is
 * one line by construction, and a writer that silently dropped the rest of a
 * token would leave a credential that looks set and does not work.
 */
export function withEnvValue(text: string, key: string, value: string): string {
  if (value.includes("\n")) {
    throw new Error(
      `${key} has a newline in it, and a \`.env\` line cannot hold one. ` +
        `Set this one by hand, or set it through a running container instead.`,
    );
  }
  const assignment = `${key}=${value}`;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => keyOf(line) === key);
  if (at === -1) {
    // A file that does not end in a newline would otherwise get the new key
    // welded onto its last line.
    const needsBreak = text.length > 0 && !text.endsWith("\n");
    return `${text}${needsBreak ? "\n" : ""}${assignment}\n`;
  }
  lines[at] = assignment;
  return lines.join("\n");
}

/** The key one `.env` line assigns, or null when the line assigns nothing. */
function keyOf(raw: string): string | null {
  const line = raw.trim();
  if (line.length === 0 || line.startsWith("#")) return null;
  const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
  const eq = withoutExport.indexOf("=");
  if (eq === -1) return null;
  const key = withoutExport.slice(0, eq).trim();
  return key.length > 0 ? key : null;
}

/** The seams the host writer reaches the disk through. All injectable. */
export type HostEnvDeps = {
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
  write?: (file: string, content: string) => void;
};

/**
 * Write one key into the install's deployment `.env`, and say what happened —
 * without saying what was written.
 */
export function setSecretInHostEnv(opts: {
  dir: string;
  key: string;
  value: string;
  io: VerbIo;
  deps?: HostEnvDeps;
}): string {
  const deps = opts.deps ?? {};
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((file: string) => readFileSync(file, "utf8"));
  const write =
    deps.write ??
    ((file: string, content: string) => writeFileSync(file, content, { mode: ENV_FILE_MODE }));

  const file = hostEnvPathFor(opts.dir);
  const before = exists(file) ? read(file) : "";
  const had = before.split("\n").some((line) => keyOf(line) === opts.key);
  write(file, withEnvValue(before, opts.key, opts.value));
  opts.io.stdout(`  ${had ? "replaced" : "added"} ${opts.key} in ${file}`);
  return file;
}

/**
 * Where the outcome says the value went.
 *
 * A container write has no path on this machine to name — the store is on a named
 * Docker volume — so it names the store instead, and `file` is null.
 */
export function secretTargetOf(writer: SecretWriter, file: string | null): string {
  return writer === "container" || file === null
    ? "the tenant secret store on this install's data volume"
    : file;
}

/** Build the outcome. One place, so neither arm can forget to say which it was. */
export function secretSetOutcome(opts: {
  key: string;
  tenant: string | null;
  writer: SecretWriter;
  target: string;
  at: string;
}): SecretSetOutcome {
  return { ...opts };
}

/** The real spawner: a pipe in, two pipes out, no shell. Exported for wsl.ts to wrap. */
export const defaultStdinSpawner: StdinSpawner = (spec) =>
  new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args as string[], {
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let outRest = "";
    let errRest = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      outRest = emitLines(outRest + String(chunk), (line) => spec.onLine("stdout", line));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      errRest = emitLines(errRest + String(chunk), (line) => spec.onLine("stderr", line));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (outRest.length > 0) spec.onLine("stdout", outRest);
      if (errRest.length > 0) spec.onLine("stderr", errRest);
      resolve({ code: code ?? 1 });
    });
    child.stdin?.end(spec.input);
  });

/** Emit every complete line in `buffered`; return the incomplete tail. */
function emitLines(buffered: string, emit: (line: string) => void): string {
  const pieces = buffered.split("\n");
  const rest = pieces.pop() ?? "";
  for (const piece of pieces) emit(piece.replace(/\r$/, ""));
  return rest;
}
