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

/** A GitHub that holds `issues` and `prs` and records every write. */
function gitHub(issues: MentioningIssue[] = [], prs: MentioningPr[] = []) {
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
    expect(() => dependencySecurityKind(config, { prConcurrentLimit: 1 })).toThrow(
      "kinds.dependency-security: unknown option `prConcurrentLimit`",
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
      "4 candidate(s): 1 with advisories under high left to dependency-updates; " +
        "1 package(s) with a fix, 1 awaiting one.",
    );
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

  test("a closed tracking issue vetoes its fingerprint; a fix lifts the veto", async () => {
    const first = gitHub();
    await kindWith({}, { native: [candidate("pkg", [unfixed])] }).run(
      { ref: SCAN_REF, revision: "0" },
      ctxFor(first.overrides, clock),
    );
    const closed: MentioningIssue = {
      number: 100,
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

  test("files every routed issue however many dependency issues are open", async () => {
    const open: MentioningIssue[] = Array.from({ length: 8 }, (_, i) => ({
      number: i + 1,
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
});
