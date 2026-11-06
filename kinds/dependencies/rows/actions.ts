// The GitHub Actions row. Every `uses: owner/repo@ref` in a workflow under
// `.github/workflows/` is a dependency of that workflow file. deps.dev has no
// Actions system, so newer versions and their dates come from the action
// repository's GitHub releases, read with `gh api`: the engine's `gh` is
// already authenticated, where an anonymous client gets 60 requests an hour.
// The repository's tags map each tag to its commit. That turns a SHA pin into
// the tag it stands for, gives a SHA-pinned target its SHA, and gives OSV the
// commit it needs, since OSV matches Actions advisories by commit and not by
// version (docs/research/renovate-extraction-spike.md, #751).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareCandidates, type Advisory, type Candidate, type UpdateType } from "../candidate.ts";
import type { OsvClient, OsvQuery } from "../registry/osv.ts";
import { compareVersions } from "../registry/versions.ts";
import { isRecord, parseJsonLines } from "./npm-family.ts";
import type { CandidateRow, Manifest, RowDeps, RowResult } from "./row.ts";

/** Renovate's manager for workflow files. */
export const ACTIONS_MANAGER = "github-actions";

/** Where GitHub reads workflows from; it does not look in subdirectories. */
export const WORKFLOWS_DIR = ".github/workflows";

/** Repositories read at once, each with two `gh api` children in flight. */
export const REPO_CONCURRENCY = 4;

export type ActionsRowDeps = RowDeps & { osv: OsvClient };

/** One remote `uses:` reference in a workflow. */
export type Pin = {
  /** `owner/repo`. A path inside the repository (`github/codeql-action/init`) is dropped. */
  package: string;
  ref: string;
  /** `sha` for a 40-hex commit, `tag` for anything else. */
  style: "sha" | "tag";
  /** The first word of a trailing comment, `v4.2.2` in `@<sha> # v4.2.2`. */
  comment: string | null;
};

const USES_RE = /^\s*(?:-\s+)?uses\s*:\s*(["']?)([^\s"'#]+)\1(?:\s+#\s*(\S*).*)?$/;
const REMOTE_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/[^@]*)?@([^@]+)$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Every remote action and reusable workflow a workflow file uses, in file
 * order. A local `./path` and a `docker://` image are not GitHub repositories,
 * so they are skipped.
 */
export function parseWorkflow(text: string): Pin[] {
  const pins: Pin[] = [];
  for (const line of text.split("\n")) {
    const uses = USES_RE.exec(line);
    if (uses === null) continue;
    const remote = REMOTE_RE.exec(uses[2]!);
    if (remote === null) continue;
    const ref = remote[2]!;
    pins.push({
      package: remote[1]!,
      ref,
      style: SHA_RE.test(ref) ? "sha" : "tag",
      comment: uses[3] || null,
    });
  }
  return pins;
}

/** A tag read as a version: `v4`, `v4.2`, `4.2.2`, `v5.0.0-beta.1`. */
type Tag = { name: string; prefix: string; parts: number[]; pre: boolean };

const TAG_RE = /^(v?)(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/;

function readTag(name: string): Tag | null {
  const match = TAG_RE.exec(name);
  if (match === null) return null;
  return {
    name,
    prefix: match[1]!,
    parts: match
      .slice(2, 5)
      .filter((part) => part !== undefined)
      .map(Number),
    pre: match[5] !== undefined,
  };
}

/** What one action repository publishes. */
type Repo = {
  /** Published releases whose tag reads as a version, pre-releases and drafts left out. */
  releases: { tag: Tag; publishedAt: string | null }[];
  /** Every tag's commit, by tag name. */
  commits: Map<string, string>;
};

async function ghLines(
  deps: RowDeps,
  checkout: string,
  endpoint: string,
  jq: string,
): Promise<RowResult<unknown[]>> {
  const output = await deps.run("gh", ["api", "--paginate", endpoint, "--jq", jq], checkout);
  if (output.ok && output.code !== 0) {
    return { ok: false, problem: `gh api ${endpoint} exited ${output.code}` };
  }
  return parseJsonLines(output);
}

async function fetchRepo(deps: RowDeps, checkout: string, pkg: string): Promise<RowResult<Repo>> {
  const [releases, tags] = await Promise.all([
    ghLines(
      deps,
      checkout,
      `repos/${pkg}/releases?per_page=100`,
      ".[] | {tag_name, published_at, draft, prerelease}",
    ),
    ghLines(deps, checkout, `repos/${pkg}/tags?per_page=100`, ".[] | {name, sha: .commit.sha}"),
  ]);
  if (!releases.ok) return releases;
  if (!tags.ok) return tags;
  const repo: Repo = { releases: [], commits: new Map() };
  for (const release of releases.value) {
    if (!isRecord(release) || release["draft"] === true || release["prerelease"] === true) continue;
    const tag = typeof release["tag_name"] === "string" ? readTag(release["tag_name"]) : null;
    if (tag === null || tag.pre) continue;
    const published = release["published_at"];
    repo.releases.push({ tag, publishedAt: typeof published === "string" ? published : null });
  }
  for (const tag of tags.value) {
    if (isRecord(tag) && typeof tag["name"] === "string" && typeof tag["sha"] === "string") {
      repo.commits.set(tag["name"], tag["sha"].toLowerCase());
    }
  }
  return { ok: true, value: repo };
}

/**
 * The tag a pin stands for. A tag pin is its own tag when it reads as a
 * version. A SHA pin is the tag its comment names when that tag points at the
 * commit, else the most precise tag that does, a release before a pre-release
 * and the highest of a tie.
 */
function currentTag(pin: Pin, repo: Repo): Tag | null {
  if (pin.style === "tag") return readTag(pin.ref);
  const sha = pin.ref.toLowerCase();
  const at = [...repo.commits]
    .filter(([, commit]) => commit === sha)
    .map(([name]) => readTag(name))
    .filter((tag): tag is Tag => tag !== null);
  return (
    at.find((tag) => tag.name === pin.comment) ??
    at.sort(
      (a, b) =>
        b.parts.length - a.parts.length ||
        Number(a.pre) - Number(b.pre) ||
        compareVersions("semver", b.name, a.name),
    )[0] ??
    null
  );
}

type Target = { tag: Tag; publishedAt: string | null };

function earliest(a: string | null, b: string | null): string | null {
  return a === null ? b : b === null || a < b ? a : b;
}

/**
 * The newest release in the current major and the newest past it, each cut
 * to the precision of the current tag, so a floating `v4` moves to `v5` and
 * never to `v4.2.2`. A target must be a tag the repository has, or there is
 * nothing to pin to, and must point somewhere other than `commit`, the one
 * the pin runs today: tags moved onto one commit are no update. Its date is
 * the first release in the line it names: a floating `v5` became available
 * when `v5.0.0` shipped.
 */
function targets(current: Tag, commit: string | undefined, repo: Repo): Target[] {
  const precision = current.parts.length;
  const lines = new Map<string, Target>();
  for (const release of repo.releases) {
    if (release.tag.parts.length < precision) continue;
    const parts = release.tag.parts.slice(0, precision);
    const name = `${release.tag.prefix}${parts.join(".")}`;
    const at = repo.commits.get(name);
    if (at === undefined || at === commit) continue;
    if (compareVersions("semver", name, current.name) <= 0) continue;
    lines.set(name, {
      tag: { name, prefix: release.tag.prefix, parts, pre: false },
      publishedAt: earliest(lines.get(name)?.publishedAt ?? null, release.publishedAt),
    });
  }
  const newest = (inMajor: boolean): Target | undefined =>
    [...lines.values()]
      .filter((t) => (t.tag.parts[0] === current.parts[0]) === inMajor)
      .sort((a, b) => compareVersions("semver", b.tag.name, a.tag.name))[0];
  return [newest(true), newest(false)].filter((t): t is Target => t !== undefined);
}

function updateType(current: Tag, target: Tag): UpdateType {
  if (target.parts[0] !== current.parts[0]) return "major";
  return current.parts.length >= 2 && target.parts[1] !== current.parts[1] ? "minor" : "patch";
}

/** The workflow files under `.github/workflows/`, as checkout-relative paths. */
function workflowFiles(checkout: string): string[] {
  try {
    return readdirSync(join(checkout, WORKFLOWS_DIR), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => `${WORKFLOWS_DIR}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

type Proposal = { candidate: Candidate; commit: string | undefined };

export function actionsRow(deps: ActionsRowDeps): CandidateRow {
  const name = ACTIONS_MANAGER;

  async function candidates(manifest: Manifest): Promise<RowResult<Candidate[]>> {
    const pinned: { workspace: string; pin: Pin }[] = [];
    const seen = new Set<string>();
    for (const workspace of manifest.workspaces) {
      let text: string;
      try {
        text = readFileSync(join(manifest.checkout, workspace), "utf8");
      } catch (error) {
        return {
          ok: false,
          problem: `could not read ${workspace}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      for (const pin of parseWorkflow(text)) {
        const key = JSON.stringify([workspace, pin.package.toLowerCase(), pin.ref]);
        if (seen.has(key)) continue;
        seen.add(key);
        pinned.push({ workspace, pin });
      }
    }

    const packages = [...new Set(pinned.map(({ pin }) => pin.package.toLowerCase()))].sort();
    const fetched: RowResult<Repo>[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < packages.length) {
        const index = next++;
        fetched[index] = await fetchRepo(deps, manifest.checkout, packages[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REPO_CONCURRENCY, packages.length) }, worker));
    const repos = new Map<string, Repo>();
    packages.forEach((pkg, index) => {
      const repo = fetched[index]!;
      if (repo.ok) repos.set(pkg, repo.value);
      else
        deps.log(
          `${name} row: could not read ${pkg} from GitHub (${repo.problem}); its pins are not proposed.`,
        );
    });

    const notVersions: string[] = [];
    const untagged: string[] = [];
    const proposals: Proposal[] = [];
    for (const { workspace, pin } of pinned) {
      const repo = repos.get(pin.package.toLowerCase());
      if (repo === undefined) continue;
      const current = currentTag(pin, repo);
      if (current === null) {
        (pin.style === "sha" ? untagged : notVersions).push(`${pin.package}@${pin.ref}`);
        continue;
      }
      const sha = pin.style === "sha";
      const commit = sha ? pin.ref.toLowerCase() : repo.commits.get(pin.ref);
      for (const target of targets(current, commit, repo)) {
        const candidate: Candidate = {
          manager: ACTIONS_MANAGER,
          package: pin.package,
          current: sha ? `${pin.ref} # ${current.name}` : pin.ref,
          target: sha
            ? `${repo.commits.get(target.tag.name)} # ${target.tag.name}`
            : target.tag.name,
          updateType: updateType(current, target.tag),
          // Renovate files a workflow step under depType `action`, which its
          // source reads as prod, so the two sources agree on the same bump.
          depType: "prod",
          workspace,
          advisories: [],
          peers: [],
          repositoryUrl: `https://github.com/${pin.package}`,
        };
        if (target.publishedAt !== null) candidate.publishedAt = target.publishedAt;
        proposals.push({ candidate, commit });
      }
    }
    if (notVersions.length > 0) {
      deps.log(
        `${name} row: ${notVersions.length} pin(s) on a ref that is not a version, not proposed: ${notVersions.join(", ")}.`,
      );
    }
    if (untagged.length > 0) {
      deps.log(
        `${name} row: ${untagged.length} commit pin(s) no version tag points at, not proposed: ${untagged.join(", ")}.`,
      );
    }

    const advisories = await advisoriesByCommit(proposals);
    for (const proposal of proposals) {
      if (proposal.commit === undefined) continue;
      proposal.candidate.advisories =
        advisories.get(commitKey(proposal.candidate.package, proposal.commit)) ?? [];
    }
    return { ok: true, value: proposals.map((p) => p.candidate).sort(compareCandidates) };
  }

  /**
   * OSV's advisories for each pinned commit. A failed lookup is a log line
   * and the candidates go out without advisories; the next pass asks again.
   */
  async function advisoriesByCommit(proposals: Proposal[]): Promise<Map<string, Advisory[]>> {
    const queries = new Map<string, OsvQuery>();
    for (const { candidate, commit } of proposals) {
      if (commit === undefined) continue;
      queries.set(commitKey(candidate.package, commit), {
        ecosystem: "GitHub Actions",
        name: candidate.package,
        commit,
      });
    }
    const byCommit = new Map<string, Advisory[]>();
    if (queries.size === 0) return byCommit;
    const asked = [...queries];
    const found = await deps.osv.advisories(asked.map(([, query]) => query));
    if (!found.ok) {
      deps.log(`${name} row: OSV failed (${found.error}); candidates carry no advisories.`);
      return byCommit;
    }
    asked.forEach(([key], index) => byCommit.set(key, found.value[index]!));
    return byCommit;
  }

  return {
    name,
    manager: ACTIONS_MANAGER,

    async detect(checkout) {
      const workspaces = workflowFiles(checkout);
      if (workspaces.length === 0) return [];
      const version = await deps.run("gh", ["--version"], checkout);
      if (!version.ok) {
        deps.log(
          `${name} row: ${version.problem}; ${workspaces.length} workflow(s) left to the agent fallback.`,
        );
        return [];
      }
      return [{ checkout, path: WORKFLOWS_DIR, workspaces }];
    },

    candidates,
  };
}

function commitKey(pkg: string, commit: string): string {
  return `${pkg.toLowerCase()}\u0000${commit}`;
}
