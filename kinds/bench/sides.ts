// The two sides a bench compares (#989): what the default branch runs the
// `issues` kind with, and what the PR head would. Each side is a prompt, read
// as text through git, and the `issues` provider, model and effort, read by
// evaluating that commit's governing config in a child process.
//
// Paths. The deployment reads its config and prompts from its runtime root,
// and the repository may track them somewhere else (the dogfood's live in
// `.phoebe/`, its prompts one level up). A runtime-root path is looked for in
// the repository under two prefixes, in order: where the runtime root sits in
// its own git work tree, when it is in one, and the repository root, the
// layout the observer's PR proposals assume. A side whose tree tracks none of
// them has nothing a PR could change, so it takes the deployment's own.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { buildAgentEnv } from "../../src/agent-env.ts";
import { isGitHubCredentialKey } from "../../src/bench-run.ts";
import type { PhoebeConfig, ProviderName } from "../../src/config-schema.ts";
import type { GitRunner } from "../../src/git-model.ts";
import { loadPromptTemplate } from "../../src/prompt.ts";
import { SKILLS_DIR } from "../../src/skill-lock.ts";

/** The child script that evaluates one config. */
export const READ_SETTINGS_SCRIPT = join(import.meta.dirname, "read-settings.ts");

/** How long one config evaluation may take before it is killed. */
const SETTINGS_TIMEOUT_MS = 120_000;

/** What the child hands back: the `issues` settings a tree's config resolves to. */
export type TreeSettings = {
  provider: string;
  model: string;
  /** `null` passes no effort flag. */
  effort: string | null;
  /** Absolute, inside the tree unless the config named an absolute path. */
  promptFile: string;
};

export type IssuesSettings = Omit<TreeSettings, "promptFile">;

/** One side of the comparison. */
export type Side = {
  sha: string;
  /** `null` when the tree tracks no governing config: the deployment's own settings stand. */
  settings: IssuesSettings | null;
  prompt: {
    text: string;
    /** Where it was read: `<path>` in the tree, or the deployment's file. */
    path: string;
    fromTree: boolean;
  };
};

/**
 * The env the config evaluation runs under: the agent's allowlist with every
 * GitHub credential and every provider key taken out, and a HOME of its own so
 * no on-disk login is in reach. Evaluating a config needs neither.
 */
export function settingsChildEnv(opts: {
  parentEnv: NodeJS.ProcessEnv;
  providerEnv: PhoebeConfig["providerEnv"];
  home: string;
}): Record<string, string> {
  const parentEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(opts.parentEnv)) {
    if (!isGitHubCredentialKey(key)) parentEnv[key] = value;
  }
  const providers = Object.keys(opts.providerEnv) as ProviderName[];
  const env = buildAgentEnv({
    parentEnv,
    provider: providers[0]!,
    providerEnv: opts.providerEnv,
  });
  for (const key of Object.values(opts.providerEnv)) delete env[key];
  for (const key of Object.keys(env)) if (isGitHubCredentialKey(key)) delete env[key];
  return {
    ...env,
    HOME: opts.home,
    XDG_CONFIG_HOME: join(opts.home, ".config"),
    GH_CONFIG_DIR: join(opts.home, ".config", "gh"),
    GIT_CONFIG_GLOBAL: join(opts.home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Run the child once. A seam, so a test can see the env without spawning. */
export type RunSettingsChild = (opts: {
  script: string;
  configPath: string;
  cwd: string;
  env: Record<string, string>;
}) => { status: number | null; stdout: string; stderr: string };

export const defaultRunSettingsChild: RunSettingsChild = (opts) => {
  const result = spawnSync(process.execPath, ["--no-warnings", opts.script, opts.configPath], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    timeout: SETTINGS_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error === undefined ? (result.stderr ?? "") : String(result.error),
  };
};

/** Read the child's one line of JSON, refusing anything else. */
export function parseTreeSettings(text: string, where: string): TreeSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    throw new Error(`${where}: the settings read printed something other than JSON.`);
  }
  const value = raw as Record<string, unknown> | null;
  const field = (key: string): string => {
    const found = value?.[key];
    if (typeof found !== "string" || found === "") {
      throw new Error(`${where}: the settings read gave no \`${key}\`.`);
    }
    return found;
  };
  const provider = field("provider");
  const model = field("model");
  const promptFile = field("promptFile");
  const effort = value?.["effort"];
  if (effort !== null && typeof effort !== "string") {
    throw new Error(`${where}: the settings read gave an \`effort\` that is not a string.`);
  }
  return { provider, model, effort, promptFile };
}

/** Whether two sides' settings would run the agent differently. */
export function settingsDiffer(a: IssuesSettings | null, b: IssuesSettings | null): boolean {
  if (a === null || b === null) return false;
  return a.provider !== b.provider || a.model !== b.model || a.effort !== b.effort;
}

/**
 * The paths a PR changes that a bench does not measure: `AGENTS.md` at any
 * depth and anything under the skills directory. Trials read both from the
 * fixture's own tree at `baseSha`, so a change to them never reaches a trial.
 */
export function unmeasuredPaths(changed: readonly string[]): string[] {
  return changed.filter(
    (path) =>
      path === "AGENTS.md" ||
      path.endsWith("/AGENTS.md") ||
      path.startsWith(`${SKILLS_DIR}/`) ||
      path.startsWith(".claude/skills/"),
  );
}

/** A runtime-root-relative path under a repository prefix, or `null` when it leaves the repository. */
function underPrefix(prefix: string, path: string): string | null {
  if (isAbsolute(path)) return null;
  const joined = posix.normalize(posix.join(prefix, path.split(sep).join("/")));
  if (joined === ".." || joined.startsWith("../") || joined === ".") return null;
  return joined;
}

export function resolveSides(opts: {
  git: GitRunner;
  /** The hub clone: every commit both sides name is in it. */
  hub: string;
  runtimeRoot: string;
  /** The deployment's config file, relative to the runtime root. */
  configFile: string;
  /** The deployment's `issues` prompt, as its config names it. */
  promptFile: string;
  mainSha: string;
  prSha: string;
  /** Somewhere to export trees into; emptied of them before this returns. */
  scratch: string;
  env: NodeJS.ProcessEnv;
  providerEnv: PhoebeConfig["providerEnv"];
  runChild?: RunSettingsChild;
  log: (line: string) => void;
}): { main: Side; pr: Side } {
  const { git, hub } = opts;
  const runChild = opts.runChild ?? defaultRunSettingsChild;

  const tracked = (sha: string, path: string): boolean => {
    try {
      git(["cat-file", "-e", `${sha}:${path}`], { cwd: hub, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };
  const show = (sha: string, path: string): string =>
    git(["show", `${sha}:${path}`], { cwd: hub, stdio: "pipe" });

  let gitPrefix: string | null = null;
  try {
    gitPrefix = git(["rev-parse", "--show-prefix"], {
      cwd: opts.runtimeRoot,
      stdio: "pipe",
    }).trim();
  } catch {
    gitPrefix = null;
  }
  const prefixes = [...new Set([gitPrefix, ""].filter((p): p is string => p !== null))];

  /** The first repository path a runtime-root path has at `sha`, or `null`. */
  const repoPathAt = (sha: string, path: string): string | null => {
    for (const prefix of prefixes) {
      const candidate = underPrefix(prefix, path);
      if (candidate !== null && tracked(sha, candidate)) return candidate;
    }
    return null;
  };

  /** Export `sha`'s tree without a `.git` that leads back to the hub. */
  const exportTree = (sha: string, dir: string): void => {
    mkdirSync(dir, { recursive: true });
    const tar = `${dir}.tar`;
    try {
      git(["archive", "--format=tar", "-o", tar, sha], { cwd: hub, stdio: "pipe" });
      execFileSync("tar", ["-xf", tar, "-C", dir], { stdio: "pipe" });
    } finally {
      rmSync(tar, { force: true });
    }
  };

  const readSettings = (sha: string, label: string, configPath: string): TreeSettings => {
    const tree = join(opts.scratch, `tree-${label}`);
    const home = join(opts.scratch, `home-${label}`);
    mkdirSync(home, { recursive: true });
    exportTree(sha, tree);
    try {
      const result = runChild({
        script: READ_SETTINGS_SCRIPT,
        configPath: join(tree, configPath),
        cwd: join(tree, posix.dirname(configPath)),
        env: settingsChildEnv({ parentEnv: opts.env, providerEnv: opts.providerEnv, home }),
      });
      if (result.status !== 0) {
        const tail = result.stderr.trim().split("\n").slice(-5).join("\n");
        throw new Error(
          `could not read the \`issues\` settings from ${configPath} at ${sha.slice(0, 12)}` +
            `${result.status === null ? " (killed)" : ` (exit ${result.status})`}` +
            `${tail === "" ? "." : `:\n${tail}`}`,
        );
      }
      const settings = parseTreeSettings(result.stdout, `${configPath} at ${sha.slice(0, 12)}`);
      // The prompt path is reported as a path in the tree, so it can be read
      // through git; anything outside the tree is the deployment's own disk.
      const rel = relative(tree, settings.promptFile);
      return {
        ...settings,
        promptFile:
          rel === "" || rel.startsWith("..") || isAbsolute(rel)
            ? settings.promptFile
            : rel.split(sep).join("/"),
      };
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };

  const configPath =
    repoPathAt(opts.mainSha, opts.configFile) ?? repoPathAt(opts.prSha, opts.configFile);

  /** One side, before the fallbacks the other side supplies. */
  const sideAt = (
    sha: string,
    label: string,
  ): { settings: IssuesSettings | null; prompt: Side["prompt"] | null; outside: string | null } => {
    let settings: IssuesSettings | null = null;
    let promptPath: string | null = null;
    let outside: string | null = null;
    if (configPath !== null && tracked(sha, configPath)) {
      const read = readSettings(sha, label, configPath);
      settings = { provider: read.provider, model: read.model, effort: read.effort };
      if (isAbsolute(read.promptFile)) outside = read.promptFile;
      else promptPath = read.promptFile;
    } else {
      promptPath = repoPathAt(sha, opts.promptFile);
    }
    const prompt =
      promptPath !== null && tracked(sha, promptPath)
        ? { text: show(sha, promptPath), path: promptPath, fromTree: true }
        : null;
    return { settings, prompt, outside };
  };

  const main = sideAt(opts.mainSha, "main");
  const mainPrompt: Side["prompt"] = main.prompt ?? {
    text:
      main.outside !== null
        ? readFileSync(main.outside, "utf8")
        : loadPromptTemplate(opts.promptFile, opts.runtimeRoot),
    path: main.outside ?? opts.promptFile,
    fromTree: false,
  };
  const pr = sideAt(opts.prSha, "pr");
  if (pr.prompt === null && pr.outside !== null) {
    // A PR's config naming a file on the deployment's own disk is not read: the
    // label vouches for the PR's code, not for what it may point a trial at.
    opts.log(`the PR's config names a prompt outside its tree (${pr.outside}); main's is used.`);
  }
  return {
    main: { sha: opts.mainSha, settings: main.settings, prompt: mainPrompt },
    pr: {
      sha: opts.prSha,
      settings: pr.settings ?? main.settings,
      prompt: pr.prompt ?? mainPrompt,
    },
  };
}
