// The edit boundary for PR proposals (#936, spec #924): which paths an
// observer PR may change, decided by code after the edit run, never by the
// agent. Pure, so every rule is tested without git.

import { createHash } from "node:crypto";
import { SKILL_LOCK_FILE, SKILLS_DIR, parseSkillLock } from "../../src/skill-lock.ts";

/** The governing config, at the path a tenant's repository would track it. */
export const GOVERNING_CONFIG = "phoebe.config.ts";

/** The prompt overrides directory, likewise. */
export const PROMPTS_DIR = "prompts";

/** The allowlist as a person reads it, for prompts and issue bodies. */
export const ALLOWLIST_TEXT = [
  "`AGENTS.md`",
  `\`${PROMPTS_DIR}/**\``,
  `\`${GOVERNING_CONFIG}\``,
  `skill directories under \`${SKILLS_DIR}/\` that \`${SKILL_LOCK_FILE}\` does not list`,
];

/**
 * The skill names the lock vendors, read from its text at the base commit.
 * No lock means no vendored skills. A lock that does not parse is `null`:
 * nothing under the skills directory can be told apart, so none of it is
 * allowed.
 */
export function vendoredSkills(lockText: string | null): ReadonlySet<string> | null {
  if (lockText === null) return new Set();
  try {
    return new Set(Object.keys(parseSkillLock(lockText).skills));
  } catch {
    return null;
  }
}

/** A path a factory fix edits: the prompt overrides or the governing config. */
export function isFactoryPath(path: string): boolean {
  return path === GOVERNING_CONFIG || path.startsWith(`${PROMPTS_DIR}/`);
}

/**
 * Whether an observer PR may change `path`, relative to the repository root.
 * A skill counts only as a file inside its own directory, so replacing a
 * skill directory, or the skills directory, with a file is refused.
 */
export function isAllowedPath(path: string, vendored: ReadonlySet<string> | null): boolean {
  if (path === "AGENTS.md" || isFactoryPath(path)) return true;
  const prefix = `${SKILLS_DIR}/`;
  if (!path.startsWith(prefix) || vendored === null) return false;
  const rest = path.slice(prefix.length).split("/");
  if (rest.length < 2) return false;
  const name = rest[0]!;
  return name !== "" && !vendored.has(name);
}

/** What the edit run's diff turns the proposal into. */
export type EditVerdict =
  | { action: "pr"; changed: string[] }
  | { action: "issue"; reason: "empty" }
  | { action: "issue"; reason: "outside"; changed: string[]; outside: string[] }
  | { action: "issue"; reason: "untracked"; changed: string[]; untracked: string[] };

/**
 * Decide from the changed paths. Any path outside the allowlist sends the
 * whole proposal to an issue. So does a factory path the tenant's repository
 * does not track at the base commit, since a PR there would change a file
 * nothing reads; that issue carries the diff for a person to apply where the
 * governing file lives.
 */
export function checkEdit(
  changed: readonly string[],
  opts: { vendored: ReadonlySet<string> | null; tracked: (path: string) => boolean },
): EditVerdict {
  const paths = [...new Set(changed)].sort();
  if (paths.length === 0) return { action: "issue", reason: "empty" };
  const outside = paths.filter((path) => !isAllowedPath(path, opts.vendored));
  if (outside.length > 0) return { action: "issue", reason: "outside", changed: paths, outside };
  const untracked = paths.filter((path) => isFactoryPath(path) && !opts.tracked(path));
  if (untracked.length > 0) {
    return { action: "issue", reason: "untracked", changed: paths, untracked };
  }
  return { action: "pr", changed: paths };
}

/**
 * The branch a proposal's PR sits on: under the branch prefix, so the
 * janitors treat it as an ordinary Phoebe PR, and unique per key so two
 * findings in one run never share one.
 */
export function proposalBranch(branchPrefix: string, key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 7);
  return `${branchPrefix}observer/${slug === "" ? "finding" : slug}-${hash}`;
}
