// The dependency-security kind end to end with fake sources and the GitHub
// stub: registration through the catalog path, the hourly window, each
// severity branch, and a tracking issue that becomes a routed one on the pass
// its fix appears.

import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PhoebeUserConfig } from "../../src/config-schema.ts";
import type { MentioningIssue, MentioningPr } from "../../src/github-client.ts";
import { stubGitHub, type GitHubStubOverrides } from "../../src/github-stub.ts";
import { selectPipeline } from "../../src/pipeline.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { createWorkKindRegistry } from "../../src/work-kinds/load-custom.ts";
import { validateWorkKindDefinition } from "../../src/work-kinds/validate.ts";
import type { Advisory, Candidate } from "../dependencies/candidate.ts";
import { parseMarker } from "../dependencies/fingerprint.ts";
import { readIssueRows } from "../dependencies/issue-body.ts";
import type { SourceName } from "../dependencies/sources/assemble.ts";
import type { SourceRun } from "../dependencies/sources/run.ts";
import dependencySecurityKind, { createDependencySecurityKind, SCAN_REF } from "./index.ts";
import { resolveDependencySecurityOptions } from "./options.ts";

function userConfig(kindBlock: Record<string, unknown>): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    pipelines: { deps: { kinds: { "dependency-security": kindBlock } } },
  };
}

const config = resolveConfig(userConfig({ path: "phoebe-agent/kinds/dependency-security" }));

function candidate(pkg: string, advisories: Advisory[], overrides: Partial<Candidate> = {}) {
  return {
    manager: "npm",
    package: pkg,
    current: "1.0.0",
    target: "1.0.0",
    updateType: "patch",
    depType: "prod",
    workspace: "package.json",
    advisories,
    peers: [],
    via: [],
    ...overrides,
  } satisfies Candidate;
}

type Clock = { now: Date };

function ctxFor(github: GitHubStubOverrides, clock: Clock, logged: string[] = []): WorkKindRunCtx {
  return {
    kind: "dependency-security",
    config,
    options: undefined,
    env: {},
    github: stubGitHub(github).forCycle() as unknown as WorkKindRunCtx["github"],
    origin: {
      fetch: () => {},
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
    workspace: { mode: "readonly", dir: "/tmp/checkout", scratch: "/tmp/scratch" },
    signal: new AbortController().signal,
    agent: {
      run: async () => {},
      prWorkflow: async () => {},
      issueWorkflow: async () => {},
      cleanMerge: () => "pushed",
    },
  };
}

/** Sources answering from a table; a name missing from it fails. */
function fakeSources(answers: Partial<Record<SourceName, Candidate[]>>, asked: string[][] = []) {
  return async (_ctx: WorkKindRunCtx, names: readonly SourceName[]): Promise<SourceRun[]> => {
    asked.push([...names]);
    return names.map((name) => ({
      name,
      timeoutMs: 1_000,
      run: async () => {
        const candidates = answers[name];
        return candidates === undefined
          ? { ok: false, problem: "not configured in this test" }
          : { ok: true, candidates };
      },
    }));
  };
}

function kindWith(
  block: Record<string, unknown>,
  answers: Partial<Record<SourceName, Candidate[]>>,
  asked?: string[][],
) {
  return createDependencySecurityKind(
    config,
    resolveDependencySecurityOptions(block, "kinds.dependency-security"),
    { createSources: fakeSources(answers, asked) },
  );
}

/** One comment on an issue; Phoebe's own unless it names another login. */
type Comment = { body: string; by?: string };

/** A GitHub that holds `issues`, `prs` and `comments` and records every write. */
function gitHub(
  issues: MentioningIssue[] = [],
  prs: MentioningPr[] = [],
  comments: Record<number, Comment[]> = {},
  /** Labels an issue gained since the listing, as a fresh read returns them. */
  fresh: Record<number, string[]> = {},
) {
  const writes: string[] = [];
  const bodies = new Map<number, string>();
  let next = 100;
  const overrides: GitHubStubOverrides = {
    listIssuesMentioning: () => issues,
    listPrsMentioning: () => prs,
    createIssue: (opts) => {
      const n = next++;
      bodies.set(n, opts.body);
      writes.push(`create #${n} ${opts.title}`);
      return n;
    },
    addIssueLabel: (n, label) => {
      writes.push(`label #${n} ${label}`);
    },
    updateIssueBody: (n, body) => {
      bodies.set(n, body);
      writes.push(`update #${n}`);
    },
    postUnitComment: (target) => {
      writes.push(`comment #${target.id}`);
    },
    closeIssue: (n, reason) => {
      writes.push(`close #${n} ${reason}`);
    },
    removeIssueLabel: (n, label) => {
      writes.push(`unlabel #${n} ${label}`);
    },
    resolveLogin: () => "phoebe-bot",
    issueLabels: (n) => fresh[n] ?? issues.find((issue) => issue.number === n)?.labels ?? [],
    issueTimeoutInputs: (n) => ({
      comments: (comments[n] ?? []).map((comment) => ({
        body: comment.body,
        createdAt: "2026-11-05T00:00:00Z",
        authorLogin: comment.by ?? "phoebe-bot",
      })),
      extraActivityAt: null,
      baseline: "body:aa",
    }),
  };
  return { overrides, writes, bodies };
}

describe("registration", () => {
  test("registers through the catalog path as a readonly scan kind keyed by nothing", async () => {
    const registry = await createWorkKindRegistry(selectPipeline(config, "deps"), "/nowhere");
    const definition = registry.get("dependency-security")?.definition;
    expect(definition?.name).toBe("dependency-security");
    expect(definition?.workspace).toBe("readonly");
    expect(definition?.unitKey).toBe("none");
    expect(definition?.unitLabel).toBeUndefined();
  });

  test("the definition validates, and a bad block fails at the factory naming the path", () => {
    expect(() =>
      validateWorkKindDefinition(
        dependencySecurityKind(config, undefined),
        "kinds.dependency-security",
      ),
    ).not.toThrow();
    expect(() => dependencySecurityKind(config, { ignore: ["lodash"] })).toThrow(
      "kinds.dependency-security: unknown option `ignore`",
    );
  });

  test("the routing label may never be the ready label", () => {
    expect(() => dependencySecurityKind(config, { label: config.readyLabel })).toThrow(
      "`label` must not be the ready label",
    );
  });
});

describe("the window", () => {
  test("hourly by default: due at boot, idle within the hour, due again after it", async () => {
    const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };
    const asked: string[][] = [];
    const kind = kindWith({}, { native: [] }, asked);
    const ctx = ctxFor(gitHub().overrides, clock);
    const first = kind.select(await kind.fetch(ctx), ctx);
    expect(first.unit?.ref).toBe(SCAN_REF);
    await kind.run(first.unit!, ctx);
    expect(asked).toEqual([["native", "agent"]]);

    clock.now = new Date("2026-11-06T00:59:00Z");
    expect(await kind.fetch(ctx)).toEqual({ due: null });
    clock.now = new Date("2026-11-06T01:00:00Z");
    expect((await kind.fetch(ctx)).due?.ref).toBe(SCAN_REF);
  });

  test("a scan where every source failed throws and still waits out the window", async () => {
    const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };
    const kind = kindWith({}, {});
    const ctx = ctxFor(gitHub().overrides, clock);
    await expect(kind.run({ ref: SCAN_REF, revision: "0" }, ctx)).rejects.toThrow(
      "every dependency source failed",
    );
    expect(await kind.fetch(ctx)).toEqual({ due: null });
  });
});

describe("run", () => {
  const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };
  const high = { id: "GHSA-high", severity: "high", fixedIn: "1.0.3" } as const;
  const unfixed = { id: "GHSA-none", severity: "critical", fixedIn: null } as const;
  const low = { id: "GHSA-low", severity: "low", fixedIn: "1.0.1" } as const;

  test("each severity branch: routed with a fix, tracking without, nothing under the threshold", async () => {
    const kind = kindWith(
      {},
      {
        native: [candidate("fixable", [high]), candidate("unfixable", [unfixed])],
        agent: [candidate("minor", [low]), candidate("fixable", [low], { target: "2.0.0" })],
      },
    );
    const { overrides, writes, bodies } = gitHub();
    const logged: string[] = [];
    await kind.run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock, logged));

    expect(writes).toEqual([
      "create #100 Security advisories in fixable (npm)",
      "label #100 dependencies",
      "label #100 security",
      "label #100 phoebe:dependencies",
      "create #101 Security advisories in unfixable (npm)",
      "label #101 dependencies",
      "label #101 security",
    ]);
    expect(writes.join("\n")).not.toContain(config.readyLabel);
    expect(bodies.get(100)).toContain("| 1.0.0 | 1.0.3 | direct |");
    expect(bodies.get(100)).not.toContain("GHSA-low");
    expect(bodies.get(101)).toMatch(/^Tracking/);
    expect(logged).toContain(
      "4 candidate(s): 0 bootstrapper pin(s) left to `phoebe upgrade`, 1 with every advisory under minSeverity " +
        "(prod high, dev critical), not filed here, 0 transitive with no fix released, not tracked; " +
        "1 issue(s) with a fix, 1 awaiting one.",
    );
  });

  describe("the open cap", () => {
    const critical = { id: "GHSA-crit", severity: "critical", fixedIn: "1.0.4" } as const;
    const highs = (count: number) =>
      Array.from({ length: count }, (_, i) => candidate(`pkg-${i}`, [high]));
    const created = (writes: string[]) =>
      writes.filter((w) => w.startsWith("create")).map((w) => w.replace(/^create #\d+ /, ""));
    const scan = async (block: Record<string, unknown>, native: Candidate[]) => {
      const { overrides, writes } = gitHub();
      const logged: string[] = [];
      await kindWith(block, { native }).run(
        { ref: SCAN_REF, revision: "0" },
        ctxFor(overrides, clock, logged),
      );
      return { created: created(writes), summary: logged.find((l) => l.startsWith("filing:")) };
    };

    test("five routed issues by default, the rest held for a later scan", async () => {
      const { created, summary } = await scan({}, highs(7));
      expect(created).toHaveLength(5);
      expect(summary).toContain("5 filed");
      expect(summary).toContain("2 held by the open cap");
    });

    test("a critical is filed past a full cap, and a high is not", async () => {
      const { created } = await scan({ prConcurrentLimit: 2 }, [
        ...highs(3),
        candidate("zlib", [critical]),
      ]);
      expect(created).toEqual([
        "Security advisories in zlib (npm)",
        "Security advisories in pkg-0 (npm)",
      ]);
    });

    test("a tracking issue is filed whatever the count and uses no slot", async () => {
      const { created } = await scan({ prConcurrentLimit: 1 }, [
        candidate("pkg-0", [high]),
        candidate("pkg-1", [high]),
        candidate("waiting", [unfixed]),
      ]);
      expect(created).toEqual([
        "Security advisories in pkg-0 (npm)",
        "Security advisories in waiting (npm)",
      ]);
    });

    test("`prConcurrentLimit: 0` files everything", async () => {
      const { created } = await scan({ prConcurrentLimit: 0 }, highs(7));
      expect(created).toHaveLength(7);
    });
  });

  test("a tracking issue is refreshed and routed on the pass its fix appears", async () => {
    const issues: MentioningIssue[] = [];
    const { overrides, writes, bodies } = gitHub(issues);
    const ctx = ctxFor(overrides, clock);

    // Pass one: no fix, so a tracking issue without the routing label.
    await kindWith({}, { native: [candidate("pkg", [unfixed])] }).run(
      { ref: SCAN_REF, revision: "0" },
      ctx,
    );
    expect(writes).toEqual([
      "create #100 Security advisories in pkg (npm)",
      "label #100 dependencies",
      "label #100 security",
    ]);
    issues.push({
      number: 100,
      title: "",
      body: bodies.get(100)!,
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: ["dependencies", "security"],
    });

    // Pass two: the same advisory, still unfixed, leaves the issue alone.
    writes.length = 0;
    await kindWith({}, { native: [candidate("pkg", [unfixed])] }).run(
      { ref: SCAN_REF, revision: "1" },
      ctx,
    );
    expect(writes).toEqual([]);

    // Pass three: a fix ships. Same key, new fingerprint: the body is
    // rewritten to propose it, and the issue gains the routing label.
    writes.length = 0;
    const fixed = { ...unfixed, fixedIn: "1.0.9" };
    await kindWith({}, { native: [candidate("pkg", [fixed])] }).run(
      { ref: SCAN_REF, revision: "2" },
      ctx,
    );
    expect(writes).toEqual(["update #100", "comment #100", "label #100 phoebe:dependencies"]);
    expect(bodies.get(100)).toContain("| 1.0.0 | 1.0.9 | direct |");
    expect(parseMarker(bodies.get(100)!)?.key).toBe(parseMarker(issues[0]!.body)?.key);
  });

  test("a routed issue whose label a person removed keeps it off", async () => {
    const first = gitHub();
    await kindWith({}, { native: [candidate("pkg", [high])] }).run(
      { ref: SCAN_REF, revision: "0" },
      ctxFor(first.overrides, clock),
    );
    const stripped: MentioningIssue = {
      number: 100,
      title: "",
      body: first.bodies.get(100)!,
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: ["dependencies", "security"],
    };
    const again = gitHub([stripped]);
    await kindWith({}, { native: [candidate("pkg", [high])] }).run(
      { ref: SCAN_REF, revision: "1" },
      ctxFor(again.overrides, clock),
    );
    expect(again.writes).toEqual([]);
  });

  test("a closed tracking issue vetoes its rows; a fix lifts the veto", async () => {
    const first = gitHub();
    await kindWith({}, { native: [candidate("pkg", [unfixed])] }).run(
      { ref: SCAN_REF, revision: "0" },
      ctxFor(first.overrides, clock),
    );
    const closed: MentioningIssue = {
      number: 100,
      title: "",
      body: first.bodies.get(100)!,
      state: "closed",
      stateReason: "not_planned",
      closedAt: null,
      labels: ["dependencies", "security"],
    };

    const again = gitHub([closed]);
    await kindWith({}, { native: [candidate("pkg", [unfixed])] }).run(
      { ref: SCAN_REF, revision: "1" },
      ctxFor(again.overrides, clock),
    );
    expect(again.writes).toEqual([]);

    const withFix = gitHub([closed]);
    await kindWith({}, { native: [candidate("pkg", [{ ...unfixed, fixedIn: "1.0.9" }])] }).run(
      { ref: SCAN_REF, revision: "2" },
      ctxFor(withFix.overrides, clock),
    );
    expect(withFix.writes[0]).toBe("create #100 Security advisories in pkg (npm)");
  });

  test("the cap counts security bundles alone, not what dependency-updates has open", async () => {
    const open: MentioningIssue[] = Array.from({ length: 8 }, (_, i) => ({
      number: i + 1,
      title: "",
      body: `<!-- phoebe-dependencies bundle=npm%3Aprod%3Apackage%3Ax${i} fingerprint=abc -->`,
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: ["dependencies", "phoebe:dependencies"],
    }));
    const { overrides, writes } = gitHub(open);
    await kindWith({}, { native: [candidate("pkg", [high])] }).run(
      { ref: SCAN_REF, revision: "0" },
      ctxFor(overrides, clock),
    );
    expect(writes[0]).toBe("create #100 Security advisories in pkg (npm)");
  });

  describe("the transitive bundle", () => {
    const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };
    const fix = (pkg: string) =>
      ({ id: `GHSA-${pkg}`, severity: "high", fixedIn: "1.0.1" }) as const;
    const transitive = (pkg: string, overrides: Partial<Candidate> = {}) =>
      candidate(pkg, [fix(pkg)], { via: ["expo"], ...overrides });
    const KEY = "npm:security-transitive";

    /** Run one scan and hand back what it wrote and the body of each issue it filed. */
    async function scan(
      native: Candidate[],
      held: {
        issues?: MentioningIssue[];
        prs?: MentioningPr[];
        comments?: Record<number, Comment[]>;
      } = {},
    ) {
      const { overrides, writes, bodies } = gitHub(held.issues, held.prs, held.comments);
      const logged: string[] = [];
      await kindWith({}, { native }).run(
        { ref: SCAN_REF, revision: "0" },
        ctxFor(overrides, clock, logged),
      );
      return { writes, bodies, logged };
    }

    /** The bundle's issue as a first scan of `native` files it, numbered and labelled. */
    async function filedBundle(
      number: number,
      native: Candidate[],
      overrides: Partial<MentioningIssue> = {},
    ): Promise<MentioningIssue> {
      const { bodies } = await scan(native);
      return {
        number,
        title: "",
        body: bodies.get(100)!,
        state: "open",
        stateReason: null,
        closedAt: null,
        labels: ["dependencies", "security", "phoebe:dependencies"],
        ...overrides,
      };
    }

    const dropped = (...entries: string[]) => ["## Dropped", "", ...entries].join("\n");

    test("three transitive fixes file one issue, and a direct fix its own", async () => {
      const { writes, bodies } = await scan([
        transitive("tar"),
        transitive("undici"),
        transitive("ws"),
        candidate("zod", [fix("zod")]),
      ]);
      expect(writes.filter((w) => w.startsWith("create"))).toEqual([
        "create #100 Security fixes for transitive packages (npm)",
        "create #101 Security advisories in zod (npm)",
      ]);
      expect(bodies.get(100)).toContain(
        "| `tar` | `package.json` | prod | 1.0.0 | 1.0.1 | `expo` |",
      );
    });

    test("closing the bundle's issue unmerged vetoes each row it listed, per workspace", async () => {
      const both = [transitive("tar"), transitive("tar", { workspace: "web/package.json" })];
      const closed = await filedBundle(40, both, { state: "closed", stateReason: "not_planned" });
      const third = transitive("tar", { workspace: "api/package.json" });

      const again = await scan(both, { issues: [closed] });
      expect(again.writes).toEqual([]);

      const { bodies } = await scan([...both, third], { issues: [closed] });
      expect(bodies.get(100)).toContain("| `tar` | `api/package.json` | prod |");
      expect(bodies.get(100)).not.toContain("web/package.json");
    });

    test("a full body: rows a closed issue vetoes take no room, so the rows after them file (#901)", async () => {
      const all = Array.from({ length: 900 }, (_, i) =>
        transitive(`pkg-${String(i).padStart(3, "0")}`),
      );
      const first = await scan(all);
      const fitted = readIssueRows(first.bodies.get(100)!).map((row) => row.package);
      expect(fitted.length).toBeGreaterThan(0);
      expect(fitted.length).toBeLessThan(450);
      expect(first.logged).toContain(
        `${KEY}: the issue body is full; ${900 - fitted.length} package version(s) left out ` +
          "until earlier rows merge.",
      );

      const closed = await filedBundle(40, all, { state: "closed", stateReason: "not_planned" });
      const { writes, bodies, logged } = await scan(all, { issues: [closed] });
      expect(writes.filter((w) => w.startsWith("create"))).toEqual([
        "create #100 Security fixes for transitive packages (npm)",
      ]);
      const next = readIssueRows(bodies.get(100)!).map((row) => row.package);
      expect(next[0]).toBe(all[fitted.length]!.package);
      expect(next.some((name) => fitted.includes(name))).toBe(false);
      expect(logged).toContain(
        `${KEY}: the issue body is full; ${900 - fitted.length - next.length} package ` +
          "version(s) left out until earlier rows merge.",
      );
    });

    test("a row a merged PR dropped is filed on its own, and the bundle goes on without it", async () => {
      const native = [transitive("tar"), transitive("ws")];
      const issue = await filedBundle(40, native, { state: "closed", stateReason: "completed" });
      const pr: MentioningPr = {
        number: 41,
        title: "",
        state: "closed",
        merged: true,
        closedAt: "2026-11-01T00:00:00Z",
        body: [
          "Closes #40",
          "",
          dropped("- `tar@1.0.1` (needs override): `expo` 54.0.1 asks for `tar` `^0.9.0`"),
          "",
          issue.body.trim().split("\n").at(-1)!,
        ].join("\n"),
      };
      // The PR merged the ws fix, so only tar is still vulnerable.
      const { writes, bodies } = await scan([transitive("tar")], { issues: [issue], prs: [pr] });
      expect(writes.filter((w) => w.startsWith("create"))).toEqual([
        "create #100 Security advisories in tar (npm)",
      ]);
      expect(bodies.get(100)).toMatch(/^Dropped from #41; it needs more than a lockfile fix\./);
    });

    test("an untagged drop moves a row too; one that was only too new stays in the bundle", async () => {
      const native = [transitive("tar"), transitive("ws"), transitive("undici")];
      const issue = await filedBundle(40, native, { state: "closed", stateReason: "completed" });
      const marker = issue.body.trim().split("\n").at(-1)!;
      const pr: MentioningPr = {
        number: 41,
        title: "",
        state: "closed",
        merged: true,
        closedAt: "2026-11-01T00:00:00Z",
        body: [
          "Closes #40",
          "",
          dropped("- `tar@1.0.1`: the gate failed", "- `ws@1.0.1` (too new): published today"),
          "",
          marker,
        ].join("\n"),
      };
      const { writes, bodies } = await scan([transitive("tar"), transitive("ws")], {
        issues: [issue],
        prs: [pr],
      });
      expect(writes.filter((w) => w.startsWith("create"))).toEqual([
        "create #100 Security fixes for transitive packages (npm)",
        "create #101 Security advisories in tar (npm)",
      ]);
      expect(bodies.get(100)).toContain("| `ws` |");
      expect(bodies.get(100)).not.toContain("| `tar` |");
    });

    test("a Dropped section in someone else's comment moves nothing", async () => {
      const native = [transitive("tar"), transitive("ws")];
      const issue = await filedBundle(40, native);
      const comments = {
        40: [{ body: dropped("- `tar@1.0.1` (needs override): pasted"), by: "passer-by" }],
      };
      const { writes } = await scan(native, { issues: [issue], comments });
      expect(writes).toEqual([]);
    });

    test("when every row dropped, the bundle's issue is closed and each row is filed on its own", async () => {
      const native = [transitive("tar"), transitive("ws")];
      const parked = await filedBundle(40, native, {
        labels: ["dependencies", "security", "phoebe:dependencies", "phoebe:blocked"],
      });
      const comments = {
        40: [
          {
            body:
              dropped(
                "- `tar@1.0.1` (needs override): `expo` asks for `^0.9.0`",
                "- `ws@1.0.1` (needs override): `expo` asks for `^0.9.0`",
              ) + "\n\n<!-- phoebe-blocked -->",
          },
        ],
      };
      const { writes, bodies, logged } = await scan(native, { issues: [parked], comments });
      expect(writes).toEqual([
        "update #40",
        "comment #40",
        "close #40 completed",
        "create #100 Security advisories in tar (npm)",
        "label #100 dependencies",
        "label #100 security",
        "label #100 phoebe:dependencies",
        "create #101 Security advisories in ws (npm)",
        "label #101 dependencies",
        "label #101 security",
        "label #101 phoebe:dependencies",
      ]);
      expect(bodies.get(40)).toContain(
        "Every row this issue listed needed more than a lockfile fix",
      );
      expect(bodies.get(40)).not.toContain("| `tar` |");
      expect(logged).toContain(`${KEY}: closed #40; every row has moved to an issue of its own.`);

      // A later scan still reads the closed issue's drops, so the rows stay out
      // of the bundle, and a new transitive fix files a fresh bundle past it.
      const closed: MentioningIssue = {
        ...parked,
        body: bodies.get(40)!,
        state: "closed",
        stateReason: "completed",
      };
      const later = await scan([...native, transitive("undici")], { issues: [closed], comments });
      expect(later.writes.filter((w) => w.startsWith("create"))).toEqual([
        "create #100 Security fixes for transitive packages (npm)",
        "create #101 Security advisories in tar (npm)",
        "create #102 Security advisories in ws (npm)",
      ]);
      expect(later.bodies.get(100)).not.toContain("| `tar` |");
    });

    test("a bundle whose body was emptied but never closed is closed by the next scan", async () => {
      const native = [transitive("tar"), transitive("ws")];
      const parked = await filedBundle(40, native, {
        labels: ["dependencies", "security", "phoebe:dependencies", "phoebe:blocked"],
      });
      const comments = {
        40: [
          {
            body:
              dropped("- `tar@1.0.1` (needs override): no", "- `ws@1.0.1` (needs override): no") +
              "\n\n<!-- phoebe-blocked -->",
          },
        ],
      };
      const first = await scan(native, { issues: [parked], comments });
      // The body was saved, then the comment or the close failed.
      const halfClosed: MentioningIssue = { ...parked, body: first.bodies.get(40)! };
      const { writes, logged } = await scan(native, { issues: [halfClosed], comments });
      expect(writes.filter((w) => w.includes("#40"))).toEqual(["close #40 completed"]);
      expect(logged).toContain(
        `${KEY}: closed #40; an earlier scan emptied it and could not close it.`,
      );
    });

    test("a parked bundle with a row left is refreshed and released, not closed", async () => {
      const native = [transitive("tar"), transitive("ws")];
      const parked = await filedBundle(40, native, {
        labels: ["dependencies", "security", "phoebe:dependencies", "phoebe:blocked"],
      });
      const comments = {
        40: [
          {
            body:
              dropped("- `tar@1.0.1` (needs override): no", "- `ws@1.0.1` (needs override): no") +
              "\n\n<!-- phoebe-blocked -->",
          },
        ],
      };
      const { writes, bodies } = await scan([...native, transitive("undici")], {
        issues: [parked],
        comments,
      });
      // Released first: a refresh that lands on a ticket still parked is never retried (#900).
      expect(writes).toEqual(["unlabel #40 phoebe:blocked", "update #40", "comment #40"]);
      expect(bodies.get(40)).toContain("| `undici` |");
      expect(bodies.get(40)).not.toContain("| `tar` |");
    });

    test("a parked bundle whose label cannot be lifted is not refreshed until it can be", async () => {
      const native = [transitive("tar"), transitive("ws")];
      const parked = await filedBundle(40, native, {
        labels: ["dependencies", "security", "phoebe:dependencies", "phoebe:blocked"],
      });
      const comments = {
        40: [
          {
            body:
              dropped("- `tar@1.0.1` (needs override): no", "- `ws@1.0.1` (needs override): no") +
              "\n\n<!-- phoebe-blocked -->",
          },
        ],
      };
      const now = [...native, transitive("undici")];
      const { overrides, writes } = gitHub([parked], [], comments);
      const logged: string[] = [];
      const failing = {
        ...overrides,
        removeIssueLabel: () => {
          throw new Error("gh exploded");
        },
      };
      await kindWith({}, { native: now }).run(
        { ref: SCAN_REF, revision: "0" },
        ctxFor(failing, clock, logged),
      );
      expect(writes).toEqual([]);
      expect(logged).toContain(
        `${KEY}: could not lift phoebe:blocked from #40, so its refresh waits for the next scan. ` +
          "gh exploded",
      );

      // Nothing was saved, so the next scan decides the same refresh and carries it out.
      const again = await scan(now, { issues: [parked], comments });
      expect(again.writes).toEqual(["unlabel #40 phoebe:blocked", "update #40", "comment #40"]);
    });

    test('`transitive: "individual"` ignores what a bundle dropped and files per package', async () => {
      const { overrides, writes } = gitHub();
      await kindWith(
        { transitive: "individual" },
        { native: [transitive("tar"), transitive("ws")] },
      ).run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock));
      expect(writes.filter((w) => w.startsWith("create"))).toEqual([
        "create #100 Security advisories in tar (npm)",
        "create #101 Security advisories in ws (npm)",
      ]);
    });
  });
});

// Filing reaches an open issue only through the bundle planned under its key,
// so one whose key is no longer planned kept its label and its slot (#898),
// and a bundle left open across a switch to `transitive: "individual"` held
// its rows for good (#899).
describe("an open routed issue the plan no longer covers", () => {
  const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };
  const unit = { ref: SCAN_REF, revision: "0" };
  const fix = (pkg: string) => ({ id: `GHSA-${pkg}`, severity: "high", fixedIn: "1.0.1" }) as const;
  const direct = (pkg: string, overrides: Partial<Candidate> = {}) =>
    candidate(pkg, [fix(pkg)], overrides);
  const transitive = (pkg: string, overrides: Partial<Candidate> = {}) =>
    candidate(pkg, [fix(pkg)], { via: ["expo"], ...overrides });
  const routed = ["dependencies", "security", "phoebe:dependencies"];
  // Every source finishes, which is what lets a scan read "not reported" as "nothing left".
  const whole = { sources: ["native"] };
  type Held = {
    issues?: MentioningIssue[];
    prs?: MentioningPr[];
    fresh?: Record<number, string[]>;
  };

  /** The issue a first scan of `native` files, numbered and labelled. */
  async function filed(
    number: number,
    native: Candidate[],
    block: Record<string, unknown> = whole,
    overrides: Partial<MentioningIssue> = {},
  ): Promise<MentioningIssue> {
    const { overrides: github, bodies } = gitHub();
    await kindWith(block, { native }).run(unit, ctxFor(github, clock));
    return {
      number,
      title: "",
      body: bodies.get(100)!,
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: routed,
      ...overrides,
    };
  }

  /** Two passes of one process over the same sources and the same GitHub. */
  async function twice(block: Record<string, unknown>, native: Candidate[], held: Held) {
    const kind = kindWith(block, { native });
    const pass = async () => {
      const { overrides, writes, bodies } = gitHub(held.issues, held.prs, {}, held.fresh);
      const logged: string[] = [];
      await kind.run(unit, ctxFor(overrides, clock, logged));
      return { writes, bodies, logged };
    };
    return [await pass(), await pass()] as const;
  }

  test("fixed outside its own PR: closed on the second scan that finds nothing left", async () => {
    const lodash = await filed(40, [direct("lodash")]);
    const [first, second] = await twice(whole, [], { issues: [lodash] });
    expect(first.writes).toEqual([]);
    expect(first.logged).toContain(
      "npm:security:lodash: nothing #40 lists is left to fix; Phoebe closes it if the next scan agrees.",
    );
    expect(second.writes).toEqual(["update #40", "comment #40", "close #40 completed"]);
    // The reason is in the body too, so a comment that fails to post loses nothing.
    expect(second.bodies.get(40)).toMatch(
      /^Security advisories in `lodash` under `npm`\.\n\nNothing this issue listed is left/,
    );
    expect(second.bodies.get(40)).toContain("- `lodash`: the scan no longer reports it.");
    expect(readIssueRows(second.bodies.get(40)!)).toEqual([]);
    expect(parseMarker(second.bodies.get(40)!)?.key).toBe("npm:security:lodash");
    expect(second.logged).toContain(
      "npm:security:lodash: closed #40; nothing it listed is left to fix.",
    );
  });

  test("one whose body was emptied but never closed is closed by the next scan, whatever the sources", async () => {
    const lodash = await filed(40, [direct("lodash")]);
    const [, second] = await twice(whole, [], { issues: [lodash] });
    // The body was saved, then the comment or the close failed.
    const halfClosed: MentioningIssue = { ...lodash, body: second.bodies.get(40)! };
    const [first] = await twice({}, [], { issues: [halfClosed] });
    expect(first.writes).toEqual(["close #40 completed"]);
  });

  test("a scan that answers in part, or fails, between two that agree starts the count again", async () => {
    const lodash = await filed(40, [direct("lodash")]);
    const answers: Partial<Record<SourceName, Candidate[]>> = { native: [], agent: [] };
    const kind = kindWith({}, answers);
    const pass = async () => {
      const { overrides, writes } = gitHub([lodash]);
      await kind.run(unit, ctxFor(overrides, clock)).catch(() => {});
      return writes;
    };
    const closes = ["update #40", "comment #40", "close #40 completed"];

    expect(await pass()).toEqual([]);
    delete answers.agent;
    expect(await pass()).toEqual([]);
    answers.agent = [];
    expect(await pass()).toEqual([]);
    expect(await pass()).toEqual(closes);

    // The stub still lists #40 open, so the count starts over. A scan where
    // every source fails throws before it retires anything.
    expect(await pass()).toEqual([]);
    delete answers.native;
    delete answers.agent;
    expect(await pass()).toEqual([]);
    answers.native = [];
    answers.agent = [];
    expect(await pass()).toEqual([]);
    expect(await pass()).toEqual(closes);
  });

  test("its slot in the cap is free on the scan that closes it", async () => {
    const lodash = await filed(40, [direct("lodash")]);
    const block = { ...whole, prConcurrentLimit: 1 };
    const [first, second] = await twice(block, [direct("zod")], { issues: [lodash] });
    expect(first.writes).toEqual([]);
    expect(second.writes.filter((w) => !w.startsWith("label"))).toEqual([
      "update #40",
      "comment #40",
      "close #40 completed",
      "create #100 Security advisories in zod (npm)",
    ]);
  });

  test("a closed issue holds none of its rows back, so a row that returns is filed again", async () => {
    const lodash = await filed(40, [direct("lodash")]);
    const [, second] = await twice(whole, [], { issues: [lodash] });
    const closed: MentioningIssue = {
      ...lodash,
      body: second.bodies.get(40)!,
      state: "closed",
      stateReason: "completed",
    };
    const [again] = await twice(whole, [direct("lodash")], { issues: [closed] });
    expect(again.writes.filter((w) => w.startsWith("create"))).toEqual([
      "create #100 Security advisories in lodash (npm)",
    ]);
  });

  test("a scan with a failed source closes nothing, however many times it runs", async () => {
    const lodash = await filed(40, [direct("lodash")]);
    const [first, second] = await twice({}, [], { issues: [lodash] });
    expect([...first.writes, ...second.writes]).toEqual([]);
    expect(second.logged).toContain(
      "1 open issue(s) may have nothing left to fix, but a source failed or answered in part " +
        "this scan, so Phoebe leaves them as they are.",
    );
  });

  test("under the threshold now: closed as not planned", async () => {
    const dev = direct("vitest", { depType: "dev" });
    const vitest = await filed(40, [dev], { ...whole, minSeverity: { dev: "high" } });
    const [first, second] = await twice(whole, [dev], { issues: [vitest] });
    expect(first.writes).toEqual([]);
    expect(second.writes).toEqual(["update #40", "comment #40", "close #40 not planned"]);
  });

  test("only a row nobody can act on is left: closed as not planned", async () => {
    const individual = { ...whole, transitive: "individual" };
    const tar = await filed(40, [transitive("tar")], individual);
    const unfixed = candidate("tar", [{ id: "GHSA-tar-2", severity: "high", fixedIn: null }], {
      via: ["expo"],
    });
    const [, second] = await twice(individual, [unfixed], { issues: [tar] });
    expect(second.writes).toEqual(["update #40", "comment #40", "close #40 not planned"]);
  });

  test("a run or a PR in flight keeps the issue open", async () => {
    const claimed = await filed(40, [direct("lodash")], whole, {
      labels: [...routed, "processing"],
    });
    const [, second] = await twice(whole, [], { issues: [claimed] });
    expect(second.writes).toEqual([]);

    const lodash = await filed(41, [direct("lodash")]);
    const pr = (body: string): MentioningPr => ({
      number: 42,
      title: "",
      body,
      state: "open",
      merged: false,
      closedAt: null,
    });
    const marker = lodash.body.trim().split("\n").at(-1)!;
    for (const body of [`Bumps lodash.\n\n${marker}`, "Closes #41"]) {
      const [, again] = await twice(whole, [], { issues: [lodash], prs: [pr(body)] });
      expect(again.writes).toEqual([]);
    }
  });

  test("an issue a run claimed after the scan listed it is left for that run", async () => {
    const lodash = await filed(40, [direct("lodash")]);
    const [, second] = await twice(whole, [], {
      issues: [lodash],
      fresh: { 40: [...routed, "processing"] },
    });
    expect(second.writes).toEqual([]);
    expect(second.logged).toContain(
      "npm:security:lodash: #40 was claimed during the scan; left for its run.",
    );
  });

  test("an unrouted tracking issue is left open", async () => {
    const tracking = await filed(
      40,
      [candidate("lodash", [{ id: "GHSA-lodash", severity: "high", fixedIn: null }])],
      whole,
      { labels: ["dependencies", "security"] },
    );
    const [, second] = await twice(whole, [], { issues: [tracking] });
    expect(second.writes).toEqual([]);
  });

  test("a per-package issue whose row the bundle now plans keeps it, and the bundle holds it back", async () => {
    const tar = await filed(40, [transitive("tar")], { ...whole, transitive: "individual" });
    const [, second] = await twice(whole, [transitive("tar")], { issues: [tar] });
    expect(second.writes).toEqual([]);
    expect(second.logged).toContain(
      "npm:security-transitive: held back tar@1.0.1 (already proposed in #40).",
    );
  });

  // Filing holds a row by package, workspace and target. An issue that lists
  // the package in another workspace holds nothing, so it must not be kept.
  test("a per-package issue for another workspace than the bundle's row is retired", async () => {
    const tar = await filed(40, [transitive("tar", { workspace: "apps/a/package.json" })], {
      ...whole,
      transitive: "individual",
    });
    const elsewhere = [transitive("tar", { workspace: "apps/b/package.json" })];
    const [first, second] = await twice(whole, elsewhere, { issues: [tar] });
    expect(first.writes.filter((w) => w.startsWith("create"))).toEqual([
      "create #100 Security fixes for transitive packages (npm)",
    ]);
    expect(first.writes.filter((w) => w.includes("#40"))).toEqual([]);
    expect(second.writes.filter((w) => w.includes("#40"))).toEqual([
      "update #40",
      "comment #40",
      "close #40 completed",
    ]);
  });

  describe('a bundle left open across a switch to `transitive: "individual"`', () => {
    const native = [transitive("tar"), transitive("ws")];

    test("is closed on the first scan, and its rows are filed per package on that scan", async () => {
      const bundle = await filed(40, native);
      // A failed source changes nothing here: the mode is the tenant's own setting.
      const [first] = await twice({ transitive: "individual" }, native, { issues: [bundle] });
      expect(first.writes.filter((w) => !w.startsWith("label"))).toEqual([
        "update #40",
        "comment #40",
        "close #40 not planned",
        "create #100 Security advisories in tar (npm)",
        "create #101 Security advisories in ws (npm)",
      ]);
      expect(first.bodies.get(40)).toContain('`transitive: "individual"`');
      expect(readIssueRows(first.bodies.get(40)!)).toEqual([]);
    });

    test("parked under phoebe:blocked, it is closed the same way", async () => {
      const parked = await filed(40, native, whole, { labels: [...routed, "phoebe:blocked"] });
      const [first] = await twice({ transitive: "individual" }, native, { issues: [parked] });
      expect(first.writes.slice(0, 3)).toEqual([
        "update #40",
        "comment #40",
        "close #40 not planned",
      ]);
    });

    test("with its PR still open it stays, and holds the rows the PR is fixing", async () => {
      const bundle = await filed(40, native, whole, { labels: [...routed, "processing"] });
      const pr: MentioningPr = {
        number: 41,
        title: "",
        body: "Closes #40",
        state: "open",
        merged: false,
        closedAt: null,
      };
      const [first, second] = await twice({ transitive: "individual" }, native, {
        issues: [bundle],
        prs: [pr],
      });
      expect([...first.writes, ...second.writes]).toEqual([]);
    });
  });
});

describe("a not-affected verdict", () => {
  const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };
  const high = { id: "GHSA-high", severity: "high", fixedIn: "1.0.3" } as const;
  const critical = { id: "GHSA-crit", severity: "critical", fixedIn: "1.0.4" } as const;
  const verdict = "## Verdict\n\nNot affected.\n\n<!-- phoebe-verdict not-affected -->";
  const blocked = "\n<!-- phoebe-blocked -->";
  const parkedLabels = ["dependencies", "security", "phoebe:dependencies", "phoebe:blocked"];

  async function scan(
    native: Candidate[],
    held: { issues?: MentioningIssue[]; comments?: Record<number, Comment[]> } = {},
  ) {
    const { overrides, writes, bodies } = gitHub(held.issues, [], held.comments);
    const logged: string[] = [];
    await kindWith({}, { native }).run(
      { ref: SCAN_REF, revision: "0" },
      ctxFor(overrides, clock, logged),
    );
    return { writes, bodies, logged };
  }

  /** The issue a first scan of `native` files, as the implementer's run left it. */
  async function ticket(
    native: Candidate[],
    overrides: Partial<MentioningIssue> = {},
  ): Promise<MentioningIssue> {
    const { bodies } = await scan(native);
    return {
      number: 40,
      title: "",
      body: bodies.get(100)!,
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: parkedLabels,
      ...overrides,
    };
  }

  test("on a ticket of highs: acknowledged, closed as not planned, and unparked", async () => {
    const native = [candidate("tar", [high])];
    const issue = await ticket(native);
    const { writes, logged } = await scan(native, {
      issues: [issue],
      comments: {
        40: [{ body: verdict + blocked }, { body: "⏸️ parked\n\n<!-- phoebe-blocked-ack -->" }],
      },
    });
    expect(writes).toEqual(["comment #40", "close #40 not planned", "unlabel #40 phoebe:blocked"]);
    expect(logged).toContain("#40: not-affected verdict; dismissed it as not planned.");
  });

  test("on a ticket with a critical: left open and parked, the routing label taken off", async () => {
    const native = [candidate("tar", [high, critical])];
    const issue = await ticket(native);
    const { writes } = await scan(native, {
      issues: [issue],
      comments: { 40: [{ body: verdict + blocked }] },
    });
    expect(writes).toEqual(["comment #40", "unlabel #40 phoebe:dependencies"]);
  });

  test("on a high re-rated critical since the ticket was filed: left for a maintainer", async () => {
    const issue = await ticket([candidate("tar", [high])]);
    expect(issue.body).toContain("GHSA-high");
    expect(issue.body).not.toContain("critical, in");
    const rerated = { ...high, severity: "critical" } as const;
    const { writes } = await scan([candidate("tar", [rerated])], {
      issues: [issue],
      comments: { 40: [{ body: verdict + blocked }] },
    });
    expect(writes).toEqual(["comment #40", "unlabel #40 phoebe:dependencies"]);
  });

  test("from any other login it does nothing", async () => {
    const native = [candidate("tar", [high])];
    const issue = await ticket(native);
    const { writes } = await scan(native, {
      issues: [issue],
      comments: { 40: [{ body: verdict + blocked, by: "passer-by" }] },
    });
    expect(writes).toEqual([]);
  });

  test("without the blocked marker it is still acted on", async () => {
    const native = [candidate("tar", [high])];
    const issue = await ticket(native, {
      labels: ["dependencies", "security", "phoebe:dependencies"],
    });
    const { writes } = await scan(native, {
      issues: [issue],
      comments: { 40: [{ body: verdict }] },
    });
    expect(writes).toEqual(["comment #40", "close #40 not planned"]);
  });

  test("a dismissal holds for the same rows and lifts on a new advisory", async () => {
    const native = [candidate("tar", [high])];
    const dismissed = await ticket(native, {
      state: "closed",
      stateReason: "not_planned",
      labels: ["dependencies", "security", "phoebe:dependencies"],
    });
    const comments = {
      40: [{ body: verdict + blocked }, { body: "closed\n\n<!-- phoebe-verdict-ack -->" }],
    };
    expect((await scan(native, { issues: [dismissed], comments })).writes).toEqual([]);

    const another = { id: "GHSA-new", severity: "high", fixedIn: "1.0.3" } as const;
    const { writes } = await scan([candidate("tar", [high, another])], {
      issues: [dismissed],
      comments,
    });
    expect(writes[0]).toBe("create #100 Security advisories in tar (npm)");
  });

  test("a dismissed issue a person reopened is left open for the implementer", async () => {
    const native = [candidate("tar", [high])];
    const reopened = await ticket(native, {
      stateReason: "reopened",
      labels: ["dependencies", "security", "phoebe:dependencies"],
    });
    const { writes } = await scan(native, {
      issues: [reopened],
      comments: {
        40: [{ body: verdict + blocked }, { body: "closed\n\n<!-- phoebe-verdict-ack -->" }],
      },
    });
    expect(writes).toEqual([]);
  });

  test("a verdict on the transitive bundle or on a tracking issue is not read", async () => {
    const bundle = [candidate("tar", [high], { via: ["expo"] })];
    const { bodies } = await scan(bundle);
    const issue: MentioningIssue = {
      number: 40,
      title: "",
      body: bodies.get(100)!,
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: parkedLabels,
    };
    const { writes } = await scan(bundle, {
      issues: [issue],
      comments: { 40: [{ body: verdict + blocked }] },
    });
    expect(writes).toEqual([]);
  });
});
