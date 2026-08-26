// `phoebe upgrade` — move the deployment forward deliberately.
//
// Two movable parts, decoupled by design: the **engine** (the git ref named in
// the deployment root's `phoebe.config.ts`, which `phoebe boot` materializes and
// runs) and the **npm bootstrapper** (`phoebe-agent`, the thin launcher). They
// share one number line — release tag `vX.Y.Z` ⇔ `phoebe-agent@X.Y.Z` — so one
// command can advance either or both.
//
// The engine half is a surgical rewrite of `engine.ref` in the root config. That
// is the sanctioned carve-out from #127's "Phoebe never writes the root config":
// an operator-initiated CLI verb is different in kind from the engine mutating
// its own instructions. The rewrite is strict-literal only — anything fancier
// than `ref: "<string>"` in a one-level `engine: { ... }` block is refused
// loudly with the exact edit printed, never guessed at. The write is in-place
// (same inode), because `compose.yml` bind-mounts the config as a single file
// and a rename-over would leave the container watching the old inode forever
// (docs/upgrading.md). Applying the new ref is the running reconcile loop's job;
// this command only moves the pin.
//
// The npm half runs `npm install -g` on a host; inside the container the
// launcher is baked into the image, so it prints the rebuild step instead of
// performing an install that the next image build would silently discard.
//
// `--check` is the narrow scriptable probe (stable JSON, exit 1 when behind) —
// deliberately separate from `phoebe doctor`, the broad health panel.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { readEngineSource, type ResolvedEngineSource } from "../bootstrap/engine-source.ts";
import {
  buildAuthenticatedRepoUrl,
  isPinnedSha,
  LS_REMOTE_TIMEOUT_MS,
  materializeGithubEngine,
  parseLsRemote,
  type GithubSource,
} from "../bootstrap/github-engine.ts";
import { isInsideContainer } from "./execution-gate.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import { loadUserConfig, resolveConfigPath } from "./load-config.ts";

/** Which halves of the install this invocation moves. */
export type UpgradeTarget = "engine" | "cli" | "both";

export type ParsedUpgradeArgs = {
  /** Explicit ref (tag/branch/SHA); undefined = latest release tag. */
  ref: string | undefined;
  /** Explicit target flag; undefined = prompt (TTY) or error (non-TTY). */
  target: UpgradeTarget | undefined;
  check: boolean;
  json: boolean;
  help: boolean;
  configPath: string | undefined;
};

/**
 * Parse argv left after the leading `upgrade` token. One optional positional
 * ref, mutually exclusive `--engine`/`--cli`/`--both`, read-only `--check`
 * (with `--json`), and `--config` (same contract as engine mode). Unknown flags
 * are rejected loudly, matching every other `phoebe` verb.
 */
export function parseUpgradeArgs(argv: readonly string[]): ParsedUpgradeArgs {
  let ref: string | undefined;
  let target: UpgradeTarget | undefined;
  let targetFlag: string | undefined;
  let check = false;
  let json = false;
  let help = false;
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--engine" || arg === "--cli" || arg === "--both") {
      if (targetFlag !== undefined) {
        throw new Error(
          `\`phoebe upgrade\` flags \`--engine\`, \`--cli\`, and \`--both\` are mutually ` +
            `exclusive (got both \`${targetFlag}\` and \`${arg}\`).`,
        );
      }
      targetFlag = arg;
      target = arg.slice(2) as UpgradeTarget;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`${arg} requires a path argument (e.g. --config phoebe.config.ts).`);
      }
      configPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(
        `Unknown flag \`${arg}\` for \`phoebe upgrade\`. See \`phoebe upgrade --help\`.`,
      );
    }
    if (ref !== undefined) {
      throw new Error(`\`phoebe upgrade\` takes at most one ref (got \`${ref}\` and \`${arg}\`).`);
    }
    ref = arg;
  }

  if (json && !check) {
    throw new Error("`--json` is only valid with `--check` (upgrade output is human-facing).");
  }
  if (check && (ref !== undefined || target !== undefined)) {
    throw new Error("`--check` is read-only and reports both halves — drop the ref/target flags.");
  }

  return { ref, target, check, json, help, configPath };
}

// ------------------------------------------------------------------ versions

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * A release tag's numeric version, or null for anything else — including
 * prereleases (`v0.4.0-rc.1`): bare `phoebe upgrade` never lands on one; they
 * stay reachable as an explicit ref.
 */
export function releaseVersion(tag: string): [number, number, number] | null {
  const m = RELEASE_TAG.exec(tag);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * The highest non-prerelease `vX.Y.Z` tag in `git ls-remote --tags` output.
 * Peeled rows (`refs/tags/v1^{}`) collapse onto their tag name; non-release
 * tags are ignored. Null when the remote has no release tag at all.
 */
export function latestReleaseTag(lsRemoteOutput: string): string | null {
  let best: string | null = null;
  let bestVersion: [number, number, number] | null = null;
  for (const { refName } of parseLsRemote(lsRemoteOutput)) {
    const name = refName.replace(/\^\{\}$/, "");
    if (!name.startsWith("refs/tags/")) continue;
    const tag = name.slice("refs/tags/".length);
    const version = releaseVersion(tag);
    if (version === null) continue;
    if (bestVersion === null || compareVersions(version, bestVersion) > 0) {
      best = tag;
      bestVersion = version;
    }
  }
  return best;
}

/**
 * What kind of ref the operator named. Only a release tag exists on both number
 * lines (git tag ⇔ npm version); a SHA or branch/other ref is engine-only, so
 * target selection narrows implicitly for those.
 */
export type RefKind = "release-tag" | "sha" | "other";

export function classifyRef(ref: string): RefKind {
  if (isPinnedSha(ref)) return "sha";
  return releaseVersion(ref) !== null ? "release-tag" : "other";
}

// ------------------------------------------------------------- config rewrite

export type RewriteResult =
  | { ok: true; content: string; previousRef: string | null }
  | { ok: false; reason: string };

/** The exact edit printed whenever the strict-literal rewrite refuses. */
export function engineEditInstruction(ref: string): string {
  return `engine: { source: "github", ref: ${JSON.stringify(ref)} },`;
}

/**
 * Strip an embedded token from a message before rendering it. `execFileSync`
 * failure messages include the full command line, and the authenticated
 * ls-remote URL carries `GH_TOKEN` — without this, a failed probe prints the
 * secret into terminal output and container logs.
 */
export function redactToken(message: string, token: string | undefined): string {
  if (token === undefined || token.length === 0) return message;
  return message.replaceAll(token, "***");
}

const ENGINE_BLOCK = /\bengine\s*:\s*\{([^{}]*)\}/g;
const REF_LITERAL = /(\bref\s*:\s*)(['"])((?:[^'"\\])*)\2/g;
const GITHUB_SOURCE = /(\bsource\s*:\s*(['"])github\2)/;

/**
 * Surgically rewrite (or insert) `engine.ref` in a root `phoebe.config.ts`.
 * Strict-literal only: the config is user-owned TypeScript, and a bad rewrite
 * bricks a deployment, so anything this cannot parse unambiguously — two
 * `engine` blocks, a computed `ref`, an `engine` reached via spread — is a
 * refusal carrying the exact one-line edit, not a guess. The scaffolded
 * templates satisfy the happy path; everything else is deliberately the
 * advisory fallback.
 *
 * Note: this function is intentionally NOT retrofitted onto the parser-based
 * config-edit substrate from src/config-handle.ts. `rewriteEngineRef` runs in
 * the OLD CLI before the engine.ref flip, while the substrate lives in the
 * TARGET checkout. The one process that would consume a parser-based rewrite is
 * by definition the one that may predate it — they cannot share code at runtime
 * despite sharing a repo. See docs/migrations.md for the full rationale.
 */
export function rewriteEngineRef(content: string, newRef: string): RewriteResult {
  const blocks = [...content.matchAll(ENGINE_BLOCK)];

  if (blocks.length > 1) {
    return { ok: false, reason: "found more than one `engine: { ... }` block" };
  }

  if (blocks.length === 1) {
    const block = blocks[0]!;
    const inner = block[1]!;
    // The inner group ends one character before the block's closing `}` —
    // splice by index rather than string replace, so a ref or config containing
    // `$`-sequences can never corrupt the rewrite.
    const innerStart = block.index! + block[0].length - 1 - inner.length;
    const splice = (rewrittenInner: string): string =>
      content.slice(0, innerStart) + rewrittenInner + content.slice(innerStart + inner.length);

    if (/\bsource\s*:\s*(['"])local\1/.test(inner)) {
      return {
        ok: false,
        reason:
          '`engine.source` is "local" — the engine runs from a mount, so there is no ref to pin',
      };
    }
    const refMentions = inner.match(/\bref\s*:/g)?.length ?? 0;
    const refLiterals = [...inner.matchAll(REF_LITERAL)];
    if (refMentions !== refLiterals.length || refLiterals.length > 1) {
      return { ok: false, reason: "`engine.ref` is not a plain string literal" };
    }
    if (refLiterals.length === 1) {
      const previousRef = refLiterals[0]![3]!;
      const rewrittenInner = inner.replace(
        REF_LITERAL,
        (_m, p1: string, q: string) => `${p1}${q}${newRef}${q}`,
      );
      return { ok: true, content: splice(rewrittenInner), previousRef };
    }
    // `{ source: "github" }` with no ref (default `main`): insert one after the
    // literal source so the block stays in the scaffolded shape.
    if (!GITHUB_SOURCE.test(inner)) {
      return { ok: false, reason: '`engine.source` is not a plain `"github"` literal' };
    }
    const rewrittenInner = inner.replace(
      GITHUB_SOURCE,
      (m) => `${m}, ref: ${JSON.stringify(newRef)}`,
    );
    return { ok: true, content: splice(rewrittenInner), previousRef: null };
  }

  // No engine block at all — the config runs the default (`main`). Insert a
  // whole block, but only into the one unambiguous shape: a single top-level
  // object literal closed by a column-0 `};` (the scaffolded form).
  if (/\bengine\b/.test(content)) {
    return { ok: false, reason: "`engine` is present but not a plain `engine: { ... }` block" };
  }
  const closings = content.match(/^\};/gm)?.length ?? 0;
  if (closings !== 1) {
    return { ok: false, reason: "could not find a single top-level config object to insert into" };
  }
  const inserted = content.replace(
    /^\};/m,
    () => `  engine: { source: "github", ref: ${JSON.stringify(newRef)} },\n};`,
  );
  return { ok: true, content: inserted, previousRef: null };
}

// ------------------------------------------------------------------ npm half

/** Runs `npm` with the given argv and returns stdout. Injectable for tests. */
export type NpmRunner = (args: readonly string[], opts?: { timeout?: number }) => string;

export const defaultNpm: NpmRunner = (args, opts) =>
  execFileSync("npm", args as string[], {
    encoding: "utf8",
    timeout: opts?.timeout ?? 60_000,
  }) as unknown as string;

/**
 * The globally-installed `phoebe-agent` version, or null when npm does not know
 * of one (an `npx` run, a repo checkout, a container). Null is advisory, never
 * fatal — the engine half does not depend on how the launcher got here.
 */
export function installedCliVersion(npm: NpmRunner = defaultNpm): string | null {
  try {
    const out = npm(["ls", "-g", "--depth=0", "--json", "phoebe-agent"]);
    const parsed = JSON.parse(out) as {
      dependencies?: Record<string, { version?: string }>;
    };
    return parsed.dependencies?.["phoebe-agent"]?.version ?? null;
  } catch {
    return null;
  }
}

/** The registry's latest `phoebe-agent` version, or null when unreachable. */
export function latestCliVersion(npm: NpmRunner = defaultNpm): string | null {
  try {
    const version = npm(["view", "phoebe-agent", "version"]).trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

// -------------------------------------------- container/Dockerfile launcher pin

const ARG_PHOEBE_VERSION_RE = /^ARG[ \t]+PHOEBE_AGENT_VERSION=(\d+\.\d+\.\d+)[ \t]*$/m;
const ARG_PHOEBE_VERSION_GLOBAL_RE = /^ARG[ \t]+PHOEBE_AGENT_VERSION=(\d+\.\d+\.\d+)[ \t]*$/gm;

export type DockerfilePin = { kind: "pinned"; version: string } | { kind: "unpinned" };

/**
 * Read the PHOEBE_AGENT_VERSION ARG pin from a Dockerfile's content.
 * Returns "pinned" with the version string when the machine-editable seam
 * (added by migration m003) is present; "unpinned" when it is absent — the
 * build pulls whatever npm publishes and there is nothing to move.
 */
export function readDockerfilePin(content: string): DockerfilePin {
  const m = ARG_PHOEBE_VERSION_RE.exec(content);
  return m !== null ? { kind: "pinned", version: m[1]! } : { kind: "unpinned" };
}

/**
 * Rewrite ARG PHOEBE_AGENT_VERSION=<old> to ARG PHOEBE_AGENT_VERSION=<new>.
 * Strict-literal only — refuses when more than one match exists.
 */
export function rewriteDockerfilePin(
  content: string,
  newVersion: string,
): { ok: true; content: string; previousVersion: string } | { ok: false; reason: string } {
  const matches = [...content.matchAll(ARG_PHOEBE_VERSION_GLOBAL_RE)];
  if (matches.length === 0) {
    return { ok: false, reason: "ARG PHOEBE_AGENT_VERSION not found" };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "multiple ARG PHOEBE_AGENT_VERSION lines — cannot rewrite unambiguously",
    };
  }
  const previousVersion = matches[0]![1]!;
  const newContent = content.replace(
    ARG_PHOEBE_VERSION_RE,
    `ARG PHOEBE_AGENT_VERSION=${newVersion}`,
  );
  return { ok: true, content: newContent, previousVersion };
}

/** The exact one-line edit to make in container/Dockerfile when the rewrite is refused. */
export function dockerfileEditInstruction(newVersion: string): string {
  return `ARG PHOEBE_AGENT_VERSION=${newVersion}`;
}

// ---------------------------------------------------------------- check mode

export type UpgradeCheckReport = {
  engine: {
    source: "github" | "local";
    /** The configured ref (defaults applied); null for a local mount. */
    ref: string | null;
    /** Highest release tag on the engine repo; null when unreachable. */
    latest: string | null;
    /** True when the ref is a branch/other ref that already tracks a tip. */
    tracking: boolean;
    /** Behind the latest release; null when it cannot be determined. */
    behind: boolean | null;
  };
  cli: {
    installed: string | null;
    latest: string | null;
    behind: boolean | null;
    /** Present when `installed` reflects the container/Dockerfile ARG pin rather than npm ls -g. */
    source?: "dockerfile";
  };
  /** False when either half is known to be behind. */
  ok: boolean;
};

/** Fold the two halves into the `--check` verdict. Pure, for tests. */
export function buildCheckReport(fields: {
  source: ResolvedEngineSource;
  latestTag: string | null;
  installedCli: string | null;
  latestCli: string | null;
  /** Pin read from container/Dockerfile; null when no container/ present (host deployment). */
  dockerfilePin?: DockerfilePin | null;
}): UpgradeCheckReport {
  const { source, latestTag } = fields;
  let engine: UpgradeCheckReport["engine"];
  if (source.source === "local") {
    engine = { source: "local", ref: null, latest: latestTag, tracking: false, behind: null };
  } else {
    const refVersion = releaseVersion(source.ref);
    const tracking = refVersion === null && !isPinnedSha(source.ref);
    const latestVersion = latestTag !== null ? releaseVersion(latestTag) : null;
    const behind =
      refVersion !== null && latestVersion !== null
        ? compareVersions(refVersion, latestVersion) < 0
        : null;
    engine = { source: "github", ref: source.ref, latest: latestTag, tracking, behind };
  }

  // Determine the effective CLI version: the Dockerfile pin when the deployment
  // is container-based (the npm-global version does not run there), or the
  // npm-global version for host deployments.
  let cliInstalled: string | null;
  let cliSource: "dockerfile" | undefined;
  if (fields.dockerfilePin?.kind === "pinned") {
    cliInstalled = fields.dockerfilePin.version;
    cliSource = "dockerfile";
  } else if (fields.dockerfilePin?.kind === "unpinned") {
    cliInstalled = null;
    cliSource = "dockerfile";
  } else {
    cliInstalled = fields.installedCli;
    cliSource = undefined;
  }

  // Ordering, not string inequality: an installed CLI *newer* than the
  // registry's latest (a prerelease install, a dist-tag rollback) is not
  // "behind". Non-X.Y.Z versions fall back to inequality.
  let cliBehind: boolean | null = null;
  if (cliInstalled !== null && fields.latestCli !== null) {
    const installedVersion = releaseVersion(`v${cliInstalled}`);
    const latestVersion = releaseVersion(`v${fields.latestCli}`);
    cliBehind =
      installedVersion !== null && latestVersion !== null
        ? compareVersions(installedVersion, latestVersion) < 0
        : cliInstalled !== fields.latestCli;
  }

  const cli: UpgradeCheckReport["cli"] = {
    installed: cliInstalled,
    latest: fields.latestCli,
    behind: cliBehind,
    ...(cliSource !== undefined ? { source: cliSource } : {}),
  };
  return {
    engine,
    cli,
    ok: engine.behind !== true && cliBehind !== true,
  };
}

// -------------------------------------------------------------------- runner

/**
 * Numbered TTY picker for a bare `phoebe upgrade`. Enter defaults to engine —
 * the common case. Non-TTY callers never reach this: a script silently choosing
 * a target is exactly the ambiguity the prompt exists to avoid, so they must
 * pass a flag.
 */
export async function promptUpgradeTarget(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<UpgradeTarget> {
  const rl = createInterface({ input, output });
  try {
    const answer = (
      await rl.question("Upgrade what?  [1] engine (default)  [2] cli  [3] both  > ")
    ).trim();
    if (answer === "" || answer === "1") return "engine";
    if (answer === "2") return "cli";
    if (answer === "3") return "both";
    throw new Error(`Unrecognised choice "${answer}" — expected 1, 2, or 3.`);
  } finally {
    rl.close();
  }
}

const UPGRADE_HELP_TEXT = `phoebe upgrade — advance the pinned engine ref and/or the npm CLI

Usage:
  phoebe upgrade                    Prompt for a target, move it to the latest release tag
  phoebe upgrade v0.4.0             Move to an explicit release tag
  phoebe upgrade <branch|sha>       Pin the engine to a branch or commit (engine-only)
  phoebe upgrade --check [--json]   Report current vs latest; exit 1 when behind

Targets (mutually exclusive; without one, a TTY prompts and a script must choose):
  --engine    Rewrite engine.ref in the deployment root's phoebe.config.ts.
              The running \`phoebe boot\` reconciles onto it within one poll
              interval — no restart. Refuses (and prints the exact edit) when
              the config's engine field is anything but a plain string literal.
  --cli       npm install -g phoebe-agent@<version> on a host. Inside the
              container the launcher is baked into the image, so this prints
              the image-rebuild step instead.
  --both      Both halves at the same release version.

Options:
  --config, -c <path>   Path to the root phoebe.config.ts (default: ./phoebe.config.ts)
  --help, -h            Show this message

Rollback is the same command with the previous ref (printed on every upgrade).
Pinned refs never auto-roll-back — pinning means pinning (docs/upgrading.md).
`;

type UpgradeIo = {
  git?: GitRunner;
  npm?: NpmRunner;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Materialize the target engine checkout, probe for `src/migrations/index.ts`,
   * and spawn `phoebe migrate` from that checkout if the index exists. Returns the
   * migrate exit code, or null when the index is absent (no-op). Injectable for
   * tests; the default calls materializeGithubEngine then spawnSync.
   */
  runMigrations?: (opts: {
    source: GithubSource;
    configPath: string;
    token: string | undefined;
  }) => number | null;
  /** Read container/Dockerfile; returns null when the deployment has no container/. */
  readDockerfile?: () => string | null;
  /** Write container/Dockerfile after a pin rewrite. */
  writeDockerfile?: (content: string) => void;
  /** Whether this process is running inside the Phoebe container. Injectable for tests. */
  isInContainer?: () => boolean;
};

/**
 * Base directory for engine checkouts — mirrors the knob `phoebe boot` and
 * `bin.mjs` use, so upgrade shares the same persistent clone and the materialize
 * step is a cheap fetch into an existing repo on subsequent runs.
 */
function defaultEngineBaseDir(): string {
  return process.env["PHOEBE_ENGINE_DIR"] ?? join(tmpdir(), "phoebe-agent");
}

/**
 * Materialize the target engine checkout, probe for `src/migrations/index.ts`,
 * and spawn that checkout's own `phoebe migrate --config <configPath>` when the
 * index is present. Inherited stdio lets the operator see the migration report
 * verbatim; upgrade parses nothing. Returns the exit code, or null (skipped —
 * no migrations index in this checkout).
 */
function defaultRunMigrations(opts: {
  source: GithubSource;
  configPath: string;
  token: string | undefined;
}): number | null {
  const { entry } = materializeGithubEngine(opts.source, {
    baseDir: defaultEngineBaseDir(),
    token: opts.token,
  });
  const migrationsIndex = join(dirname(entry), "migrations", "index.ts");
  if (!existsSync(migrationsIndex)) return null;
  const result = spawnSync(process.execPath, [entry, "migrate", "--config", opts.configPath], {
    stdio: "inherit",
  });
  return result.status;
}

function lsRemoteLatestTag(
  source: { repo: string },
  token: string | undefined,
  git: GitRunner,
): string | null {
  try {
    const url = buildAuthenticatedRepoUrl(source.repo, token);
    return latestReleaseTag(git(["ls-remote", "--tags", url], { timeout: LS_REMOTE_TIMEOUT_MS }));
  } catch {
    return null;
  }
}

/** `phoebe upgrade` entry — parses, prompts if needed, runs the chosen halves. */
export async function runUpgradeCli(argv: readonly string[]): Promise<void> {
  const parsed = parseUpgradeArgs(argv);

  // Compute the Dockerfile path from the config path (or default) without calling
  // resolveConfigPath yet — it throws for absent configs, but `phoebe upgrade --cli`
  // on a host with no config.ts must still work. We just check existence ourselves.
  const configFilename = parsed.configPath ?? "phoebe.config.ts";
  const deploymentRoot = dirname(
    isAbsolute(configFilename) ? configFilename : join(process.cwd(), configFilename),
  );
  const dockerfilePath = join(deploymentRoot, "container", "Dockerfile");

  const io: Required<UpgradeIo> = {
    git: defaultGit,
    npm: defaultNpm,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    runMigrations: defaultRunMigrations,
    readDockerfile: () =>
      existsSync(dockerfilePath) ? readFileSync(dockerfilePath, "utf8") : null,
    writeDockerfile: (content) => writeFileSync(dockerfilePath, content, "utf8"),
    isInContainer: isInsideContainer,
  };
  if (parsed.help) {
    process.stdout.write(UPGRADE_HELP_TEXT);
    return;
  }

  const token = process.env["GH_TOKEN"];

  // The root config is loaded lazily: only `--check` and the engine half need
  // it. A host that carries nothing but the npm launcher must still be able to
  // run `phoebe upgrade --cli`.
  let cached: { configPath: string; source: ResolvedEngineSource } | undefined;
  const engineConfig = async (): Promise<{ configPath: string; source: ResolvedEngineSource }> => {
    if (cached === undefined) {
      const configPath = resolveConfigPath(parsed.configPath, process.cwd());
      const source = readEngineSource(
        (await loadUserConfig(configPath)) as unknown as Record<string, unknown>,
      );
      cached = { configPath, source };
    }
    return cached;
  };

  if (parsed.check) {
    const { source } = await engineConfig();
    const dockerfileContent = io.readDockerfile();
    const dockerfilePin = dockerfileContent !== null ? readDockerfilePin(dockerfileContent) : null;
    const report = buildCheckReport({
      source,
      latestTag: source.source === "github" ? lsRemoteLatestTag(source, token, io.git) : null,
      installedCli: installedCliVersion(io.npm),
      latestCli: latestCliVersion(io.npm),
      dockerfilePin,
    });
    if (parsed.json) {
      io.stdout(JSON.stringify(report));
    } else {
      io.stdout(formatCheckReport(report));
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  // Resolve the target half(s). An explicit non-release ref narrows to
  // engine-only — the npm package has no version for a branch or SHA.
  const refKind = parsed.ref !== undefined ? classifyRef(parsed.ref) : "release-tag";
  let target = parsed.target;
  if (parsed.ref !== undefined && refKind !== "release-tag") {
    if (target === "cli" || target === "both") {
      throw new Error(
        `Only the engine can run \`${parsed.ref}\` — the npm CLI has no ${refKind} versions. ` +
          `Drop \`--${target}\` or name a release tag (vX.Y.Z).`,
      );
    }
    target = "engine";
  }
  if (target === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      target = await promptUpgradeTarget();
    } else {
      throw new Error(
        "No target given and no TTY to ask on — pass --engine, --cli, or --both " +
          "(scripts must choose explicitly).",
      );
    }
  }

  // Both halves share one resolved release version so "--both" cannot straddle.
  // A cli-only bare upgrade takes npm's latest instead — no config needed.
  let releaseTag: string | null = null;
  if (parsed.ref !== undefined && refKind === "release-tag") {
    releaseTag = parsed.ref;
  } else if (parsed.ref === undefined && (target === "engine" || target === "both")) {
    const { source } = await engineConfig();
    if (source.source === "github") releaseTag = lsRemoteLatestTag(source, token, io.git);
  }

  let engineMoved = true;
  if (target === "engine" || target === "both") {
    const { configPath, source } = await engineConfig();
    engineMoved = upgradeEngineHalf({
      configPath,
      source,
      ref: parsed.ref ?? releaseTag,
      refKind,
      token,
      io,
    });
  }
  if (target === "cli" || target === "both") {
    if (!engineMoved) {
      // The whole point of `--both` is landing both halves on one version; a
      // refused engine rewrite must not leave the deployment straddling two.
      io.stderr("cli: skipped — the engine half was refused, so the CLI stays where it is.");
      return;
    }
    upgradeCliHalf({ releaseTag, io });
  }
}

function formatCheckReport(report: UpgradeCheckReport): string {
  const lines: string[] = [];
  const { engine, cli } = report;
  if (engine.source === "local") {
    lines.push("engine: local mount — nothing to pin.");
  } else if (engine.tracking) {
    lines.push(
      `engine: tracking \`${engine.ref}\` (auto-upgrades on push)` +
        (engine.latest !== null ? `; latest release is ${engine.latest}` : ""),
    );
  } else {
    const latest = engine.latest ?? "unknown (remote unreachable)";
    const verdict = engine.behind === true ? "BEHIND" : engine.behind === false ? "current" : "?";
    lines.push(`engine: pinned ${engine.ref} — latest ${latest} (${verdict})`);
  }
  if (cli.source === "dockerfile") {
    if (cli.installed !== null) {
      const cliLatest = cli.latest ?? "unknown (registry unreachable)";
      const cliVerdict = cli.behind === true ? "BEHIND" : cli.behind === false ? "current" : "?";
      lines.push(
        `cli:    ${cli.installed} (container/Dockerfile) — latest ${cliLatest} (${cliVerdict})`,
      );
    } else {
      lines.push("cli:    container/Dockerfile — no PHOEBE_AGENT_VERSION pin (build pulls latest)");
    }
  } else {
    const cliInstalled = cli.installed ?? "not npm-installed globally";
    const cliLatest = cli.latest ?? "unknown (registry unreachable)";
    const cliVerdict = cli.behind === true ? "BEHIND" : cli.behind === false ? "current" : "?";
    lines.push(`cli:    ${cliInstalled} — latest ${cliLatest} (${cliVerdict})`);
  }
  return lines.join("\n");
}

export function upgradeEngineHalf(opts: {
  configPath: string;
  source: ResolvedEngineSource;
  ref: string | null;
  refKind: RefKind;
  token: string | undefined;
  io: Required<UpgradeIo>;
}): boolean {
  const { configPath, source, io } = opts;
  if (source.source === "local") {
    throw new Error(
      'engine.source is "local" — the engine runs from a mount; there is no ref to upgrade. ' +
        "Update the mounted checkout instead.",
    );
  }
  if (opts.ref === null) {
    throw new Error(
      `Could not determine the latest release tag of ${source.repo} — is the remote reachable ` +
        `(GH_TOKEN for a private repo)? Name a ref explicitly: phoebe upgrade v0.4.0`,
    );
  }
  const ref = opts.ref;

  if (ref === source.ref) {
    io.stdout(`engine: already at ${ref} — nothing to do.`);
    return true;
  }

  // Validate-then-commit: a typo'd tag or branch must fail here, before a
  // working deployment's pin is touched. A full SHA cannot be seen by
  // ls-remote unless it is a tip, so it is taken on trust — the fetch-by-name
  // path handles reachable SHAs and a bad one fails visibly at materialize.
  if (opts.refKind !== "sha") {
    const url = buildAuthenticatedRepoUrl(source.repo, opts.token);
    let rows;
    try {
      rows = parseLsRemote(io.git(["ls-remote", url, ref], { timeout: LS_REMOTE_TIMEOUT_MS }));
    } catch (error) {
      throw new Error(
        `Could not reach ${source.repo} to validate \`${ref}\`: ` +
          redactToken(error instanceof Error ? error.message : String(error), opts.token),
      );
    }
    if (rows.length === 0) {
      throw new Error(
        `\`${ref}\` does not exist on ${source.repo} — nothing was changed. ` +
          `(Branches and tags are validated before the pin moves.)`,
      );
    }
  } else {
    io.stderr(
      `engine: ${ref} is a commit SHA — existence cannot be pre-validated; ` +
        `a bad SHA will fail at the next engine materialize.`,
    );
  }

  // Materialize the target engine ref and run its own migrations before the pin
  // moves. The target's CLI is spawned with inherited stdio so the operator sees
  // its report verbatim; upgrade parses nothing. A nonzero exit aborts the flip —
  // a broken upgrade must not land. A target with no src/migrations/index.ts
  // skips the step (null return) and proceeds. Per-child failures are reflected in
  // migrate's exit code, not ours: they exit 0 and allow the flip.
  const migrateExitCode = io.runMigrations({
    // The target ref, not the config's current pin: the whole point is running
    // the *incoming* checkout's migrate so the facility self-upgrades.
    source: { ...(source as GithubSource), ref },
    configPath,
    token: opts.token,
  });
  if (migrateExitCode !== null && migrateExitCode !== 0) {
    io.stderr(
      `engine: the target engine's migrations failed (exit ${String(migrateExitCode)}) ` +
        `— leaving engine.ref unchanged.`,
    );
    process.exitCode = 1;
    return false;
  }

  const content = readFileSync(configPath, "utf8");
  const result = rewriteEngineRef(content, ref);
  if (!result.ok) {
    io.stderr(
      `engine: refusing to rewrite ${configPath} — ${result.reason}.\n` +
        `Apply the edit yourself (edit in place — an atomic save breaks the bind-mount watch):\n` +
        `  ${engineEditInstruction(ref)}`,
    );
    process.exitCode = 1;
    return false;
  }
  // In-place write on the same inode, deliberately not write-temp-then-rename:
  // the container bind-mounts this file, and a new inode is invisible to it.
  writeFileSync(configPath, result.content);

  const previous = result.previousRef ?? "main (default)";
  io.stdout(`engine: ${previous} → ${ref} written to ${configPath}.`);
  io.stdout(
    "A running `phoebe boot` drains and relaunches onto it within one reconcile " +
      "interval (default 60s) — no restart needed.",
  );
  const rollback = result.previousRef !== null ? result.previousRef : "main";
  io.stdout(
    `To roll back: phoebe upgrade ${rollback} --engine` +
      (opts.refKind !== "other"
        ? "  (pinned refs never auto-roll-back — pinning means pinning)"
        : ""),
  );
  return true;
}

export function upgradeCliHalf(opts: { releaseTag: string | null; io: Required<UpgradeIo> }): void {
  const { io } = opts;

  if (io.isInContainer()) {
    io.stdout(
      "cli: the launcher is baked into the image. Run this from the deployment directory on the host:\n" +
        "  phoebe upgrade --cli  # rewrites container/Dockerfile\n" +
        "  phoebe start --build  # rebuilds the image with the new pin",
    );
    return;
  }

  // Release tag vX.Y.Z ⇔ phoebe-agent@X.Y.Z — one number line.
  const registryLatest = latestCliVersion(io.npm);
  const desired = opts.releaseTag !== null ? opts.releaseTag.slice(1) : registryLatest;
  if (desired === null) {
    throw new Error(
      "cli: could not determine the latest phoebe-agent version from the npm registry — " +
        "is it reachable? Name a release explicitly: phoebe upgrade v0.4.0 --cli",
    );
  }

  const dockerfileContent = io.readDockerfile();
  if (dockerfileContent !== null) {
    // Container deployment — the launcher pin lives in container/Dockerfile, not in
    // the global npm prefix. Rewrite the ARG line and print the rebuild step.
    const pin = readDockerfilePin(dockerfileContent);
    if (pin.kind === "unpinned") {
      io.stdout(
        "cli: container/Dockerfile has no PHOEBE_AGENT_VERSION pin — " +
          "the build pulls the latest published version. Nothing to move.",
      );
      return;
    }
    if (registryLatest !== null && desired !== registryLatest && opts.releaseTag !== null) {
      io.stderr(
        `cli: note — npm's latest is ${registryLatest}, but ${desired} was requested; ` +
          `pinning ${desired} in container/Dockerfile.`,
      );
    }
    if (pin.version === desired) {
      io.stdout(`cli: container/Dockerfile already pins ${desired} — nothing to do.`);
      return;
    }
    const result = rewriteDockerfilePin(dockerfileContent, desired);
    if (!result.ok) {
      io.stderr(
        `cli: refusing to rewrite container/Dockerfile — ${result.reason}.\n` +
          `Apply the edit yourself:\n  ${dockerfileEditInstruction(desired)}`,
      );
      process.exitCode = 1;
      return;
    }
    io.writeDockerfile(result.content);
    io.stdout(`cli: container/Dockerfile ${result.previousVersion} → ${desired}.`);
    io.stdout("Rebuild the image to make the new launcher active:");
    io.stdout("  phoebe start --build");
    io.stdout(`To roll back: phoebe upgrade v${result.previousVersion} --cli`);
    return;
  }

  // Host deployment — no container/Dockerfile. Install into the global npm prefix.
  if (registryLatest !== null && desired !== registryLatest && opts.releaseTag !== null) {
    io.stderr(
      `cli: note — npm's latest is ${registryLatest}, but ${desired} was requested; installing ${desired}.`,
    );
  }
  const installed = installedCliVersion(io.npm);
  if (installed === null) {
    io.stderr(
      "cli: phoebe-agent is not npm-installed globally here (npx run, or a repo checkout?) — " +
        `installing phoebe-agent@${desired} globally now.`,
    );
  } else if (installed === desired) {
    io.stdout(`cli: already at ${installed} — nothing to do.`);
    return;
  }
  io.npm(["install", "-g", `phoebe-agent@${desired}`], { timeout: 300_000 });
  io.stdout(`cli: ${installed ?? "(none)"} → ${desired} installed globally.`);
}
